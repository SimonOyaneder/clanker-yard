import { randomBytes } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** Un ticket vale un minuto y entrega una vez el usuario y una vez la contraseña. */
export const TICKET_TTL_MS = 60_000;

const SOCKET_ENV = "CLANKER_ASKPASS_SOCKET";
const TICKET_ENV = "CLANKER_ASKPASS_TICKET";

export interface GitCredentials {
  username: string;
  password: string;
}

export interface AskpassSession {
  /** Para el proceso git: `GIT_ASKPASS`, `GIT_TERMINAL_PROMPT=0` y el ticket. Nunca lleva el token. */
  env: Record<string, string>;
  /** Anula el ticket; llamar cuando git termina, haya leído sus dos valores o no. */
  revoke(): void;
}

/**
 * Entrega credenciales a `git` sin ponerlas en su entorno, donde las verían los hooks del repo.
 * El core abre un socket unix privado; `GIT_ASKPASS` apunta a un script que le cambia al core un
 * ticket de un solo uso por el valor que git pidió. Un ticket vencido, agotado o desconocido no
 * entrega nada, y tampoco uno cuyo prompt nombra otro origen: un `url.<x>.insteadOf` en el config del
 * repo no puede mandar el token a otro host.
 */
export interface Askpass {
  /** El ticket solo contesta a prompts de git para el origen de `url` (protocolo, host y puerto). */
  issue(credentials: GitCredentials, url: string): Promise<AskpassSession>;
  /** Cierra el socket y borra el script. */
  close(): Promise<void>;
}

export interface AskpassOptions {
  now?: () => number;
}

type Kind = keyof GitCredentials;

interface Ticket {
  credentials: GitCredentials;
  origin: string;
  expiresAt: number;
  /** Cada valor sale una vez: un hook que corre después de que git leyó la contraseña no la obtiene. */
  read: Set<Kind>;
}

type Reply = { value: string } | { error: string };

/** El script de `GIT_ASKPASS`. Va como texto: el core se empaqueta y no hay un archivo suelto que apuntar. */
const SCRIPT = `const net = require("node:net");
const socket = net.connect(process.env.${SOCKET_ENV});
let reply = "";
function fail(message) {
  process.stderr.write("clanker askpass: " + message + "\\n");
  process.exit(1);
}
socket.setEncoding("utf8");
socket.on("data", (chunk) => (reply += chunk));
socket.on("error", (error) => fail(error.message));
socket.on("end", () => {
  let parsed;
  try {
    parsed = JSON.parse(reply);
  } catch {
    return fail("respuesta inválida del core");
  }
  if (typeof parsed.value !== "string") return fail(parsed.error);
  process.stdout.write(parsed.value + "\\n");
});
socket.write(JSON.stringify({ ticket: process.env.${TICKET_ENV}, prompt: process.argv[2] ?? "" }) + "\\n");
`;

export function createAskpass({ now = Date.now }: AskpassOptions = {}): Askpass {
  const tickets = new Map<string, Ticket>();
  let started: Promise<{ dir: string; server: Server; command: string }> | undefined;

  function redeem(ticketId: unknown, prompt: unknown): Reply {
    const ticket = typeof ticketId === "string" ? tickets.get(ticketId) : undefined;
    const asked = typeof prompt === "string" ? parsePrompt(prompt) : undefined;
    if (!asked) return { error: "git pidió algo que no es usuario ni contraseña" };
    if (!ticket || ticket.expiresAt <= now() || ticket.read.has(asked.kind)) {
      return { error: "el ticket venció, ya se usó o no existe" };
    }
    if (asked.origin !== ticket.origin) {
      return { error: `git pidió credenciales para ${asked.origin} y el ticket es para ${ticket.origin}` };
    }
    ticket.read.add(asked.kind);
    return { value: ticket.credentials[asked.kind] };
  }

  async function start() {
    // Un directorio 0700 propio: el socket solo lo abre este usuario.
    const dir = await mkdtemp(join(tmpdir(), "clanker-askpass-"));
    const socketPath = join(dir, "s");
    const server = createServer((connection) => {
      let request = "";
      connection.setEncoding("utf8");
      connection.on("error", () => connection.destroy());
      connection.on("data", (chunk: string) => {
        request += chunk;
        const end = request.indexOf("\n");
        if (end === -1) return;
        let reply: Reply;
        try {
          const { ticket, prompt } = JSON.parse(request.slice(0, end)) as { ticket?: unknown; prompt?: unknown };
          reply = redeem(ticket, prompt);
        } catch {
          reply = { error: "solicitud inválida" };
        }
        connection.end(JSON.stringify(reply));
      });
    });
    try {
      await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(socketPath, resolve);
      });
      const script = join(dir, "askpass.cjs");
      const command = join(dir, "askpass.sh");
      await writeFile(script, SCRIPT);
      // `ELECTRON_RUN_AS_NODE`: dentro de la app, `execPath` es Electron y no node.
      await writeFile(
        command,
        `#!/bin/sh\nELECTRON_RUN_AS_NODE=1 ${SOCKET_ENV}=${shellQuote(socketPath)} exec ${shellQuote(process.execPath)} ${shellQuote(script)} "$@"\n`,
        { mode: 0o700 },
      );
      return { dir, server, command };
    } catch (error) {
      server.close();
      await rm(dir, { recursive: true, force: true });
      throw error;
    }
  }

  return {
    async issue(credentials, url) {
      started ??= start();
      const { command } = await started;
      const t = now();
      for (const [id, ticket] of tickets) if (ticket.expiresAt <= t) tickets.delete(id);
      const id = randomBytes(32).toString("base64url");
      tickets.set(id, { credentials, origin: new URL(url).origin, expiresAt: t + TICKET_TTL_MS, read: new Set() });
      return {
        env: { GIT_ASKPASS: command, GIT_TERMINAL_PROMPT: "0", [TICKET_ENV]: id },
        revoke: () => void tickets.delete(id),
      };
    },
    async close() {
      tickets.clear();
      if (!started) return;
      const { dir, server } = await started;
      started = undefined;
      server.close();
      await rm(dir, { recursive: true, force: true });
    },
  };
}

/** `Username for 'https://github.com': ` o `Password for 'https://simon@github.com': `, como los arma git. */
function parsePrompt(prompt: string): { kind: Kind; origin: string } | undefined {
  const match = /^(Username|Password) for '([^']+)'/.exec(prompt);
  if (!match) return undefined;
  try {
    return { kind: match[1] === "Username" ? "username" : "password", origin: new URL(match[2]!).origin };
  } catch {
    return undefined;
  }
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

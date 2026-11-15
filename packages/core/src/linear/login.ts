import { randomBytes } from "node:crypto";
import { createServer, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import {
  authorizeUrl,
  createPkce,
  exchangeCode,
  LinearAuthError,
  type LinearEndpoints,
  type LinearTokens,
} from "./oauth";

export const CALLBACK_PATH = "/oauth/linear/callback";

export interface LinearLoginOptions {
  endpoints: LinearEndpoints;
  clientId: string;
  /** Linear compara el redirect URI exacto, así que en producción el puerto es fijo; 0 elige uno libre. */
  port: number;
  timeoutMs: number;
  now: () => number;
}

export interface LoopbackLogin<T> {
  /** Lo que el usuario abre en el navegador. */
  url: string;
  /** El resultado de `finish`, o `LinearAuthError` si el usuario no aprobó, venció el plazo o se canceló. */
  done: Promise<T>;
  /** Aborta el login y espera a que el puerto quede libre. No hace nada si ya terminó. */
  cancel(reason: string): Promise<void>;
}

/**
 * OAuth con PKCE contra un loopback: levanta un servidor en 127.0.0.1 que recibe el redirect de Linear,
 * cambia el código por tokens y se los pasa a `finish`. El servidor vive solo hasta que el login
 * termina (éxito, rechazo, plazo o `cancel`). Nada aquí lanza dentro de un callback: todo fallo
 * termina en el rechazo de `done`.
 */
export async function startLinearLogin<T>(
  options: LinearLoginOptions,
  finish: (tokens: LinearTokens) => Promise<T>,
): Promise<LoopbackLogin<T>> {
  const { verifier, challenge } = createPkce();
  const state = randomBytes(16).toString("base64url");
  let redirectUri = "";
  let codeReceived = false;
  let settled = false;
  let resolveDone!: (value: T) => void;
  let rejectDone!: (error: unknown) => void;
  const done = new Promise<T>((resolve, reject) => {
    resolveDone = resolve;
    rejectDone = reject;
  });

  const server = createServer((req, res) => {
    void handle(req.url ?? "/", req.headers.host, res);
  });

  async function handle(rawUrl: string, host: string | undefined, res: ServerResponse) {
    // Contra DNS rebinding: una página ajena que apunte su dominio a 127.0.0.1 manda otro Host.
    if (host !== new URL(redirectUri).host) return reply(res, 403, "Host no permitido.");
    const url = new URL(rawUrl, redirectUri);
    if (url.pathname !== CALLBACK_PATH) return reply(res, 404, "No encontrado.");
    // Un state ajeno no es el redirect de Linear: se ignora y el login sigue esperando el verdadero.
    if (url.searchParams.get("state") !== state) return reply(res, 400, "State inválido.");
    if (codeReceived) return reply(res, 409, "Este login ya recibió su respuesta.");
    codeReceived = true;

    const denied = url.searchParams.get("error");
    const code = url.searchParams.get("code");
    try {
      if (denied !== null || code === null) {
        throw new LinearAuthError(
          `Linear no autorizó la conexión (${denied ?? "sin código"}). Vuelve a intentarlo desde Clanker Yard.`,
        );
      }
      const tokens = await exchangeCode(
        options.endpoints,
        { clientId: options.clientId, code, verifier, redirectUri },
        options.now(),
      );
      // Si venció el plazo o se canceló mientras se cambiaba el código, no se conecta nada.
      if (settled) throw new LinearAuthError("El login de Linear ya terminó: vuelve a intentarlo.");
      const result = await finish(tokens);
      reply(res, 200, "Linear quedó conectado. Puedes cerrar esta pestaña y volver a Clanker Yard.");
      succeed(result);
    } catch (error) {
      reply(res, 400, `No se pudo conectar Linear: ${error instanceof Error ? error.message : String(error)}`);
      fail(error);
    }
  }

  function settle(): boolean {
    if (settled) return false;
    settled = true;
    clearTimeout(timer);
    return true;
  }
  const closed = () =>
    new Promise<void>((resolve) => {
      // Sin closeAllConnections: la respuesta a la pestaña del usuario todavía puede estar saliendo.
      server.close(() => resolve());
    });
  function succeed(value: T) {
    if (settle()) {
      resolveDone(value);
      void closed();
    }
  }
  function fail(error: unknown) {
    if (settle()) {
      rejectDone(error);
      void closed();
    }
  }

  const timer = setTimeout(
    () => fail(new LinearAuthError("La conexión con Linear no se completó a tiempo: vuelve a intentarlo.")),
    options.timeoutMs,
  );
  timer.unref();

  try {
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(options.port, "127.0.0.1", resolve);
    });
  } catch (error) {
    clearTimeout(timer);
    throw new LinearAuthError(
      `No se pudo escuchar en 127.0.0.1:${options.port} para el redirect de Linear: ${
        error instanceof Error ? error.message : String(error)
      }. Cierra lo que use ese puerto o cambia el puerto del redirect.`,
    );
  }
  redirectUri = `http://127.0.0.1:${(server.address() as AddressInfo).port}${CALLBACK_PATH}`;

  return {
    url: authorizeUrl(options.endpoints, { clientId: options.clientId, redirectUri, state, challenge }),
    done,
    async cancel(reason) {
      if (settle()) {
        rejectDone(new LinearAuthError(reason));
        await closed();
      }
    },
  };
}

function reply(res: ServerResponse, status: number, message: string) {
  res.writeHead(status, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
  res.end(`<!doctype html><meta charset="utf-8"><title>Clanker Yard</title><p>${escapeHtml(message)}</p>`);
}

function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}

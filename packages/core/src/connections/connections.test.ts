import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import type { QueryFn } from "../agents/claude/claude-runtime";
import type { ExecFn } from "../agents/claude/probe";
import { createFileSecrets } from "../secrets/encrypted-file";
import type { Secrets } from "../secrets/secrets";
import { openStore, type Store } from "../store/store";
import { ClaudeSetupError, createConnections, type ConnectInput, type Connections } from "./connections";
import { UiOnlyError } from "../errors/domain";

/** Fijo: los vencimientos de los tests no deben depender del reloj real. */
const NOW = 1_700_000_000_000;
const TOKEN = "ghp_UNIQUE-secret-token-0123456789";
const github: Omit<ConnectInput, "token" | "expiresAt"> = {
  provider: "github",
  account: "simon",
  scopes: ["contents", "pull_requests"],
};

let dir: string;
let store: Store;
let secrets: Secrets;
let connections: Connections;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "clanker-connections-"));
  store = openStore({ path: join(dir, "clanker.db") });
  secrets = createFileSecrets({ dir: join(dir, "secrets") });
  connections = createConnections({ store, secrets, now: () => NOW });
});

afterEach(() => {
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

describe("connect", () => {
  test("la cuenta aparece en list sin el token, y el core puede leer el token", async () => {
    const connection = await connections.connect(
      { ...github, token: TOKEN, expiresAt: 1_800_000_000_000 },
      "ui",
    );

    expect(connection).toEqual({ ...github, status: "active", expiresAt: 1_800_000_000_000, auth: "pat" });
    expect(connections.list()).toEqual([connection]);
    expect(await connections.token("github", "simon")).toBe(TOKEN);
  });

  test("sin expiresAt la cuenta no lo trae", async () => {
    await connections.connect({ ...github, token: TOKEN }, "ui");
    expect(connections.list()[0]).not.toHaveProperty("expiresAt");
  });

  test("conectar de nuevo la misma cuenta reemplaza token, scopes y vencimiento", async () => {
    await connections.connect({ ...github, token: TOKEN, expiresAt: 1 }, "ui");
    await connections.connect({ ...github, scopes: ["contents"], token: "ghp_nuevo" }, "cli");

    expect(connections.list()).toEqual([
      { provider: "github", account: "simon", scopes: ["contents"], status: "active", auth: "pat" },
    ]);
    expect(await connections.token("github", "simon")).toBe("ghp_nuevo");
  });

  test("list ordena por cuenta, y dos cuentas del mismo proveedor conviven", async () => {
    await connections.connect({ ...github, account: "zeta", token: "ghp_zeta" }, "ui");
    await connections.connect({ ...github, account: "otra", token: "ghp_otra" }, "ui");
    await connections.connect({ ...github, token: TOKEN }, "ui");

    expect(connections.list().map((c) => `${c.provider}/${c.account}`)).toEqual([
      "github/otra",
      "github/simon",
      "github/zeta",
    ]);
    expect(await connections.token("github", "otra")).toBe("ghp_otra");
    expect(await connections.token("github", "simon")).toBe(TOKEN);
  });

  test("rechaza una cuenta o un token vacíos sin guardar nada", async () => {
    await expect(connections.connect({ ...github, account: "", token: TOKEN }, "ui")).rejects.toThrow(/no vacíos/);
    await expect(connections.connect({ ...github, token: "" }, "ui")).rejects.toThrow(/no vacíos/);
    expect(connections.list()).toEqual([]);
    expect(store.events.since(0)).toEqual([]);
  });

  test("si el almacén de secretos falla no queda ni la cuenta ni el evento", async () => {
    const broken: Secrets = { ...secrets, set: () => Promise.reject(new Error("llavero bloqueado")) };
    await expect(createConnections({ store, secrets: broken }).connect({ ...github, token: TOKEN }, "ui")).rejects.toThrow(
      "llavero bloqueado",
    );
    expect(connections.list()).toEqual([]);
    expect(store.events.since(0)).toEqual([]);
  });
});

describe("disconnect", () => {
  test("borra la cuenta y el token", async () => {
    await connections.connect({ ...github, token: TOKEN }, "ui");
    await connections.disconnect("github", "simon", "ui");

    expect(connections.list()).toEqual([]);
    expect(await secrets.get("connection:github:simon")).toBeUndefined();
    await expect(connections.token("github", "simon")).rejects.toThrow(/conéctala primero/);
  });

  test("desconectar una cuenta que no existe no hace nada ni emite", async () => {
    await connections.disconnect("github", "nadie", "ui");
    expect(store.events.since(0)).toEqual([]);
  });

  test("si borrar el token falla la cuenta sigue a la vista para reintentar", async () => {
    await connections.connect({ ...github, token: TOKEN }, "ui");
    const broken: Secrets = { ...secrets, delete: () => Promise.reject(new Error("llavero bloqueado")) };

    await expect(createConnections({ store, secrets: broken }).disconnect("github", "simon", "ui")).rejects.toThrow(
      "llavero bloqueado",
    );
    expect(connections.list()).toHaveLength(1);
  });
});

describe("markRevoked", () => {
  test("deja la cuenta revocada y emite connection.changed una sola vez", async () => {
    await connections.connect({ ...github, token: TOKEN }, "ui");

    connections.markRevoked("github", "simon", "core");
    connections.markRevoked("github", "simon", "core");

    expect(connections.list()[0]?.status).toBe("revoked");
    expect(store.events.since(0).filter((e) => e.payload.status === "revoked")).toHaveLength(1);
  });

  test("conectar de nuevo la deja activa", async () => {
    await connections.connect({ ...github, token: TOKEN }, "ui");
    connections.markRevoked("github", "simon", "core");

    await connections.connect({ ...github, token: `${TOKEN}-nuevo` }, "ui");

    expect(connections.list()[0]?.status).toBe("active");
  });

  test("una cuenta que no existe no hace nada", () => {
    connections.markRevoked("github", "nadie", "core");

    expect(store.events.since(0)).toEqual([]);
  });
});

describe("token", () => {
  test("si la cuenta existe pero falta su secreto, dice cómo repararlo", async () => {
    await connections.connect({ ...github, token: TOKEN }, "ui");
    await secrets.delete("connection:github:simon");

    await expect(connections.token("github", "simon")).rejects.toThrow(/desconecta la cuenta y vuelve a conectarla/);
  });
});

describe("connection.changed", () => {
  test("se emite al conectar y al desconectar, con el origen de la llamada", async () => {
    await connections.connect({ ...github, token: TOKEN }, "cli");
    await connections.disconnect("github", "simon", "ui");

    expect(store.events.since(0).map((e) => [e.type, e.origin, e.payload])).toEqual([
      ["connection.changed", "cli", { provider: "github", account: "simon", status: "active" }],
      ["connection.changed", "ui", { provider: "github", account: "simon", status: "disconnected" }],
    ]);
  });

  test("pegar un token, una API key o desconectar es de la app: otro origin es UiOnlyError y no cambia nada", async () => {
    await connections.connect({ ...github, token: TOKEN }, "ui");

    await expect(connections.disconnect("github", "simon", "mcp")).rejects.toThrow(UiOnlyError);
    await expect(connections.setPat(TOKEN, "cli")).rejects.toThrow(UiOnlyError);
    await expect(connections.setClaudeApiKey("sk-ant-x", "cli")).rejects.toThrow(UiOnlyError);
    expect(connections.list()).toMatchObject([{ provider: "github", account: "simon" }]);
  });
});

describe("sin secretos fuera del almacén", () => {
  test("el valor del token no está en la base, ni en sus archivos WAL, ni en los eventos, ni en list", async () => {
    await connections.connect({ ...github, token: TOKEN, expiresAt: 5 }, "ui");
    await connections.connect({ ...github, token: `${TOKEN}-rotado` }, "ui");

    // Con la base todavía abierta: el contenido puede estar en el WAL.
    const dbFiles = readdirSync(dir).filter((f) => f.startsWith("clanker.db"));
    expect(dbFiles).toContain("clanker.db");
    for (const file of dbFiles) {
      const bytes = readFileSync(join(dir, file)).toString("latin1");
      expect(bytes, file).not.toContain("UNIQUE-secret-token");
    }
    expect(JSON.stringify(store.events.since(0))).not.toContain("UNIQUE-secret-token");
    expect(JSON.stringify(connections.list())).not.toContain("UNIQUE-secret-token");
  });

  test("la base guarda la ref del secreto, no el valor", async () => {
    await connections.connect({ ...github, token: TOKEN }, "ui");
    const row = store.db.$client.prepare("SELECT secret_ref FROM connections").get();
    expect(row).toEqual({ secret_ref: "connection:github:simon" });
  });
});

describe("claude", () => {
  const KEY = "sk-ant-UNIQUE-key-0123456789";
  const msg = (m: Record<string, unknown>) => ({ session_id: "s", ...m }) as unknown as SDKMessage;
  const init = (apiKeySource = "none") => msg({ type: "system", subtype: "init", apiKeySource, claude_code_version: "2.1.325" });
  const pong = msg({ type: "result", subtype: "success", is_error: false, result: "pong" });
  const authFailed = [
    msg({ type: "assistant", error: "authentication_failed", message: { id: "m", content: [], usage: {} } }),
    msg({ type: "result", subtype: "success", is_error: true, result: "Failed to authenticate" }),
  ];
  const quotaOut = [
    msg({ type: "rate_limit_event", rate_limit_info: { status: "rejected", rateLimitType: "seven_day", utilization: 1 } }),
    msg({ type: "result", subtype: "success", is_error: true, result: "You've hit your weekly limit" }),
  ];

  /** Un `claude` presente (o no) y lo que responde cada llamada de prueba, en orden. */
  function withClaude(opts: { installed?: boolean; loggedIn?: boolean; replies: SDKMessage[][] }) {
    const exec: ExecFn = async (_file, args) =>
      args[0] === "--version"
        ? "2.1.325 (Claude Code)"
        : JSON.stringify({ loggedIn: opts.loggedIn ?? true, subscriptionType: "team" });
    const envs: Record<string, string>[] = [];
    const replies = [...opts.replies];
    const query: QueryFn = ({ options }) => {
      envs.push(options.env as Record<string, string>);
      const reply = replies.shift() ?? [init(), pong];
      return (async function* () {
        for (const m of reply) {
          yield m;
          if (m.type === "result" && m.is_error) throw new Error("Claude Code returned an error result");
        }
      })();
    };
    const baseEnv = { PATH: opts.installed === false ? join(dir, "vacio") : join(dir, "bin"), HOME: dir, USER: "x" };
    if (opts.installed !== false) {
      mkdirSync(join(dir, "bin"), { recursive: true });
      writeFileSync(join(dir, "bin", "claude"), "#!/bin/sh\n", { mode: 0o755 });
    }
    return { envs, claude: { baseEnv, query, exec } };
  }

  function connectionsWith(stubs: ReturnType<typeof withClaude>) {
    return createConnections({ store, secrets, now: () => NOW, claude: stubs.claude });
  }

  test("probar con claude instalado y logueado conecta la suscripción, sin guardar ningún secreto", async () => {
    const claude = connectionsWith(withClaude({ replies: [] }));

    const status = await claude.testClaude(undefined, "ui");

    expect(status).toMatchObject({ mode: "subscription", state: "ready", plan: "team" });
    expect(claude.list()).toEqual([
      { provider: "claude", account: "subscription", scopes: ["plan:team"], status: "active" },
    ]);
    expect(store.events.since(0).map((e) => [e.origin, e.payload])).toEqual([
      ["ui", { provider: "claude", account: "subscription", status: "active" }],
    ]);
    expect(store.db.$client.prepare("SELECT secret_ref FROM connections").get()).toEqual({ secret_ref: "" });
    expect(await claude.claudeCredentials()).toMatchObject({ mode: "subscription" });
    await expect(claude.token("claude", "subscription")).rejects.toThrow(/no guarda ningún token/);
  });

  test("sin claude instalado la respuesta lo dice y no queda ninguna cuenta", async () => {
    const claude = connectionsWith(withClaude({ installed: false, replies: [] }));

    const status = await claude.testClaude(undefined, "ui");

    expect(status.state).toBe("not_installed");
    expect(claude.list()).toEqual([]);
    expect(store.events.since(0)).toEqual([]);
  });

  test("sin sesión iniciada no se crea la cuenta; si ya estaba conectada pasa a expired", async () => {
    const connected = connectionsWith(withClaude({ replies: [] }));
    await connected.testClaude(undefined, "ui");

    const loggedOut = connectionsWith(withClaude({ loggedIn: false, replies: [] }));
    expect((await loggedOut.testClaude(undefined, "ui")).state).toBe("login_required");

    expect(loggedOut.list()).toEqual([
      { provider: "claude", account: "subscription", scopes: ["plan:team"], status: "expired" },
    ]);
    expect(store.events.since(0).at(-1)?.payload).toEqual({
      provider: "claude",
      account: "subscription",
      status: "expired",
    });
  });

  test("el login vencido en plena llamada deja la cuenta expired", async () => {
    const claude = connectionsWith(withClaude({ replies: [[init(), pong], [init(), ...authFailed]] }));
    await claude.testClaude(undefined, "ui");

    expect((await claude.testClaude(undefined, "ui")).state).toBe("login_expired");

    expect(claude.list()[0]?.status).toBe("expired");
  });

  test("con la cuota agotada la cuenta sigue activa y la respuesta lo dice", async () => {
    const claude = connectionsWith(withClaude({ replies: [[init(), ...quotaOut]] }));

    const status = await claude.testClaude(undefined, "ui");

    expect(status.state).toBe("quota_exhausted");
    expect(claude.list()[0]?.status).toBe("active");
  });

  test("un run real con el login vencido deja la suscripción expired, o la API key revoked, sin llamar a Claude", async () => {
    const stubs = withClaude({ replies: [[init(), pong], [init("ANTHROPIC_API_KEY"), pong]] });
    const claude = connectionsWith(stubs);
    claude.markClaudeLoginLost("core");
    expect(claude.list()).toEqual([]);

    await claude.testClaude("subscription", "ui");
    claude.markClaudeLoginLost("core");
    expect(claude.list()).toMatchObject([{ account: "subscription", status: "expired" }]);
    expect(store.events.since(0).at(-1)).toMatchObject({ origin: "core", payload: { provider: "claude", account: "subscription", status: "expired" } });

    await claude.setClaudeApiKey(KEY, "ui");
    claude.markClaudeLoginLost("core");
    expect(claude.list()).toMatchObject([{ account: "api-key", status: "revoked" }, { account: "subscription", status: "expired" }]);
    expect(stubs.envs).toHaveLength(2);
  });

  test("la API key se guarda en Secrets, queda activa y los runs la usan en vez de la suscripción", async () => {
    const stubs = withClaude({ replies: [[init("ANTHROPIC_API_KEY"), pong]] });
    const claude = connectionsWith(stubs);

    const connection = await claude.setClaudeApiKey(KEY, "ui");

    expect(connection).toEqual({ provider: "claude", account: "api-key", scopes: [], status: "active" });
    expect(stubs.envs[0]?.ANTHROPIC_API_KEY).toBe(KEY);
    expect(await secrets.get("connection:claude:api-key")).toBe(KEY);
    const credentials = await claude.claudeCredentials();
    expect(credentials.mode).toBe("api-key");
    expect(credentials.env()).toEqual({ ANTHROPIC_API_KEY: KEY });
    expect(JSON.stringify(claude.list())).not.toContain(KEY);
    expect(JSON.stringify(store.events.since(0))).not.toContain(KEY);
    for (const file of readdirSync(dir).filter((f) => f.startsWith("clanker.db"))) {
      expect(readFileSync(join(dir, file)).toString("latin1"), file).not.toContain(KEY);
    }
  });

  test("una API key que Anthropic rechaza no se guarda", async () => {
    const claude = connectionsWith(
      withClaude({ replies: [[init("ANTHROPIC_API_KEY"), ...authFailed]] }),
    );

    await expect(claude.setClaudeApiKey(KEY, "ui")).rejects.toThrow(ClaudeSetupError);

    expect(claude.list()).toEqual([]);
    expect(await secrets.get("connection:claude:api-key")).toBeUndefined();
  });

  test("probar sin mode usa la API key si hay una, y si Anthropic la rechaza después queda revoked", async () => {
    const claude = connectionsWith(
      withClaude({
        replies: [[init("ANTHROPIC_API_KEY"), pong], [init("ANTHROPIC_API_KEY"), ...authFailed]],
      }),
    );
    await claude.setClaudeApiKey(KEY, "ui");

    const status = await claude.testClaude(undefined, "ui");

    expect(status).toMatchObject({ mode: "api-key", state: "key_rejected" });
    expect(claude.list()[0]).toMatchObject({ account: "api-key", status: "revoked" });
    // Revocada o no, los runs siguen usando la key y fallan con su mensaje: no se pasan a la suscripción en silencio.
    expect((await claude.claudeCredentials()).mode).toBe("api-key");
  });

  test("probar la suscripción con una API key guardada no la toca, y desconectar la key vuelve a la suscripción", async () => {
    const claude = connectionsWith(withClaude({ replies: [[init("ANTHROPIC_API_KEY"), pong], [init(), pong]] }));
    await claude.setClaudeApiKey(KEY, "ui");

    expect((await claude.testClaude("subscription", "ui")).mode).toBe("subscription");
    expect(claude.list().map((c) => [c.account, c.status])).toEqual([
      ["api-key", "active"],
      ["subscription", "active"],
    ]);

    await claude.disconnect("claude", "api-key", "ui");
    expect(await secrets.get("connection:claude:api-key")).toBeUndefined();
    expect((await claude.claudeCredentials()).mode).toBe("subscription");
    await claude.disconnect("claude", "subscription", "ui");
    expect(claude.list()).toEqual([]);
  });

  test("pedir probar la API key sin tener una guardada es un error accionable", async () => {
    const claude = connectionsWith(withClaude({ replies: [] }));

    await expect(claude.testClaude("api-key", "ui")).rejects.toThrow(/setClaudeApiKey/);
  });

  test("claude no se conecta con connect", async () => {
    await expect(
      connections.connect({ provider: "claude", account: "api-key", scopes: [], token: KEY }, "ui"),
    ).rejects.toThrow(/setClaudeApiKey/);
  });
});

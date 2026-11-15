import type { Options, SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { describe, expect, test } from "vitest";
import type { QueryFn } from "./claude-runtime";
import { apiKeyCredentials, subscriptionCredentials } from "./credentials";
import { MIN_CLAUDE_VERSION, NOT_INSTALLED_MESSAGE, probeClaude, type ExecFn } from "./probe";

const EXECUTABLE = "/opt/claude/2.1.325";
const BASE_ENV = {
  PATH: "/usr/bin",
  HOME: "/Users/x",
  USER: "x",
  ANTHROPIC_API_KEY: "sk-heredada",
  CLAUDE_CODE_OAUTH_TOKEN: "oauth-heredado",
  GH_TOKEN: "ghp",
};

const subscription = subscriptionCredentials({ executable: EXECUTABLE });

/** `claude --version` y `claude auth status --json` de un `claude` instalado. */
function installed(opts: { version?: string; status?: unknown; statusText?: string } = {}) {
  const calls: { args: string[]; env: Record<string, string> }[] = [];
  const exec: ExecFn = async (_file, args, env) => {
    calls.push({ args, env });
    if (args[0] === "--version") return `${opts.version ?? "2.1.325"} (Claude Code)\n`;
    return opts.statusText ?? JSON.stringify(opts.status ?? { loggedIn: true, authMethod: "claude.ai", subscriptionType: "team" });
  };
  return { exec, calls };
}

// Los mensajes del SDK traen muchos campos que el probe no lee: aquí solo van los que importan.
const msg = (m: Record<string, unknown>) => ({ session_id: "s", ...m }) as unknown as SDKMessage;
const init = (apiKeySource = "none") =>
  msg({ type: "system", subtype: "init", apiKeySource, claude_code_version: "2.1.325" });
const pong = () => msg({ type: "result", subtype: "success", is_error: false, result: "pong" });
const rateLimit = (info: Record<string, unknown>) => msg({ type: "rate_limit_event", rate_limit_info: info });

/** Como el SDK real, lanza después de un `result` con `is_error`. */
function scripted(messages: SDKMessage[]) {
  const calls: { prompt: string; options: Options }[] = [];
  const query: QueryFn = (call) => {
    calls.push(call);
    return (async function* () {
      for (const m of messages) {
        yield m;
        if (m.type === "result" && m.is_error) throw new Error("Claude Code returned an error result");
      }
    })();
  };
  return { query, calls };
}

const probe = (credentials: Parameters<typeof probeClaude>[0]["credentials"], q: QueryFn, exec?: ExecFn) =>
  probeClaude({ credentials, baseEnv: BASE_ENV, query: q, ...(exec ? { exec } : {}) });

describe("detección del claude instalado", () => {
  test("sin claude en el PATH no llama a nadie y dice cómo instalarlo", async () => {
    const { query, calls } = scripted([]);

    const status = await probe(subscriptionCredentials({ env: { PATH: "/nada" } }), query);

    expect(status).toEqual({ mode: "subscription", state: "not_installed", message: NOT_INSTALLED_MESSAGE });
    expect(calls).toEqual([]);
  });

  test("una versión anterior a la mínima pide actualizar, sin gastar cuota", async () => {
    const { query, calls } = scripted([]);
    const { exec } = installed({ version: "2.1.100" });

    const status = await probe(subscription, query, exec);

    expect(status).toMatchObject({ state: "outdated", version: "2.1.100", executable: EXECUTABLE });
    expect(status.message).toContain(MIN_CLAUDE_VERSION);
    expect(calls).toEqual([]);
  });

  test("sin sesión iniciada pide `claude auth login`, sin gastar cuota", async () => {
    const { query, calls } = scripted([]);
    const { exec } = installed({ status: { loggedIn: false } });

    const status = await probe(subscription, query, exec);

    expect(status).toMatchObject({ state: "login_required", version: "2.1.325" });
    expect(status.message).toContain("claude auth login");
    expect(calls).toEqual([]);
  });

  test("una salida de `auth status` que no entiende es un error, no un login", async () => {
    const { exec } = installed({ statusText: "no soy json" });

    const status = await probe(subscription, scripted([]).query, exec);

    expect(status.state).toBe("error");
    expect(status.message).toContain("auth status");
  });

  test("si claude no se puede ejecutar es un error con el motivo", async () => {
    const exec: ExecFn = async () => {
      throw new Error("spawn EACCES");
    };

    const status = await probe(subscription, scripted([]).query, exec);

    expect(status).toMatchObject({ state: "error" });
    expect(status.message).toContain("spawn EACCES");
  });
});

describe("llamada mínima con suscripción", () => {
  test("claude presente y logueado: ready con el plan y las dos barras de uso", async () => {
    const { query, calls } = scripted([
      init(),
      rateLimit({
        status: "allowed_warning",
        rateLimitType: "seven_day",
        utilization: 0.89,
        resetsAt: 1_794_931_200,
        unifiedWindows: {
          five_hour: { utilization: 0.28, resetsAt: 1_794_724_200, status: "allowed" },
          seven_day: { utilization: 0.89, resetsAt: 1_794_931_200, status: "allowed_warning" },
        },
      }),
      pong(),
    ]);
    const { exec } = installed();

    const status = await probe(subscription, query, exec);

    expect(status).toEqual({
      mode: "subscription",
      state: "ready",
      executable: EXECUTABLE,
      version: "2.1.325",
      plan: "team",
      usage: {
        fiveHour: { utilization: 0.28, resetsAt: 1_794_724_200_000 },
        sevenDay: { utilization: 0.89, resetsAt: 1_794_931_200_000 },
      },
    });
    expect(calls).toHaveLength(1);
  });

  test("sin unifiedWindows usa la ventana que reporta el evento", async () => {
    const { query } = scripted([
      init(),
      rateLimit({ status: "allowed", rateLimitType: "five_hour", utilization: 0.1, resetsAt: 100 }),
      pong(),
    ]);

    const status = await probe(subscription, query, installed().exec);

    expect(status.usage).toEqual({ fiveHour: { utilization: 0.1, resetsAt: 100_000 } });
  });

  test("la consulta es mínima y su entorno no hereda credenciales ajenas a la elegida", async () => {
    const { query, calls } = scripted([init(), pong()]);
    const { exec, calls: execCalls } = installed();

    const status = await probe(subscription, query, exec);

    expect(status).not.toHaveProperty("usage");
    const [call] = calls;
    expect(call?.options).toMatchObject({
      model: "haiku",
      maxTurns: 1,
      tools: [],
      settingSources: [],
      persistSession: false,
      pathToClaudeCodeExecutable: EXECUTABLE,
      env: { PATH: "/usr/bin", HOME: "/Users/x", USER: "x" },
    });
    for (const env of [call?.options.env, ...execCalls.map((c) => c.env)]) {
      expect(env).not.toHaveProperty("ANTHROPIC_API_KEY");
      expect(env).not.toHaveProperty("CLAUDE_CODE_OAUTH_TOKEN");
      expect(env).not.toHaveProperty("GH_TOKEN");
    }
  });

  test("el login venció durante la llamada: login_expired", async () => {
    const { query } = scripted([
      init(),
      msg({ type: "assistant", error: "authentication_failed", message: { id: "m", content: [], usage: {} } }),
      msg({ type: "result", subtype: "success", is_error: true, result: "Failed to authenticate" }),
    ]);

    const status = await probe(subscription, query, installed().exec);

    expect(status).toMatchObject({ state: "login_expired", plan: "team" });
    expect(status.message).toContain("claude auth login");
  });

  test("cuota agotada: quota_exhausted con cuándo se reinicia, y se ve el uso", async () => {
    const { query } = scripted([
      init(),
      rateLimit({
        status: "rejected",
        rateLimitType: "seven_day",
        utilization: 1,
        resetsAt: 1_794_931_200,
      }),
      msg({ type: "result", subtype: "success", is_error: true, result: "You've hit your weekly limit" }),
    ]);

    const status = await probe(subscription, query, installed().exec);

    expect(status).toMatchObject({
      state: "quota_exhausted",
      resetsAt: 1_794_931_200_000,
      usage: { sevenDay: { utilization: 1 } },
    });
    expect(status.message).toContain("cuota");
  });

  test("si Claude iba a gastar una API key heredada, no es ready", async () => {
    const { query } = scripted([init("ANTHROPIC_API_KEY"), pong()]);

    const status = await probe(subscription, query, installed().exec);

    expect(status.state).toBe("error");
    expect(status.message).toContain("API key");
  });

  test("un proceso que muere sin resultado es un error con su causa", async () => {
    const query: QueryFn = () =>
      (async function* () {
        yield init();
        throw new Error("Claude Code process exited with code 1");
      })();

    const status = await probe(subscription, query, installed().exec);

    expect(status.state).toBe("error");
    expect(status.message).toContain("exited with code 1");
  });
});

describe("llamada mínima con API key", () => {
  const key = apiKeyCredentials("sk-ant-buena", { executable: EXECUTABLE });

  test("pasa la key en el entorno, no busca login y no pide plan", async () => {
    const { query, calls } = scripted([init("ANTHROPIC_API_KEY"), pong()]);
    const { exec, calls: execCalls } = installed();

    const status = await probe(key, query, exec);

    expect(status).toMatchObject({ mode: "api-key", state: "ready" });
    expect(status).not.toHaveProperty("plan");
    expect(execCalls).toEqual([]);
    expect(calls[0]?.options.env).toMatchObject({ ANTHROPIC_API_KEY: "sk-ant-buena" });
  });

  test("funciona sin claude instalado: usa el que trae el SDK", async () => {
    const { query, calls } = scripted([init("ANTHROPIC_API_KEY"), pong()]);

    const status = await probe(apiKeyCredentials("sk", { env: { PATH: "/nada" } }), query);

    expect(status.state).toBe("ready");
    expect(calls[0]?.options).not.toHaveProperty("pathToClaudeCodeExecutable");
  });

  test("una key rechazada es key_rejected, no un login vencido", async () => {
    const { query } = scripted([
      init("ANTHROPIC_API_KEY"),
      msg({ type: "assistant", error: "authentication_failed", message: { id: "m", content: [], usage: {} } }),
      msg({ type: "result", subtype: "success", is_error: true, result: "Invalid API key" }),
    ]);

    const status = await probe(key, query);

    expect(status.state).toBe("key_rejected");
    expect(status.message).toContain("API key");
    expect(status.message).not.toContain("claude auth login");
  });

  test("si Claude no usa la key (apiKeySource none) no es ready", async () => {
    const status = await probe(key, scripted([init("none"), pong()]).query);

    expect(status.state).toBe("error");
    expect(status.message).toContain("API key");
  });
});

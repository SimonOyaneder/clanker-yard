import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { HookInput, Options, SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type { AgentEvent, RunSpec } from "../runtime";
import { createClaudeRuntime, type QueryFn } from "./claude-runtime";
import { apiKeyCredentials, subscriptionCredentials, type ClaudeCredentials } from "./credentials";

let home: string;
let cwd: string;
beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), "claude-runtime-home-"));
  cwd = await mkdtemp(join(tmpdir(), "claude-runtime-cwd-"));
});
afterEach(async () => {
  await rm(home, { recursive: true, force: true });
  await rm(cwd, { recursive: true, force: true });
});

const credentials = subscriptionCredentials({ executable: "/bin/claude" });

const spec = (overrides: Partial<RunSpec> = {}): RunSpec => ({
  role: "dev",
  cwd,
  systemPrompt: "Eres el dev.",
  prompt: "Haz lo tuyo.",
  model: "haiku",
  native: { sources: [], skills: [] },
  references: [],
  hooks: false,
  tools: "all",
  outputSchema: { type: "object" },
  ...overrides,
});

// Los mensajes del SDK traen muchos campos que el adapter no lee: aquí solo se escriben los que importan.
function message(m: { type: SDKMessage["type"] } & Record<string, unknown>): SDKMessage {
  return { session_id: "sess-1", ...m } as SDKMessage;
}

const init = (apiKeySource = "none") => message({ type: "system", subtype: "init", apiKeySource });

const usage = (inputTokens: number, outputTokens: number, cacheRead = 0, cacheWrite = 0) => ({
  input_tokens: inputTokens,
  output_tokens: outputTokens,
  cache_read_input_tokens: cacheRead,
  cache_creation_input_tokens: cacheWrite,
});

const assistant = (id: string, content: unknown[], extra: Record<string, unknown> = {}) =>
  message({ type: "assistant", message: { id, model: "haiku", content, usage: usage(1, 1) }, ...extra });

const modelUsage = (input: number, output: number, cacheRead: number, cacheWrite: number) => ({
  haiku: {
    inputTokens: input,
    outputTokens: output,
    cacheReadInputTokens: cacheRead,
    cacheCreationInputTokens: cacheWrite,
    costUSD: 0,
  },
});

const success = (extra: Record<string, unknown> = {}) =>
  message({
    type: "result",
    subtype: "success",
    is_error: false,
    result: "listo",
    structured_output: { outcome: "done" },
    total_cost_usd: 0.25,
    modelUsage: modelUsage(100, 50, 1000, 200),
    ...extra,
  });

interface Call {
  prompt: string;
  options: Options;
}

/**
 * Un `query` falso: reproduce los mensajes y, como el SDK, lanza después de un `result` con `is_error`.
 * Con una función como guion, ella decide (por ejemplo, detenerse con el error de abort real).
 */
function fakeQuery(script: SDKMessage[] | ((call: Call) => AsyncIterable<SDKMessage>)) {
  const calls: Call[] = [];
  const query: QueryFn = (call) => {
    calls.push(call);
    if (typeof script === "function") return script(call);
    return (async function* () {
      for (const m of script) {
        yield m;
        if (m.type === "result" && m.is_error) {
          const text = m.subtype === "success" ? m.result : m.errors.join(", ");
          throw new Error(`Claude Code returned an error result: ${text}`);
        }
      }
    })();
  };
  return { query, calls };
}

function runtimeWith(query: QueryFn, creds: ClaudeCredentials = credentials) {
  return createClaudeRuntime({
    credentials: async () => creds,
    home,
    query,
    baseEnv: { PATH: "/usr/bin", HOME: "/Users/x", USER: "x", GH_TOKEN: "ghp", LINEAR_API_KEY: "lin", SSH_AUTH_SOCK: "/s" },
  });
}

async function collect(events: AsyncIterable<AgentEvent>): Promise<AgentEvent[]> {
  const all: AgentEvent[] = [];
  for await (const e of events) all.push(e);
  return all;
}

const transcriptLines = async (id = "sess-1") =>
  (await readFile(join(home, "transcripts", `${id}.jsonl`), "utf8"))
    .trim()
    .split("\n")
    .map((l) => JSON.parse(l) as Record<string, unknown>);

describe("start", () => {
  test("transmite eventos, devuelve el reporte con el uso de la corrida y guarda el transcript completo", async () => {
    const script = [
      init(),
      assistant("m1", [
        { type: "text", text: "Reviso el repo" },
        { type: "tool_use", id: "t1", name: "Read", input: { file_path: "a.ts" } },
      ]),
      message({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "t1", content: "x" }] } }),
      assistant("m2", [{ type: "text", text: "Hecho" }]),
      success(),
    ];
    const { query } = fakeQuery(script);

    const run = await runtimeWith(query).start(spec());
    const events = await collect(run.events);
    const result = await run.result;

    expect(run.ref).toEqual({ runtime: "claude-sdk", sessionId: "sess-1", cwd });
    expect(events.filter((e) => e.type !== "usage" && e.type !== "usage_remainder")).toEqual([
      { type: "first_token" },
      { type: "text", text: "Reviso el repo" },
      { type: "tool_start", tool: "Read", detail: "a.ts" },
      { type: "tool_end", tool: "Read" },
      { type: "text", text: "Hecho" },
    ]);
    expect(events.filter((e) => e.type === "usage")).toHaveLength(2);
    expect(result).toEqual({
      status: "success",
      text: "listo",
      structured: { outcome: "done" },
      usage: {
        turns: 2,
        tokensIn: 100,
        tokensOut: 50,
        tokensCacheRead: 1000,
        tokensCacheWrite: 200,
        costMicros: 250_000,
        costSource: "estimate",
      },
    });
    expect(await transcriptLines()).toEqual(script);
  });

  test("lo que el total del result cuenta de más que los turnos sale como resto por modelo", async () => {
    // Cada turno trae 1 de entrada y 1 de salida (el uso en streaming no es final): el total dice 100 y 50.
    const { query } = fakeQuery([
      init(),
      assistant("m1", [{ type: "text", text: "a" }]),
      assistant("m2", [{ type: "text", text: "b" }]),
      success({
        modelUsage: {
          ...modelUsage(100, 50, 1000, 200),
          other: { inputTokens: 7, outputTokens: 3, cacheReadInputTokens: 0, cacheCreationInputTokens: 0, costUSD: 0 },
        },
      }),
    ]);

    const run = await runtimeWith(query).start(spec());
    const remainders = (await collect(run.events)).filter((e) => e.type === "usage_remainder");

    expect(remainders).toEqual([
      { type: "usage_remainder", model: "haiku", tokens: { tokensIn: 98, tokensOut: 48, tokensCacheRead: 1000, tokensCacheWrite: 200 }, cacheWrite1hTokens: 0 },
      { type: "usage_remainder", model: "other", tokens: { tokensIn: 7, tokensOut: 3, tokensCacheRead: 0, tokensCacheWrite: 0 }, cacheWrite1hTokens: 0 },
    ]);
  });

  test("un mensaje partido en bloques (mismo id) cuenta un solo turno", async () => {
    const { query } = fakeQuery([
      init(),
      assistant("m1", [{ type: "text", text: "a" }]),
      assistant("m1", [{ type: "tool_use", id: "t1", name: "Bash", input: { command: "ls" } }]),
      success(),
    ]);
    const run = await runtimeWith(query).start(spec());
    const events = await collect(run.events);
    expect(events.filter((e) => e.type === "usage")).toHaveLength(1);
    expect((await run.result).usage.turns).toBe(1);
  });

  test("lanza el SDK con el entorno sin credenciales y con GH_CONFIG_DIR vacío", async () => {
    const { query, calls } = fakeQuery([init(), success()]);
    const run = await runtimeWith(query).start(spec());
    await run.result;

    const env = calls[0]?.options.env ?? {};
    expect(env).toMatchObject({ PATH: "/usr/bin", HOME: "/Users/x", USER: "x" });
    expect(Object.keys(env).filter((k) => /GH_TOKEN|GITHUB_TOKEN|LINEAR|SSH_AUTH_SOCK|ANTHROPIC/.test(k))).toEqual([]);
    expect(env.GH_CONFIG_DIR).toBe(join(home, "agent-env", "gh"));
    expect(await readdir(env.GH_CONFIG_DIR ?? "")).toEqual([]);
    expect(await readFile(env.GIT_CONFIG_GLOBAL ?? "", "utf8")).toBe(
      '[user]\n\tname = "Clanker Yard"\n\temail = "clanker@localhost"\n[credential]\n\thelper =\n',
    );
    expect(calls[0]?.options.pathToClaudeCodeExecutable).toBe("/bin/claude");
  });

  test("deja vacío GH_CONFIG_DIR aunque una corrida anterior haya escrito ahí", async () => {
    const ghDir = join(home, "agent-env", "gh");
    await mkdir(ghDir, { recursive: true });
    await writeFile(join(ghDir, "hosts.yml"), "github.com: {}");

    const { query } = fakeQuery([init(), success()]);
    const run = await runtimeWith(query).start(spec());
    await run.result;

    expect(await readdir(ghDir)).toEqual([]);
  });

  test("los archivos de contexto entran al prompt de sistema, tras el límite cacheable", async () => {
    const { query, calls } = fakeQuery([init(), success()]);

    const run = await runtimeWith(query).start(
      spec({
        references: [
          { label: "AGENTS.md", content: "reglas del repo" },
          { label: "rule:git-safety", content: "confirmar siempre" },
        ],
      }),
    );
    await run.result;

    expect(calls[0]?.options.systemPrompt).toEqual([
      "Eres el dev.",
      "__SYSTEM_PROMPT_DYNAMIC_BOUNDARY__",
      "# AGENTS.md\n\nreglas del repo\n\n# rule:git-safety\n\nconfirmar siempre",
    ]);
  });

  describe("skills editadas con la sesión en curso", () => {
    /** Un `query` que espera a que el core recargue las skills (o falla al intentarlo) antes de terminar. */
    function reloading(reload: () => Promise<unknown>) {
      let reloaded!: () => void;
      const done = new Promise<void>((resolve) => (reloaded = resolve));
      const query: QueryFn = () =>
        Object.assign(
          (async function* () {
            yield init();
            await done;
            yield success();
          })(),
          {
            reloadSkills: async () => {
              try {
                return await reload();
              } finally {
                reloaded();
              }
            },
          },
        );
      return query;
    }

    const runtimeIn = (userDir: string, query: QueryFn) =>
      createClaudeRuntime({ credentials: async () => credentials, home, query, baseEnv: { CLAUDE_CONFIG_DIR: userDir } });

    /**
     * Escribe `path` hasta que el core intente recargar. En macOS el observador (FSEvents) arranca de forma
     * asíncrona y bajo carga se pierde una escritura hecha justo después de `start`.
     */
    async function editUntilReloaded(path: string, attempts: () => number) {
      await vi.waitFor(
        async () => {
          if (attempts() === 0) await writeFile(path, `# versión ${Date.now()}`);
          expect(attempts()).toBeGreaterThan(0);
        },
        { timeout: 10_000, interval: 1_000 },
      );
    }

    test("el core llama a reloadSkills cuando cambia una skill de las sources del rol", async () => {
      const userDir = join(cwd, "claude");
      await mkdir(join(userDir, "skills", "commit"), { recursive: true });
      let reloads = 0;
      const query = reloading(async () => void reloads++);

      const run = await runtimeIn(userDir, query).start(spec({ native: { sources: ["user"], skills: ["commit"] } }));
      await editUntilReloaded(join(userDir, "skills", "commit", "SKILL.md"), () => reloads);
      const result = await run.result;

      expect(result.status).toBe("success");
      expect(reloads).toBeGreaterThan(0);
    }, 15_000);

    test("si no se puede recargar, el run sigue y el fallo sale como evento error", async () => {
      const userDir = join(cwd, "claude");
      await mkdir(join(userDir, "skills"), { recursive: true });
      let attempts = 0;
      const query = reloading(() => {
        attempts++;
        return Promise.reject(new Error("el proceso ya cerró"));
      });

      const run = await runtimeIn(userDir, query).start(spec({ native: { sources: ["user"], skills: "all" } }));
      const events = collect(run.events);
      await editUntilReloaded(join(userDir, "skills", "nueva.md"), () => attempts);

      expect((await run.result).status).toBe("success");
      expect(await events).toContainEqual({
        type: "error",
        kind: "other",
        message: expect.stringContaining('No se pudieron recargar las skills del rol "dev": el proceso ya cerró'),
      });
    }, 15_000);
  });

  test("la sesión guardada no lleva copia del contexto: retomar lo vuelve a recibir", async () => {
    const { query } = fakeQuery([init(), success()]);
    const run = await runtimeWith(query).start(
      spec({ native: { sources: ["user"], skills: ["commit"] }, references: [{ label: "AGENTS.md", content: "v1" }] }),
    );
    await run.result;

    const stored = await readFile(join(home, "agent-sessions", "sess-1.json"), "utf8");
    expect(stored).not.toContain("v1");
    expect(stored).not.toContain("commit");

    const second = fakeQuery([init(), success()]);
    const resumed = await runtimeWith(second.query).resume(run.ref, "sigue", {
      outputSchema: { type: "object" },
      native: { sources: ["user"], skills: ["commit"] },
      references: [{ label: "AGENTS.md", content: "v2" }],
    });
    await resumed.result;

    expect(second.calls[0]?.options).toMatchObject({ skills: ["commit"] });
    expect(second.calls[0]?.options.systemPrompt).toEqual(["Eres el dev.", "__SYSTEM_PROMPT_DYNAMIC_BOUNDARY__", "# AGENTS.md\n\nv2"]);
  });

  test("first_token sale con el primer mensaje del modelo, aunque sea solo razonamiento, y una sola vez", async () => {
    const { query } = fakeQuery([
      init(),
      assistant("m1", [{ type: "thinking", thinking: "pienso" }]),
      assistant("m1", [{ type: "text", text: "Hola" }]),
      assistant("m2", [{ type: "text", text: "Chao" }]),
      success(),
    ]);
    const run = await runtimeWith(query).start(spec());
    const types = (await collect(run.events)).map((e) => e.type);

    expect(types.filter((t) => t === "first_token")).toHaveLength(1);
    expect(types.slice(0, 2)).toEqual(["first_token", "text"]);
  });

  test("el hook PreCompact avisa la compactación como evento", async () => {
    const { query } = fakeQuery((call) =>
      (async function* () {
        yield init();
        const hook = call.options.hooks?.PreCompact?.[0]?.hooks[0];
        const input = { hook_event_name: "PreCompact", session_id: "sess-1", trigger: "auto" } as HookInput;
        await hook?.(input, undefined, { signal: new AbortController().signal });
        yield success();
      })(),
    );
    const run = await runtimeWith(query).start(spec());
    expect((await collect(run.events)).filter((e) => e.type === "compaction")).toEqual([{ type: "compaction" }]);
  });

  test("el hook PreCompact deja la compactación en el transcript", async () => {
    const { query } = fakeQuery((call) =>
      (async function* () {
        yield init();
        const hook = call.options.hooks?.PreCompact?.[0]?.hooks[0];
        const input = { hook_event_name: "PreCompact", session_id: "sess-1", trigger: "auto" } as HookInput;
        await hook?.(input, undefined, { signal: new AbortController().signal });
        yield success();
      })(),
    );
    const run = await runtimeWith(query).start(spec());
    await run.result;

    const lines = await transcriptLines();
    expect(lines.map((l) => l.type)).toEqual(["system", "clanker", "result"]);
    expect(lines[1]).toMatchObject({ subtype: "pre_compact", trigger: "auto", session_id: "sess-1" });
  });

  test("falla si el entorno hizo que Claude gaste una API key en modo suscripción", async () => {
    const { query } = fakeQuery(abortable([init("ANTHROPIC_API_KEY")]));
    const run = await runtimeWith(query).start(spec());
    const result = await run.result;
    expect(result.status).toBe("error");
    expect(result.message).toMatch(/API key \(ANTHROPIC_API_KEY\) en vez de la suscripción/);
  });

  test("falla si en modo API key Claude no usa la key", async () => {
    const creds: ClaudeCredentials = { executable: "/bin/claude", env: () => ({ ANTHROPIC_API_KEY: "k" }), mode: "api-key" };
    const { query } = fakeQuery(abortable([init("none")]));
    const run = await runtimeWith(query, creds).start(spec());
    expect((await run.result).message).toMatch(/no está usando la API key/);
  });

  test("con API key el costo es del runtime, no una estimación", async () => {
    const creds: ClaudeCredentials = { executable: "/bin/claude", env: () => ({ ANTHROPIC_API_KEY: "k" }), mode: "api-key" };
    const { query } = fakeQuery([init("ANTHROPIC_API_KEY"), success()]);
    const run = await runtimeWith(query, creds).start(spec());
    expect((await run.result).usage.costSource).toBe("runtime");
  });

  test("un proceso que muere sin resultado ni aviso rechaza result", async () => {
    const { query } = fakeQuery((): AsyncIterable<SDKMessage> =>
      (async function* () {
        yield init();
        throw new Error("Claude Code process exited with code 1");
      })(),
    );
    const run = await runtimeWith(query).start(spec());
    await expect(run.result).rejects.toThrow(/exited with code 1/);
  });

  test("si el proceso muere antes de iniciar la sesión, start rechaza", async () => {
    const { query } = fakeQuery((): AsyncIterable<SDKMessage> =>
      (async function* () {
        yield* [] as SDKMessage[];
        throw new Error("spawn claude ENOENT");
      })(),
    );
    await expect(runtimeWith(query).start(spec())).rejects.toThrow(/spawn claude ENOENT/);
  });
});

describe("estados de fallo", () => {
  async function resultOf(script: SDKMessage[]) {
    const { query } = fakeQuery(script);
    const run = await runtimeWith(query).start(spec());
    return run.result;
  }

  test("authentication_failed es login_expired, no cuota", async () => {
    const result = await resultOf([
      init(),
      assistant("m1", [{ type: "text", text: "Failed to authenticate" }], { error: "authentication_failed" }),
      success({ is_error: true, result: "Failed to authenticate. OAuth session expired", structured_output: undefined }),
    ]);
    expect(result.status).toBe("login_expired");
    expect(result.message).toMatch(/claude auth login/);
  });

  test("con API key, authentication_failed dice que la key fue rechazada y no manda a `claude auth login`", async () => {
    const { query } = fakeQuery([
      init("ANTHROPIC_API_KEY"),
      assistant("m1", [], { error: "authentication_failed" }),
      success({ is_error: true, result: "Invalid API key", structured_output: undefined }),
    ]);
    const run = await runtimeWith(query, apiKeyCredentials("sk-x", { executable: "/bin/claude" })).start(spec());

    const result = await run.result;

    expect(result.status).toBe("login_expired");
    expect(result.message).toMatch(/API key/);
    expect(result.message).not.toMatch(/claude auth login/);
  });

  test("un rate_limit_event rechazado es quota_exhausted con el reinicio en ms", async () => {
    const result = await resultOf([
      init(),
      message({
        type: "rate_limit_event",
        rate_limit_info: { status: "rejected", resetsAt: 1_794_931_200, rateLimitType: "seven_day" },
      }),
      success({ is_error: true, result: "You've hit your weekly limit", structured_output: undefined }),
    ]);
    expect(result).toMatchObject({ status: "quota_exhausted", resetsAt: 1_794_931_200_000 });
  });

  test("credits_required lo dice en el mensaje", async () => {
    const result = await resultOf([
      init(),
      message({ type: "rate_limit_event", rate_limit_info: { status: "rejected", errorCode: "credits_required" } }),
      success({ is_error: true, result: "", structured_output: undefined }),
    ]);
    expect(result.status).toBe("quota_exhausted");
    expect(result.message).toMatch(/crédito/);
    expect(result).not.toHaveProperty("resetsAt");
  });

  test.each(["session limit", "weekly limit", "Opus limit", "Sonnet limit"])(
    "el texto \"You've hit your %s\" es cuota aunque no llegue ningún evento",
    async (limit) => {
      const result = await resultOf([
        init(),
        success({ is_error: true, result: `You've hit your ${limit}`, structured_output: undefined }),
      ]);
      expect(result.status).toBe("quota_exhausted");
    },
  );

  test("un 429 transitorio que el CLI reintentó y terminó bien sigue siendo success", async () => {
    const result = await resultOf([
      init(),
      assistant("m1", [], { error: "rate_limit" }),
      message({ type: "rate_limit_event", rate_limit_info: { status: "allowed_warning", utilization: 0.9 } }),
      success(),
    ]);
    expect(result.status).toBe("success");
  });

  test("los topes del SDK conservan su estado", async () => {
    const turns = await resultOf([init(), message({ type: "result", subtype: "error_max_turns", is_error: true, errors: [], total_cost_usd: 0.1, modelUsage: {} })]);
    const budget = await resultOf([init(), message({ type: "result", subtype: "error_max_budget_usd", is_error: true, errors: [], total_cost_usd: 0.1, modelUsage: {} })]);
    expect(turns.status).toBe("error_max_turns");
    expect(budget.status).toBe("error_max_budget_usd");
    expect(turns.usage.costMicros).toBe(100_000);
  });

  test("otro error conserva el texto del SDK", async () => {
    const result = await resultOf([
      init(),
      message({ type: "result", subtype: "error_during_execution", is_error: true, errors: ["boom", "bam"], total_cost_usd: 0, modelUsage: {} }),
    ]);
    expect(result).toMatchObject({ status: "error", message: "boom; bam" });
  });
});

describe("interrupt", () => {
  test("aborta el proceso y resuelve error con lo gastado hasta ahí", async () => {
    const { query, calls } = fakeQuery(
      abortable([init(), assistant("m1", [{ type: "text", text: "trabajando" }])]),
    );
    const run = await runtimeWith(query).start(spec());
    const seen: AgentEvent[] = [];
    const reading = (async () => {
      for await (const e of run.events) {
        seen.push(e);
        if (e.type === "text") await run.interrupt();
      }
    })();

    const result = await run.result;
    await reading;

    expect(calls[0]?.options.abortController?.signal.aborted).toBe(true);
    expect(result).toMatchObject({ status: "error", message: "El run fue interrumpido." });
    expect(result.usage.turns).toBe(1);
  });
});

describe("resume", () => {
  const first = [init(), success({ total_cost_usd: 0.25, modelUsage: modelUsage(100, 50, 1000, 200) })];

  test("retoma con el mismo spec y reporta solo lo gastado en este run", async () => {
    const { query, calls } = fakeQuery(first);
    const runtime = runtimeWith(query);
    const started = await runtime.start(spec({ model: "haiku", effort: "low", maxTurns: 5 }));
    await started.result;

    // El SDK arrastra el acumulado al retomar: el segundo result ya trae lo del primero.
    const second = fakeQuery([
      init(),
      assistant("m9", [{ type: "text", text: "sigo" }]),
      success({ total_cost_usd: 0.4, modelUsage: modelUsage(130, 90, 1500, 200) }),
    ]);
    const resumed = await runtimeWith(second.query).resume(started.ref, "Corrige esto.", {
      outputSchema: { type: "object", title: "otro" },
      maxTurns: 9,
      references: [],
    });
    const result = await resumed.result;

    expect(second.calls[0]).toMatchObject({
      prompt: "Corrige esto.",
      options: {
        resume: "sess-1",
        model: "haiku",
        effort: "low",
        cwd,
        maxTurns: 9,
        outputFormat: { schema: { type: "object", title: "otro" } },
      },
    });
    expect(calls).toHaveLength(1);
    expect(result.usage).toEqual({
      turns: 1,
      tokensIn: 30,
      tokensOut: 40,
      tokensCacheRead: 500,
      tokensCacheWrite: 0,
      costMicros: 150_000,
      costSource: "estimate",
    });
    // El transcript de la sesión sigue en el mismo archivo.
    expect((await transcriptLines()).filter((l) => l.type === "result")).toHaveLength(2);
  });

  test("si el total quedó bajo el previo (un /clear), el previo no se resta", async () => {
    const started = await (await runtimeWith(fakeQuery(first).query).start(spec())).result;
    expect(started.status).toBe("success");

    const second = fakeQuery([init(), success({ total_cost_usd: 0.05, modelUsage: modelUsage(10, 5, 0, 0) })]);
    const resumed = await runtimeWith(second.query).resume(
      { runtime: "claude-sdk", sessionId: "sess-1", cwd },
      "sigue",
      { outputSchema: { type: "object" }, references: [] },
    );
    expect((await resumed.result).usage).toMatchObject({ tokensIn: 10, costMicros: 50_000 });
  });

  test("una sesión que este runtime no inició no se retoma", async () => {
    const { query } = fakeQuery([init(), success()]);
    await expect(
      runtimeWith(query).resume({ runtime: "claude-sdk", sessionId: "ajena", cwd }, "hola", { outputSchema: {}, references: [] }),
    ).rejects.toThrow(/solo retoma las sesiones que él inició/);
  });
});

/** Reproduce los mensajes y luego espera a que el SDK lo aborte, como hace el proceso real. */
function abortable(messages: SDKMessage[]) {
  return (call: Call): AsyncIterable<SDKMessage> =>
    (async function* () {
      yield* messages;
      const signal = call.options.abortController?.signal;
      await new Promise<void>((resolve) => {
        if (signal?.aborted) resolve();
        signal?.addEventListener("abort", () => resolve());
      });
      throw new Error("Claude Code process aborted by user");
    })();
}

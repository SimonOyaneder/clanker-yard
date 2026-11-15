import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import type { ChildProcess } from "node:child_process";
import type { Options, SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import type { Brief, JsonSchema } from "@clanker/api";
import {
  createClaudeRuntime,
  createProcs,
  newId,
  openStore,
  subscriptionCredentials,
  type AgentEvent,
  type AgentRun,
  type AgentRuntime,
  type QueryFn,
  type RunSpec,
  type Store,
} from "@clanker/core";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { parse } from "yaml";
import { createFakeRuntime } from "./fake-runtime";
import { tempGitRepo, type TempGitRepo } from "./git";

// Se graba con el runtime de Claude y un `query` falso con la forma de lo que el SDK devolvió en la primera
// corrida real; se reproduce con el fake. No se llama a Claude.

const cleanups: (() => void)[] = [];
let recordDir: string;
let store: Store;
beforeEach(() => {
  recordDir = mkdtempSync(join(tmpdir(), "clanker-record-"));
  store = openStore({ path: ":memory:" });
  cleanups.push(() => rmSync(recordDir, { recursive: true, force: true }), () => store.close());
});
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
});

function repo(): TempGitRepo {
  const created = tempGitRepo({ commits: [{ message: "chore: base", files: { "app/models/transfer.rb": "class Transfer\nend\n" } }] });
  cleanups.push(created.cleanup);
  return created;
}

const outputSchema: JsonSchema = {
  type: "object",
  properties: {
    outcome: { type: "string", enum: ["done", "changes"] },
    summary: { type: "string" },
    payload: { type: "object" },
  },
  required: ["outcome", "summary", "payload"],
};

function brief(mode: string, round = 1, issue = "ENG-9171"): Brief {
  return {
    run: { id: newId("run") as Brief["run"]["id"], subject: { type: "issue", id: "1" }, round, attempt: 1 },
    issue: { key: issue, title: "t", criteria: [] },
    worktree: "/work/tree",
    base: "origin/main",
    mode,
    artifacts: {},
    payload: {},
  };
}

function specFor(cwd: string, mode = "implement", extra: Partial<RunSpec> = {}): RunSpec {
  return {
    role: "dev",
    cwd,
    systemPrompt: "Eres el dev.",
    prompt: `Implementa.\n\n${JSON.stringify(brief(mode), null, 2)}`,
    model: "claude-sonnet-5-5",
    native: { sources: [], skills: [] },
    references: [],
    hooks: false,
    tools: "all",
    outputSchema,
    ...extra,
  };
}

// Los mensajes del SDK traen muchos campos que el adapter no lee: aquí solo van los que importan.
const message = (m: Record<string, unknown>) => ({ session_id: "sess-rec", ...m }) as unknown as SDKMessage;
const MODEL = "claude-sonnet-5-5";
const turn = (id: string, content: unknown[], usage: { input: number; output: number; read?: number; write?: number }) =>
  message({
    type: "assistant",
    message: {
      id,
      model: MODEL,
      content,
      usage: {
        input_tokens: usage.input,
        output_tokens: usage.output,
        cache_read_input_tokens: usage.read ?? 0,
        cache_creation_input_tokens: usage.write ?? 0,
      },
    },
  });
const toolResult = (id: string, content: unknown) =>
  message({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: id, content }] } });
const init = message({ type: "system", subtype: "init", apiKeySource: "none" });
const totals = { [MODEL]: { inputTokens: 5, outputTokens: 400, cacheReadInputTokens: 2100, cacheCreationInputTokens: 1000, costUSD: 0 } };

/** El `query` falso lanza tras un `result` con error, como el SDK real. */
function queryOf(messages: (cwd: string) => SDKMessage[]): QueryFn {
  return ({ options }) =>
    (async function* () {
      for (const m of messages(options.cwd as string)) {
        yield m;
        if (m.type === "result" && m.is_error) throw new Error("Claude Code returned an error result");
      }
    })();
}

const report = (summary: string) => ({ outcome: "done", summary, payload: { files: ["app/models/transfer.rb"] } });

/** Una corrida de dev como la real: el uso de cada turno llega parcial, el agente edita un archivo y entrega el reporte con `StructuredOutput`. */
function devRun(summary = "mejoré Transfer"): QueryFn {
  return queryOf((cwd) => {
    writeFileSync(join(cwd, "app/models/transfer.rb"), "class Transfer\n  def settle!; end\nend\n");
    mkdirSync(join(cwd, "docs"), { recursive: true });
    writeFileSync(join(cwd, "docs/notes.md"), `Probado en ${cwd}\n`);
    return [
      init,
      turn("m1", [{ type: "text", text: `Reviso ${cwd}/app/models/transfer.rb` }], { input: 3, output: 1, write: 1000 }),
      turn("m1", [{ type: "tool_use", id: "t1", name: "Read", input: { file_path: join(cwd, "app/models/transfer.rb") } }], { input: 3, output: 1, write: 1000 }),
      toolResult("t1", [{ type: "text", text: `class Transfer\nend\nGH_TOKEN=ghp_abcdefghijklmnopqrstuvwxyz0123456789\n${homedir()}/.claude/skills/x/SKILL.md` }]),
      turn("m2", [{ type: "tool_use", id: "t2", name: "Edit", input: { file_path: join(cwd, "app/models/transfer.rb") } }], { input: 1, output: 1, read: 1000 }),
      toolResult("t2", "ok"),
      turn("m3", [{ type: "tool_use", id: "t3", name: "StructuredOutput", input: report(summary) }], { input: 1, output: 1, read: 1100 }),
      toolResult("t3", "Structured output provided successfully"),
      message({
        type: "result",
        subtype: "success",
        is_error: false,
        result: "Listo, cambié Transfer",
        structured_output: report(summary),
        total_cost_usd: 0.5,
        modelUsage: totals,
      }),
    ];
  });
}

function recorder(query: QueryFn, extra: { procs?: ReturnType<typeof createProcs> } = {}): AgentRuntime {
  const home = mkdtempSync(join(tmpdir(), "clanker-record-home-"));
  cleanups.push(() => rmSync(home, { recursive: true, force: true }));
  return createClaudeRuntime({
    credentials: async () => subscriptionCredentials({ executable: "/bin/claude" }),
    home,
    query,
    record: recordDir,
    ...extra,
  });
}

async function drain(run: AgentRun): Promise<AgentEvent[]> {
  const events: AgentEvent[] = [];
  for await (const event of run.events) events.push(event);
  return events;
}

const shape = (events: AgentEvent[]) =>
  events.flatMap((e) => (e.type === "text" ? [`text`] : e.type === "tool_start" || e.type === "tool_end" ? [`${e.type} ${e.tool}`] : []));

const files = (dir: string): string[] => readdirSync(dir, { recursive: true, encoding: "utf8" }).sort();
const issueDir = () => join(recordDir, "eng-9171");

function replayer(): AgentRuntime {
  return createFakeRuntime({ fixtures: issueDir(), speed: Infinity });
}

describe("grabar y reproducir", () => {
  test("el fake reproduce la corrida grabada: mismo reporte, texto, uso, eventos y patch", async () => {
    const recorded = repo();
    const run = await recorder(devRun()).start(specFor(recorded.dir));
    const [events, result] = [await drain(run), await run.result];

    expect(files(issueDir())).toEqual(["dev.r1.implement.yaml", "patches", "patches/dev.r1.implement.patch"]);

    const fresh = repo();
    const replayed = await replayer().start(specFor(fresh.dir));
    const replayedEvents = await drain(replayed);
    const replayedResult = await replayed.result;

    expect(replayedResult.status).toBe("success");
    expect(replayedResult.structured).toEqual(result.structured);
    expect(replayedResult.text).toBe(result.text);
    expect(replayedResult.usage).toEqual(result.usage);
    expect(result.usage).toMatchObject({ turns: 3, tokensOut: 400, tokensCacheRead: 2100, tokensCacheWrite: 1000, costMicros: 500_000 });
    expect(shape(replayedEvents)).toEqual(shape(events));
    expect(readFileSync(join(fresh.dir, "app/models/transfer.rb"), "utf8")).toBe("class Transfer\n  def settle!; end\nend\n");
    expect(readFileSync(join(fresh.dir, "docs/notes.md"), "utf8")).toBe("Probado en .\n");
  });

  test("el guion no lleva rutas de la máquina ni secretos, y las herramientas quedan con rutas relativas", async () => {
    const recorded = repo();
    await (await recorder(devRun()).start(specFor(recorded.dir))).result;

    const yaml = readFileSync(join(issueDir(), "dev.r1.implement.yaml"), "utf8");
    const patch = readFileSync(join(issueDir(), "patches/dev.r1.implement.patch"), "utf8");
    for (const text of [yaml, patch]) {
      expect(text).not.toContain(recorded.dir);
      expect(text).not.toContain(homedir());
      expect(text).not.toContain("ghp_");
    }
    expect(yaml).toContain("file_path: app/models/transfer.rb");
    expect(yaml).toContain("<home>/.claude/skills/x/SKILL.md");
    expect(yaml).toContain("GH_TOKEN=[secreto]");
    expect(parse(yaml)).toMatchObject({ match: { role: "dev", mode: "implement", round: 1, issue: "*" }, times: 1 });
  });

  test("el reporte de StructuredOutput va una sola vez, en el resultado", async () => {
    await (await recorder(devRun("único")).start(specFor(repo().dir))).result;

    const yaml = readFileSync(join(issueDir(), "dev.r1.implement.yaml"), "utf8");
    expect(yaml.match(/único/g)).toHaveLength(1);
    expect(yaml).toContain("tool: StructuredOutput");
  });

  test("lo grabado dos veces con el mismo rol, ronda y modo se sirve en el orden en que ocurrió", async () => {
    const runtime = recorder(devRun("primero"));
    await (await runtime.start(specFor(repo().dir))).result;
    await (await recorder(devRun("segundo")).start(specFor(repo().dir))).result;

    expect(files(issueDir())).toEqual(["dev.r1.implement.yaml", "dev.r1.implement02.yaml", "patches", "patches/dev.r1.implement.patch", "patches/dev.r1.implement02.patch"]);
    const replay = replayer();
    const summaries = [];
    for (let i = 0; i < 2; i++) summaries.push(((await (await replay.start(specFor(repo().dir))).result).structured as { summary: string }).summary);
    expect(summaries).toEqual(["primero", "segundo"]);
    await expect(replay.start(specFor(repo().dir))).rejects.toThrow(/no hay fixture para dev r1/);
  });

  test("cada modo y ronda tiene su guion, y una corrida sin cambios no deja patch", async () => {
    const query = queryOf(() => [
      init,
      turn("m1", [{ type: "tool_use", id: "t1", name: "StructuredOutput", input: report("sin hallazgos") }], { input: 1, output: 1 }),
      message({ type: "result", subtype: "success", is_error: false, result: "ok", structured_output: report("sin hallazgos"), total_cost_usd: 0, modelUsage: {} }),
    ]);
    const spec = { ...specFor(repo().dir, "review"), role: "review-bugs" };
    await (await recorder(query).start(spec)).result;

    expect(files(issueDir())).toEqual(["patches", "review-bugs.r1.review.yaml"]);
    const replayed = await replayer().start({ ...spec, cwd: repo().dir });
    expect((await replayed.result).structured).toEqual(report("sin hallazgos"));
  });

  test("un resume graba su propio guion, con el modo de su mensaje", async () => {
    const runtime = recorder(devRun());
    const first = await runtime.start(specFor(repo().dir));
    await first.result;
    const resumed = await runtime.resume(first.ref, `Corrige.\n\n${JSON.stringify(brief("fix", 2), null, 2)}`, { outputSchema, references: [] });
    await resumed.result;

    expect(files(issueDir()).filter((f) => f.endsWith(".yaml"))).toEqual(["dev.r1.implement.yaml", "dev.r2.fix.yaml"]);
  });
});

describe("fallos con la forma real", () => {
  test("tope de gasto tras entregar el reporte: el fake devuelve el mismo estado, mensaje y reporte", async () => {
    const query = queryOf(() => [
      init,
      turn("m1", [{ type: "tool_use", id: "t1", name: "StructuredOutput", input: report("a medias") }], { input: 1, output: 1 }),
      message({ type: "result", subtype: "error_max_budget_usd", is_error: true, errors: [], total_cost_usd: 1, modelUsage: totals }),
    ]);
    const run = await recorder(query).start(specFor(repo().dir));
    const result = await run.result;

    const replayed = await (await replayer().start(specFor(repo().dir))).result;
    expect(result.status).toBe("error_max_budget_usd");
    expect(replayed).toMatchObject({ status: "error_max_budget_usd", message: result.message, structured: report("a medias") });
  });

  test("login vencido: el fake devuelve login_expired con el mismo mensaje, sin rechazar", async () => {
    const query = queryOf(() => [
      init,
      message({ type: "assistant", error: "authentication_failed", message: { id: "m1", model: MODEL, content: [{ type: "text", text: "Failed to authenticate" }], usage: { input_tokens: 0, output_tokens: 0 } } }),
      message({ type: "result", subtype: "success", is_error: true, result: "Failed to authenticate. API Error: 401", total_cost_usd: 0, modelUsage: {} }),
    ]);
    const result = await (await recorder(query).start(specFor(repo().dir))).result;

    const replayed = await (await replayer().start(specFor(repo().dir))).result;
    expect(result.status).toBe("login_expired");
    expect(replayed).toMatchObject({ status: "login_expired", message: result.message });
  });

  test("el proceso muere con stderr: el guion es un crash con el mismo error y el stderr", async () => {
    const procs = createProcs({ store, bootId: "boot_now" });
    const query: QueryFn = ({ options }: { options: Options }) =>
      (async function* () {
        const child = options.spawnClaudeCodeProcess!({
          command: "sh",
          args: ["-c", "echo 'json-schema invalido' >&2; exit 1"],
          cwd: tmpdir(),
          env: {},
          signal: new AbortController().signal,
        });
        yield init;
        await new Promise((resolve) => (child as unknown as ChildProcess).stderr!.once("end", resolve));
        throw new Error("Claude Code process exited with code 1");
      })();
    const run = await recorder(query, { procs }).start(specFor(repo().dir, "implement", { stepRunId: "stp_1" }));
    const failure = await run.result.then(
      () => undefined,
      (error: Error) => error,
    );
    expect(failure?.message).toMatch(/exited with code 1\nstderr de claude: json-schema invalido/);

    const replayed = await replayer().start(specFor(repo().dir));
    await expect(replayed.result).rejects.toThrow(failure!.message);
  });
});

describe("lo que no se puede grabar", () => {
  test("un mensaje sin brief rechaza antes de lanzar Claude", async () => {
    let launched = false;
    const query: QueryFn = () => {
      launched = true;
      return (async function* () {})();
    };

    await expect(recorder(query).start(specFor(repo().dir, "implement", { prompt: "Haz lo tuyo." }))).rejects.toThrow(/no trae el brief/);
    expect(launched).toBe(false);
  });

  test("una llave privada en el patch no graba nada, y el run no se pierde: el error sale como evento", async () => {
    const query = queryOf((cwd) => {
      writeFileSync(join(cwd, "key.pem"), "-----BEGIN RSA PRIVATE KEY-----\nabc\n-----END RSA PRIVATE KEY-----\n");
      return [
        init,
        turn("m1", [{ type: "tool_use", id: "t1", name: "StructuredOutput", input: report("x") }], { input: 1, output: 1 }),
        message({ type: "result", subtype: "success", is_error: false, result: "ok", structured_output: report("x"), total_cost_usd: 0, modelUsage: {} }),
      ];
    });
    const run = await recorder(query).start(specFor(repo().dir));
    const [events, result] = [await drain(run), await run.result];

    expect(result.status).toBe("success");
    expect(events.find((e): e is Extract<AgentEvent, { type: "error" }> => e.type === "error")?.message).toMatch(/llave privada/);
    expect(existsSync(issueDir())).toBe(false);
  });
});


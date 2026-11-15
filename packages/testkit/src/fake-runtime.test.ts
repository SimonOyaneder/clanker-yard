import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, test } from "vitest";
import type { Brief, JsonSchema, Profile, Role } from "@clanker/api";
import {
  createAgents,
  createDefs,
  newId,
  openStore,
  selectRuntime,
  type AgentEvent,
  type AgentRun,
  type RunSpec,
  type Store,
} from "@clanker/core";
import { createFakeRuntime, type FakeRuntimeOptions } from "./fake-runtime";
import { tempGitRepo, type TempGitRepo } from "./git";

const demo = join(dirname(fileURLToPath(import.meta.url)), "../fixtures/runs/demo");

const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
});

/** Una carpeta de guiones temporal: ruta relativa -> contenido. */
function fixtures(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), "clanker-fake-"));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    writeFileSync(join(dir, path), content);
  }
  return dir;
}

const report = (summary: string) => `
result:
  status: success
  structured: { outcome: done, summary: "${summary}", payload: {} }
`;

const outputSchema: JsonSchema = {
  type: "object",
  properties: {
    outcome: { type: "string", enum: ["done", "changes"] },
    summary: { type: "string" },
    payload: { type: "object" },
  },
  required: ["outcome", "summary", "payload"],
};

function brief(mode: string, round = 1, issue?: string): Brief {
  return {
    run: { id: newId("run") as Brief["run"]["id"], subject: { type: "issue", id: "1" }, round, attempt: 1 },
    ...(issue ? { issue: { key: issue, title: "t", criteria: [] } } : {}),
    worktree: "/work/tree",
    base: "origin/main",
    mode,
    artifacts: {},
    payload: {},
  };
}

/** El mensaje como lo arma el core: instrucciones, línea en blanco y el brief. */
const message = (b: Brief) => `Haz lo tuyo.\n\n${JSON.stringify(b, null, 2)}`;

function spec(role: string, b: Brief, cwd = "/work/tree"): RunSpec {
  return {
    role,
    cwd,
    systemPrompt: "Eres un agente.",
    prompt: message(b),
    model: "sonnet",
    context: [],
    hooks: false,
    tools: "all",
    outputSchema,
  };
}

async function drain(run: AgentRun): Promise<AgentEvent[]> {
  const events: AgentEvent[] = [];
  for await (const event of run.events) events.push(event);
  return events;
}

const instant: FakeRuntimeOptions["sleep"] = async () => {};

async function summaryOf(runtime: ReturnType<typeof createFakeRuntime>, s: RunSpec): Promise<unknown> {
  const run = await runtime.start(s);
  return ((await run.result).structured as { summary: string }).summary;
}

describe("valores que salen del brief", () => {
  const withPayload = (payload: unknown): Brief => ({ ...brief("bot", 0), payload });

  test("un string $brief.<ruta> del reporte toma lo que el brief trae ahí, como el id de un ítem", async () => {
    const runtime = createFakeRuntime({
      fixtures: fixtures({
        "triage.r0.yaml": `
result:
  status: success
  structured: { outcome: done, summary: "$brief.payload.items.1.id", payload: { first: "$brief.payload.items.0", base: "$brief.base" } }
`,
      }),
      sleep: instant,
    });

    const run = await runtime.start(spec("triage", withPayload({ items: [{ id: "123" }, { id: "456" }] })));

    expect((await run.result).structured).toEqual({ outcome: "done", summary: "456", payload: { first: { id: "123" }, base: "origin/main" } });
  });

  test("una ruta que el brief no tiene es un error del fixture que dice cuál", async () => {
    const runtime = createFakeRuntime({
      fixtures: fixtures({ "triage.r0.yaml": `result:\n  status: success\n  structured: { outcome: done, summary: "$brief.payload.nada", payload: {} }\n` }),
      sleep: instant,
    });

    await expect(runtime.start(spec("triage", withPayload({})))).rejects.toThrow(/cita \$brief\.payload\.nada y el brief no lo tiene/);
  });
});

describe("elección del guion", () => {
  const dir = fixtures({
    "review-bugs.r1.yaml": report("cualquier modo"),
    "review-bugs.r1.review.yaml": `match: { mode: review }${report("modo review")}`,
    "review-bugs.r1.eng-1.yaml": `match: { mode: review, issue: ENG-1 }${report("issue ENG-1")}`,
    "review-bugs.r2.yaml": report("ronda 2"),
  });
  const runtime = createFakeRuntime({ fixtures: dir, sleep: instant });

  test("gana el guion que fija más campos de match", async () => {
    expect(await summaryOf(runtime, spec("review-bugs", brief("review", 1, "ENG-1")))).toBe("issue ENG-1");
    expect(await summaryOf(runtime, spec("review-bugs", brief("review", 1, "ENG-2")))).toBe("modo review");
    expect(await summaryOf(runtime, spec("review-bugs", brief("re-review", 1)))).toBe("cualquier modo");
  });

  test("la ronda sale del nombre del archivo", async () => {
    expect(await summaryOf(runtime, spec("review-bugs", brief("review", 2)))).toBe("ronda 2");
  });

  test("los guiones con times sirven en orden esa cantidad de veces y después cae al que no lo tiene", async () => {
    const series = createFakeRuntime({
      fixtures: fixtures({
        "dev.r1.a.yaml": `match: { mode: fix }\ntimes: 1${report("primera")}`,
        "dev.r1.b.yaml": `match: { mode: fix }\ntimes: 2${report("segunda y tercera")}`,
        "dev.r1.z.yaml": `match: { mode: fix }${report("el resto")}`,
      }),
      sleep: instant,
    });

    const answers = [];
    for (let i = 0; i < 5; i++) answers.push(await summaryOf(series, spec("dev", brief("fix", 1))));

    expect(answers).toEqual(["primera", "segunda y tercera", "segunda y tercera", "el resto", "el resto"]);
  });

  test("dos guiones igual de específicos son un error", async () => {
    const tied = createFakeRuntime({
      fixtures: fixtures({
        "dev.r1.plan.yaml": `match: { mode: plan }${report("a")}`,
        "dev.r1.otro.yaml": `match: { mode: plan }${report("b")}`,
      }),
      sleep: instant,
    });
    await expect(tied.start(spec("dev", brief("plan")))).rejects.toThrow(/2 guiones empatan para dev r1/);
  });

  test("sin guion hay un error explícito y no se inventa un reporte", async () => {
    await expect(runtime.start(spec("review-bugs", brief("review", 3)))).rejects.toThrow(
      /no hay fixture para review-bugs r3 \(modo review\)\. Guiones de ese rol: review-bugs\.r1\.eng-1\.yaml/,
    );
    await expect(runtime.start(spec("dev", brief("plan")))).rejects.toThrow(
      /no hay fixture para dev r1.*No hay guiones para ese rol/,
    );
  });

  test("un mensaje sin brief no permite elegir guion", async () => {
    await expect(runtime.start({ ...spec("review-bugs", brief("review")), prompt: "hola" })).rejects.toThrow(
      /necesita el brief/,
    );
  });
});

describe("guiones inválidos", () => {
  test("un reporte que no cumple el esquema del modo hace fallar el start", async () => {
    const runtime = createFakeRuntime({
      fixtures: fixtures({
        "review-bugs.r1.yaml": `
result:
  status: success
  structured: { outcome: "inventado", summary: "x" }
`,
      }),
    });
    await expect(runtime.start(spec("review-bugs", brief("review")))).rejects.toThrow(
      /review-bugs\.r1\.yaml entrega un reporte que no cumple el esquema del modo/,
    );
  });

  test("un campo desconocido, un nombre mal puesto o un archivo citado que no existe se detectan al cargar", () => {
    const load = (files: Record<string, string>) => () => createFakeRuntime({ fixtures: fixtures(files) });
    expect(load({ "dev.r1.yaml": `evnts: []${report("x")}` })).toThrow(/dev\.r1\.yaml no es válido/);
    expect(load({ "dev.yaml": report("x") })).toThrow(/no se llama <rol>\.r<n>\.yaml/);
    expect(load({ "dev.r1.yaml": `effects: [{ apply: nada.patch }]${report("x")}` })).toThrow(/nada\.patch, que no existe/);
    expect(() => createFakeRuntime({ fixtures: "/no/existe" })).toThrow(/No se pudo leer la carpeta/);
  });
});

describe("eventos, speed y crash", () => {
  const script = `
speed: 20
events:
  - { at: 0, text: "arranco" }
  - { at: 1000, tool: Read, input: { file_path: a.rb } }
  - { at: 3000, usage: { in: 6, out: 900, cacheWrite: 21000, costUsd: 0.5 } }
  - { at: 4000, usage: { in: 4, out: 100, cacheRead: 21000, costUsd: 0.25 } }
${report("ok")}`;

  test("los eventos del guion salen como AgentEvent y el uso del run es la suma de sus turnos", async () => {
    const runtime = createFakeRuntime({ fixtures: fixtures({ "dev.r1.yaml": script }), sleep: instant });
    const run = await runtime.start(spec("dev", brief("implement")));

    expect(run.ref).toEqual({ runtime: "fake", sessionId: "fake-1", cwd: "/work/tree" });
    const turn = (n: number, tokensIn: number, tokensOut: number, cacheRead: number, cacheWrite: number, usd: number) => ({
      type: "usage",
      turn: n,
      usage: {
        turns: 1,
        tokensIn,
        tokensOut,
        tokensCacheRead: cacheRead,
        tokensCacheWrite: cacheWrite,
        costMicros: usd * 1_000_000,
        costSource: "estimate",
      },
    });
    expect(await drain(run)).toEqual([
      { type: "text", text: "arranco" },
      { type: "tool_start", tool: "Read", detail: "a.rb" },
      { type: "tool_end", tool: "Read" },
      turn(1, 6, 900, 0, 21000, 0.5),
      turn(2, 4, 100, 21000, 0, 0.25),
    ]);
    expect((await run.result).usage).toEqual({
      turns: 2,
      tokensIn: 10,
      tokensOut: 1000,
      tokensCacheRead: 21000,
      tokensCacheWrite: 21000,
      costMicros: 750_000,
      costSource: "estimate",
    });
  });

  test("speed divide los tiempos grabados entre eventos", async () => {
    const waits: number[] = [];
    const sleep: FakeRuntimeOptions["sleep"] = async (ms) => void waits.push(ms);
    const runtime = createFakeRuntime({ fixtures: fixtures({ "dev.r1.yaml": script }), sleep });

    await (await runtime.start(spec("dev", brief("implement")))).result;

    // Brechas grabadas: 1000, 2000 y 1000 ms (la de 0 ms no espera), a 20x.
    expect(waits).toEqual([50, 100, 50]);
  });

  test("la opción speed pisa la del guion", async () => {
    const waits: number[] = [];
    const sleep: FakeRuntimeOptions["sleep"] = async (ms) => void waits.push(ms);
    const runtime = createFakeRuntime({ fixtures: fixtures({ "dev.r1.yaml": script }), speed: 1000, sleep });

    await (await runtime.start(spec("dev", brief("implement")))).result;

    expect(waits).toEqual([1, 2, 1]);
  });

  test("un crash a mitad de la sesión corta los eventos, cae a los at y rechaza el result", async () => {
    const waits: number[] = [];
    const sleep: FakeRuntimeOptions["sleep"] = async (ms) => void waits.push(ms);
    const runtime = createFakeRuntime({
      fixtures: fixtures({
        "dev.r1.yaml": `
speed: 10
events:
  - { at: 0, text: "uno" }
  - { at: 500, text: "dos" }
  - { at: 2000, text: "nunca" }
result: { status: crash, at: 1000 }
`,
      }),
      sleep,
    });
    const run = await runtime.start(spec("dev", brief("implement")));

    expect(await drain(run)).toEqual([
      { type: "text", text: "uno" },
      { type: "text", text: "dos" },
    ]);
    await expect(run.result).rejects.toThrow(/dev\.r1\.yaml simula una caída a los 1000 ms/);
    expect(waits).toEqual([50, 50]);
  });

  test("interrupt corta la espera y el run termina con error", async () => {
    const sleep: FakeRuntimeOptions["sleep"] = (_ms, signal) =>
      new Promise((resolve) => signal.addEventListener("abort", () => resolve()));
    const runtime = createFakeRuntime({ fixtures: fixtures({ "dev.r1.yaml": script }), sleep });
    const run = await runtime.start(spec("dev", brief("implement")));

    await run.interrupt();

    expect(await drain(run)).toEqual([{ type: "text", text: "arranco" }]);
    expect(await run.result).toMatchObject({ status: "error", message: "El run fue interrumpido." });
  });

  test("error_max_turns y error_max_budget_usd salen como el status del run, con mensaje", async () => {
    const runtime = createFakeRuntime({
      fixtures: fixtures({
        "dev.r1.yaml": `result: { status: error_max_turns }`,
        "dev.r2.yaml": `result: { status: error_max_budget_usd, message: "se acabó el presupuesto" }`,
      }),
      sleep: instant,
    });

    const first = await (await runtime.start(spec("dev", brief("implement", 1)))).result;
    const second = await (await runtime.start(spec("dev", brief("implement", 2)))).result;

    expect(first).toMatchObject({ status: "error_max_turns", message: expect.stringContaining("dev.r1.yaml") });
    expect(second).toMatchObject({ status: "error_max_budget_usd", message: "se acabó el presupuesto" });
  });
});

describe("effects y resultados de la receta", () => {
  let repo: TempGitRepo;
  afterEach(() => repo.cleanup());

  test("effects aplica el patch al worktree y run entrega los resultados de la receta en orden", async () => {
    repo = tempGitRepo({ commits: [{ message: "init", files: { "hello.txt": "hola\n" } }] });
    const runtime = createFakeRuntime({ fixtures: demo, speed: Infinity });

    const run = await runtime.start(spec("dev", brief("implement"), repo.dir));
    await run.result;

    expect(readFileSync(join(repo.dir, "hello.txt"), "utf8")).toBe("hola mundo\n");
    const { sessionId } = run.ref;
    expect(runtime.nextRecipeResult(sessionId, "test")).toEqual({
      ok: false,
      extract: 'FAIL hello.test.ts\n  esperaba "hola mundo" y llegó "hola"\n',
    });
    expect(runtime.nextRecipeResult(sessionId, "test")).toEqual({ ok: true });
    expect(() => runtime.nextRecipeResult(sessionId, "test")).toThrow(/No quedan resultados guionados para la receta "test"/);
    expect(() => runtime.nextRecipeResult(sessionId, "lint")).toThrow(/receta "lint"/);
  });

  test("un patch que no aplica rechaza el result con el patch y la causa", async () => {
    repo = tempGitRepo({ commits: [{ message: "init", files: { "hello.txt": "otra cosa\n" } }] });
    const runtime = createFakeRuntime({ fixtures: demo, speed: Infinity });

    const run = await runtime.start(spec("dev", brief("implement"), repo.dir));

    await expect(run.result).rejects.toThrow(/No se pudo aplicar .*hello\.patch/);
  });

  test("resume retoma la misma sesión con el guion de la ronda y suma sus resultados de receta", async () => {
    const runtime = createFakeRuntime({
      fixtures: fixtures({
        "dev.r1.yaml": `run: { test: [{ ok: false }] }${report("r1")}`,
        "dev.r2.yaml": `run: { test: [{ ok: true }] }${report("r2")}`,
      }),
      sleep: instant,
    });
    const first = await runtime.start(spec("dev", brief("fix", 1)));
    await first.result;

    const second = await runtime.resume(first.ref, message(brief("fix", 2)), { outputSchema });

    expect(second.ref).toEqual(first.ref);
    expect(((await second.result).structured as { summary: string }).summary).toBe("r2");
    expect(runtime.nextRecipeResult(first.ref.sessionId, "test")).toEqual({ ok: false });
    expect(runtime.nextRecipeResult(first.ref.sessionId, "test")).toEqual({ ok: true });
  });

  test("resume de una sesión que el fake no inició es un error", async () => {
    const runtime = createFakeRuntime({ fixtures: demo });
    await expect(
      runtime.resume({ runtime: "fake", sessionId: "fake-9", cwd: "/x" }, message(brief("fix")), { outputSchema }),
    ).rejects.toThrow(/no conoce la sesión fake-9/);
  });
});

describe("con el módulo Agents", () => {
  const open: Store[] = [];
  afterEach(() => {
    for (const store of open.splice(0)) store.close();
  });

  const role: Role = {
    prompt: "Revisas bugs.",
    context: [],
    modes: {
      review: {
        instructions: "Revisa el diff.",
        report: {
          type: "object",
          properties: { findings: { type: "array", items: { type: "object" } } },
          required: ["findings"],
        },
        outcomes: ["changes", "clean"],
        session: "new",
      },
    },
  };
  const profile: Profile = { roles: { "review-bugs": { model: "opus" } } };

  function setup(fixturesDir: string) {
    const store = openStore({ path: ":memory:" });
    open.push(store);
    const defs = createDefs(store);
    const runtime = selectRuntime([createFakeRuntime({ fixtures: fixturesDir, speed: Infinity })], {
      CORE_RUNTIME: "fake",
    });
    const agents = createAgents({ store, defs, runtime });
    defs.save({ kind: "role", slug: "review-bugs", scope: "user", body: role, source: "ui" });
    defs.save({ kind: "profile", slug: "default", scope: "user", body: profile, source: "ui" });
    return agents;
  }

  const request = (round: number) => ({
    role: "review-bugs",
    profile: "default",
    mode: "review",
    brief: brief("review", round, "ENG-9171"),
    workspace: "/work/tree",
  });

  test("CORE_RUNTIME=fake corre un guion de punta a punta y entrega el reporte validado", async () => {
    const result = await setup(demo).run(request(1));

    expect(result).toMatchObject({
      status: "success",
      report: { outcome: "changes", summary: "1 hallazgo amarillo" },
    });
  });

  test("sin guion para la ronda, run falla con el error del fake", async () => {
    await expect(setup(demo).run(request(2))).rejects.toThrow("no hay fixture para review-bugs r2");
  });

  test("un guion con reporte inválido para el modo hace fallar run", async () => {
    const agents = setup(
      fixtures({
        "review-bugs.r1.yaml": `
result:
  status: success
  structured: { outcome: changes, summary: "x", payload: { findings: "no es una lista" } }
`,
      }),
    );

    await expect(agents.run(request(1))).rejects.toThrow(/no cumple el esquema del modo/);
  });
});

describe("transcripts", () => {
  test("con `transcripts` deja un jsonl por sesión con mensajes del estilo del SDK de Claude", async () => {
    const transcripts = mkdtempSync(join(tmpdir(), "clanker-fake-transcripts-"));
    cleanups.push(() => rmSync(transcripts, { recursive: true, force: true }));
    const runtime = createFakeRuntime({
      fixtures: fixtures({
        "dev.r1.yaml": `
events:
  - { at: 0, text: "Leo" }
  - { at: 1, tool: Read, input: { file_path: "a.rb" }, output: "puts 1" }
${report("listo")}`,
      }),
      sleep: instant,
      transcripts,
    });

    const run = await runtime.start(spec("dev", brief("plan", 1)));
    await run.result;

    const records = readFileSync(join(transcripts, `${run.ref.sessionId}.jsonl`), "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as { type: string; message?: { content: { type: string }[] } });
    expect(records.map((r) => [r.type, r.message?.content[0]?.type])).toEqual([
      ["assistant", "text"],
      ["assistant", "tool_use"],
      ["user", "tool_result"],
      ["result", undefined],
    ]);
  });
});

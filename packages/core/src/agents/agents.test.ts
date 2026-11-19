import { execFileSync } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, test, vi } from "vitest";
import type { Brief, Profile, Role } from "@clanker/api";
import { createDefs } from "../defs/defs";
import { newId } from "../store/conventions";
import { agentSessions } from "../store/schema";
import { openStore, type Store } from "../store/store";
import {
  ACTIVITY_INTERVAL_MS,
  createAgents,
  HANDOFF_MAX_CHARS,
  WARM_MAX_CONTEXT_TOKENS,
  WARM_WINDOW_MS,
  type Agents,
} from "./agents";
import {
  createRuntimeRegistry,
  RuntimeUnavailableError,
  type AgentEvent,
  type AgentRun,
  type AgentRuntime,
  type ResumeSpec,
  type RunResult,
  type RunSpec,
  type SessionRef,
  type Usage,
} from "./runtime";

/** El plazo de un `vi.waitFor`: el default de 1 s no alcanza con la suite en paralelo y bajo carga. */
const WAIT = { timeout: 10_000 };

const open: Store[] = [];
afterEach(() => {
  for (const store of open.splice(0)) store.close();
});

const usage: Usage = {
  turns: 3,
  tokensIn: 10,
  tokensOut: 20,
  tokensCacheRead: 30,
  tokensCacheWrite: 40,
  costMicros: 500,
  costSource: "estimate",
};

const role: Role = {
  prompt: "Eres un analista.",
  context: [],
  modes: {
    audit: {
      instructions: "Audita el cambio.",
      payload: { type: "object", properties: { focus: { type: "string" } }, required: ["focus"] },
      report: {
        type: "object",
        properties: { findings: { type: "array", items: { type: "string" } } },
        required: ["findings"],
      },
      outcomes: ["clean", "findings"],
      session: "new",
      budget: { maxTurns: 40, maxUsd: 1 },
    },
    followup: {
      instructions: "Sigue con lo pendiente.",
      report: { type: "object", properties: { done: { type: "boolean" } }, required: ["done"] },
      outcomes: ["done"],
      session: "resume",
    },
    fix: {
      instructions: "Arregla lo que pidieron.",
      report: { type: "object", properties: { done: { type: "boolean" } }, required: ["done"] },
      outcomes: ["done"],
      session: "resume-if-warm",
    },
    learn: {
      instructions: "Aprende algo.",
      report: { type: "object", properties: { done: { type: "boolean" } }, required: ["done"] },
      outcomes: ["done"],
      session: "new",
      learnings: true,
    },
  },
};

const profile: Profile = {
  roles: {
    analyst: { model: "sonnet", effort: "high", budget: { maxUsd: 0.5 } },
    "analyst-opus": { model: "opus" },
  },
};

const validReport = { outcome: "findings", summary: "uno", payload: { findings: ["x"] } };

function brief(mode: string, payload: unknown = { focus: "bugs" }): Brief {
  return {
    run: {
      id: newId("run") as Brief["run"]["id"],
      subject: { type: "issue", id: "1" },
      round: 1,
      attempt: 1,
    },
    worktree: "/work/tree",
    base: "origin/main",
    mode,
    artifacts: {},
    payload,
  };
}

interface Step {
  /** Id de sesión que devuelve el runtime; por defecto uno nuevo por cada start o resume. */
  sessionId?: string;
  events?: () => AsyncIterable<AgentEvent>;
  /** Se llama cuando alguien interrumpe la sesión. */
  onInterrupt?: () => void;
  result: Partial<RunResult>;
}

/** Un runtime que responde lo guionado, en orden, y anota lo que le pidieron. */
function stubRuntime(steps: Step[], id: AgentRuntime["id"] = "fake") {
  const calls = {
    starts: [] as RunSpec[],
    resumes: [] as { ref: SessionRef; message: string; spec: ResumeSpec }[],
  };
  let n = 0;
  const next = (cwd: string): AgentRun => {
    const step = steps.shift();
    if (!step) throw new Error("el stub se quedó sin pasos guionados");
    const events = step.events ?? (async function* () {});
    return {
      ref: { runtime: id, sessionId: step.sessionId ?? `${id === "fake" ? "stub" : id}-${++n}`, cwd },
      events: events(),
      interrupt: async () => step.onInterrupt?.(),
      result: Promise.resolve({ status: "success", text: "", usage, ...step.result }),
    };
  };
  const runtime: AgentRuntime = {
    id,
    capabilities: { costPerTurn: true },
    async start(spec) {
      calls.starts.push(spec);
      return next(spec.cwd);
    },
    async resume(ref, message, spec) {
      calls.resumes.push({ ref, message, spec });
      return next(ref.cwd);
    },
  };
  return { runtime, calls };
}

function setup(steps: Step[], now?: () => number, prefixWaitMs?: number) {
  const store = openStore({ path: ":memory:" });
  open.push(store);
  const defs = createDefs({ store });
  const stub = stubRuntime(steps);
  const agents: Agents = createAgents({ store, defs, runtimes: createRuntimeRegistry([stub.runtime], {}), now, prefixWaitMs });
  defs.save({ kind: "role", slug: "analyst", scope: "user", body: role, source: "ui" });
  defs.save({ kind: "profile", slug: "default", scope: "user", body: profile, source: "ui" });
  return { store, defs, agents, ...stub };
}

const request = (mode = "audit") => ({
  role: "analyst",
  profile: "default",
  mode,
  brief: brief(mode),
  workspace: "/work/tree",
});

describe("run", () => {
  test("un reporte válido se guarda en la sesión y emite started y ended", async () => {
    const { store, agents, calls } = setup([{ result: { structured: validReport } }]);

    const result = await agents.run(request());

    expect(result).toMatchObject({ status: "success", report: validReport });
    const [session] = store.db.select().from(agentSessions).all();
    expect(session).toMatchObject({
      id: result.sessionId,
      runtime: "fake",
      sessionRef: "stub-1",
      status: "success",
      report: validReport,
      model: "sonnet",
      effort: "high",
      cwd: "/work/tree",
      resumedFrom: null,
      turns: 3,
      costMicros: 500,
      costSource: "estimate",
    });
    expect(calls.resumes).toHaveLength(0);
    expect(store.events.since(0).map((e) => [e.type, e.payload])).toEqual([
      ["def.versioned", expect.anything()],
      ["def.versioned", expect.anything()],
      ["agent.started", { sessionId: result.sessionId, role: "analyst", model: "sonnet" }],
      ["agent.ended", { sessionId: result.sessionId, status: "success" }],
    ]);
  });

  test("solo un modo con learnings los pide en el prompt y el esquema, y su reporte los conserva", async () => {
    const withLearning = { outcome: "done", summary: "ok", learnings: [{ text: "Usa `x`", scope: "repo" }], payload: { done: true } };
    const { agents, calls } = setup([{ result: { structured: withLearning } }, { result: { structured: withLearning } }]);

    const proposing = await agents.run({ ...request(), brief: brief("learn", {}), mode: "learn" });
    const quiet = await agents.run({ ...request(), brief: brief("fix", {}), mode: "fix" });

    expect(calls.starts[0]?.prompt).toContain("máximo 1 por corrida; si dudas, no lo propongas");
    expect(calls.starts[0]?.outputSchema.properties).toHaveProperty("learnings");
    expect(calls.starts[1]?.prompt).not.toContain("Learnings (`learnings` del reporte)");
    expect(calls.starts[1]?.outputSchema.properties).not.toHaveProperty("learnings");
    expect(proposing).toMatchObject({ status: "success", report: { learnings: [{ text: "Usa `x`", scope: "repo" }] } });
    // Un modelo que los manda sin que se los pidan: no cuentan.
    expect(quiet).toMatchObject({ status: "success", report: { learnings: undefined } });
  });

  test("el prompt del rol va como sistema, el modo y el brief en el mensaje, y el reporte como JSON Schema", async () => {
    const { agents, calls } = setup([{ result: { structured: validReport } }]);
    const req = request();

    await agents.run(req);

    const [spec] = calls.starts;
    expect(spec).toMatchObject({
      role: "analyst",
      cwd: "/work/tree",
      systemPrompt: "Eres un analista.",
      model: "sonnet",
      effort: "high",
      hooks: false,
      tools: "all",
      maxTurns: 40,
      maxBudgetUsd: 0.5,
    });
    expect(spec?.prompt).toContain("Audita el cambio.");
    expect(spec?.prompt).toContain(req.brief.run.id);
    expect(spec?.prompt).not.toContain("Eres un analista.");
    expect(spec?.outputSchema).toMatchObject({
      type: "object",
      required: expect.arrayContaining(["outcome", "summary", "payload"]),
      properties: {
        outcome: { type: "string", enum: ["clean", "findings"] },
        payload: role.modes.audit?.report,
        summary: { type: "string" },
      },
    });
  });

  test("un reporte inválido dispara exactamente un resume con el error y el segundo válido se guarda", async () => {
    const { store, agents, calls } = setup([
      { result: { structured: { outcome: "findings", summary: "x", payload: { findings: "no-es-lista" } } } },
      { result: { structured: validReport } },
    ]);

    const result = await agents.run(request());

    expect(result).toMatchObject({ status: "success", report: validReport });
    expect(calls.resumes).toHaveLength(1);
    expect(calls.resumes[0]?.ref).toEqual({ runtime: "fake", sessionId: "stub-1", cwd: "/work/tree" });
    expect(calls.resumes[0]?.message).toMatch(/^tu reporte no cumple el esquema: .*payload\.findings/);
    expect(calls.resumes[0]?.spec.outputSchema).toEqual(calls.starts[0]?.outputSchema);

    const [first, second] = store.db.select().from(agentSessions).orderBy(agentSessions.id).all();
    expect(first).toMatchObject({ status: "report_invalid", report: null, resumedFrom: null });
    expect(first?.error).toContain("payload.findings");
    expect(second).toMatchObject({ status: "success", resumedFrom: first?.id, id: result.sessionId });
  });

  test("un segundo reporte inválido termina en error sin otro reintento", async () => {
    const bad = { outcome: "findings", summary: "x", payload: {} };
    const { agents, calls } = setup([{ result: { structured: bad } }, { result: { structured: bad } }]);

    const result = await agents.run(request());

    expect(result).toMatchObject({ status: "report_invalid" });
    expect(result.status === "success" ? "" : result.message).toContain("payload.findings");
    expect(calls.resumes).toHaveLength(1);
  });

  test("un outcome fuera de los del modo no valida", async () => {
    const { agents, calls } = setup([
      { result: { structured: { ...validReport, outcome: "otro" } } },
      { result: { structured: validReport } },
    ]);

    await agents.run(request());

    expect(calls.resumes[0]?.message).toContain("outcome");
  });

  test("un agente que termina sin reporte estructurado se trata como reporte inválido", async () => {
    const { agents, calls } = setup([{ result: {} }, { result: { structured: validReport } }]);

    await agents.run(request());

    expect(calls.resumes[0]?.message).toContain("sin devolver un reporte estructurado");
  });

  test("login vencido y cuota agotada terminan sin reintento y se distinguen", async () => {
    const login = setup([{ result: { status: "login_expired", message: "corre `claude auth login`" } }]);
    const quota = setup([{ result: { status: "quota_exhausted", resetsAt: 1_800_000_000_000 } }]);

    const a = await login.agents.run(request());
    const b = await quota.agents.run(request());

    expect(a).toMatchObject({ status: "login_expired", message: "corre `claude auth login`" });
    expect(b).toMatchObject({ status: "quota_exhausted", resetsAt: 1_800_000_000_000 });
    expect(login.calls.resumes).toHaveLength(0);
    expect(quota.calls.resumes).toHaveLength(0);
    expect(login.store.db.select().from(agentSessions).get()?.status).toBe("login_expired");
    expect(quota.store.events.since(0).at(-1)).toMatchObject({
      type: "agent.ended",
      payload: { status: "quota_exhausted" },
    });
  });

  test("si el runtime rechaza, la sesión queda en error con el motivo", async () => {
    const { store, agents } = setup([
      {
        result: {},
        events: () => ({
          [Symbol.asyncIterator]: () => ({
            next: () => Promise.reject(new Error("se cayó el proceso")),
          }),
        }),
      },
    ]);

    const result = await agents.run(request());

    expect(result).toMatchObject({ status: "error" });
    expect(store.db.select().from(agentSessions).get()).toMatchObject({
      status: "error",
      error: expect.stringContaining("se cayó el proceso"),
    });
  });

  test("un tope del perfil pisa al del modo campo por campo", async () => {
    const { agents, calls } = setup([{ result: { structured: validReport } }]);

    await agents.run(request());

    expect(calls.starts[0]).toMatchObject({ maxTurns: 40, maxBudgetUsd: 0.5 });
  });

  describe("tope de gasto", () => {
    const eventsOf = (store: Store, scope: string) =>
      store.events.since(0).filter((e) => e.type === "error" && e.payload.scope === scope);

    test("un reporte entregado antes de cruzar el tope se usa y deja un aviso", async () => {
      const { store, agents } = setup([
        { result: { status: "error_max_budget_usd", message: "El agente llegó al tope de gasto.", structured: validReport } },
      ]);

      const result = await agents.run(request());

      expect(result).toMatchObject({ status: "success", report: validReport });
      expect(store.db.select().from(agentSessions).get()).toMatchObject({ status: "success", report: validReport, error: null });
      expect(eventsOf(store, "agent.budget")).toMatchObject([
        { payload: { message: expect.stringContaining("después de entregar su reporte") } },
      ]);
    });

    test("sin reporte, o con uno que no cumple el esquema, sigue siendo error_max_budget_usd", async () => {
      const bare = setup([{ result: { status: "error_max_budget_usd", message: "tope" } }]);
      expect(await bare.agents.run(request())).toMatchObject({ status: "error_max_budget_usd", message: "tope" });

      const invalid = setup([{ result: { status: "error_max_budget_usd", message: "tope", structured: { outcome: "nope" } } }]);
      expect(await invalid.agents.run(request())).toMatchObject({ status: "error_max_budget_usd", message: "tope" });
      expect(eventsOf(invalid.store, "agent.budget")).toEqual([]);
    });

    test("un tope menor que escribir el prefijo en la caché avisa al lanzar, una sola vez por run", async () => {
      const { store, defs, agents } = setup([
        { result: { structured: validReport } },
        { result: { structured: { outcome: "done", summary: "ok", payload: { done: true } } } },
      ]);
      defs.save({
        kind: "profile",
        slug: "default",
        scope: "user",
        body: { roles: { analyst: { model: "sonnet", budget: { maxUsd: 0.05 } } } },
        source: "ui",
      });

      const first = await agents.run(request());
      await agents.resume({ sessionId: first.sessionId, profile: "default", mode: "followup", brief: brief("followup") });

      expect(eventsOf(store, "agent.budget")).toMatchObject([
        { payload: { message: expect.stringMatching(/USD 0\.05.*"analyst".*sonnet.*mínimo útil de USD 0\.13/) } },
      ]);
    });

    test("un tope suficiente no avisa", async () => {
      const { store, agents } = setup([{ result: { structured: validReport } }]);

      await agents.run(request());

      expect(eventsOf(store, "agent.budget")).toEqual([]);
    });
  });

  test("falla con un mensaje accionable si falta el rol, el modo, el perfil o el payload es inválido", async () => {
    const { agents } = setup([]);

    await expect(agents.run({ ...request(), role: "nadie" })).rejects.toThrow('No existe el rol "nadie"');
    await expect(agents.run({ ...request(), mode: "x", brief: brief("x") })).rejects.toThrow(
      /no tiene el modo "x" \(tiene: audit, followup, fix, learn\)/,
    );
    await expect(agents.run({ ...request(), profile: "nadie" })).rejects.toThrow('No existe el perfil "nadie"');
    await expect(agents.run({ ...request(), brief: brief("audit", { focus: 1 }) })).rejects.toThrow(
      /payload del brief no cumple.*focus/s,
    );
    await expect(agents.run({ ...request(), brief: brief("followup") })).rejects.toThrow(
      /brief es del modo "followup"/,
    );
  });
});

describe("resume", () => {
  test("retoma la sesión con otro modo, con el modelo de la sesión y el esquema del nuevo modo", async () => {
    const { store, agents, calls } = setup([
      { result: { structured: validReport } },
      { result: { structured: { outcome: "done", summary: "listo", payload: { done: true } } } },
    ]);
    const first = await agents.run(request());

    const second = await agents.resume({
      sessionId: first.sessionId,
      profile: "default",
      mode: "followup",
      brief: brief("followup"),
    });

    expect(second).toMatchObject({ status: "success", report: { outcome: "done" } });
    expect(calls.resumes[0]?.ref.sessionId).toBe("stub-1");
    expect(calls.resumes[0]?.message).toContain("Sigue con lo pendiente.");
    expect(calls.resumes[0]?.spec.outputSchema).toMatchObject({
      properties: { outcome: { enum: ["done"] } },
    });
    const rows = store.db.select().from(agentSessions).all();
    expect(rows.find((r) => r.id === second.sessionId)).toMatchObject({
      resumedFrom: first.sessionId,
      model: "sonnet",
    });
  });

  test("si el runtime retoma con el mismo id, es la misma fila y el uso se suma", async () => {
    const { store, agents } = setup([
      { sessionId: "fija", result: { structured: validReport } },
      { sessionId: "fija", result: { structured: { outcome: "done", summary: "", payload: { done: true } } } },
    ]);
    const first = await agents.run(request());

    const second = await agents.resume({
      sessionId: first.sessionId,
      profile: "default",
      mode: "followup",
      brief: brief("followup"),
    });

    expect(second.sessionId).toBe(first.sessionId);
    const rows = store.db.select().from(agentSessions).all();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ turns: 6, costMicros: 1000, status: "success" });
  });

  test("una sesión de otro runtime no se retoma con el actual", async () => {
    const { store, agents, calls } = setup([{ result: { structured: validReport } }]);
    const first = await agents.run(request());
    store.db.update(agentSessions).set({ runtime: "opencode" }).run();

    await expect(
      agents.resume({
        sessionId: first.sessionId,
        profile: "default",
        mode: "followup",
        brief: brief("followup"),
      }),
    ).rejects.toThrow(`La sesión ${first.sessionId} es del runtime "opencode"`);
    expect(calls.resumes).toEqual([]);
  });

  test("una sesión que no existe falla con su id", async () => {
    const { agents } = setup([]);

    await expect(
      agents.resume({ sessionId: "ses_nope", profile: "default", mode: "audit", brief: brief("audit") }),
    ).rejects.toThrow("No existe la sesión ses_nope");
  });
});

describe("sesión previa y versiones fijadas", () => {
  test("resumeFrom retoma la sesión solo si el modo no es `new`", async () => {
    const { agents, calls } = setup([
      { result: { structured: validReport } },
      { result: { structured: { outcome: "done", summary: "listo", payload: { done: true } } } },
      { result: { structured: validReport } },
    ]);
    const first = await agents.run(request());

    const resumed = await agents.run({ ...request("followup"), resumeFrom: first.sessionId });
    const fresh = await agents.run({ ...request("audit"), resumeFrom: first.sessionId });

    expect(resumed).toMatchObject({ status: "success", report: { outcome: "done" } });
    expect(fresh.status).toBe("success");
    expect(calls.resumes.map((r) => r.ref.sessionId)).toEqual(["stub-1"]);
    expect(calls.starts).toHaveLength(2);
  });

  test("roleDef y profileDef fijan la versión aunque se guarde otra", async () => {
    const { defs, agents, calls } = setup([{ result: { structured: validReport } }]);
    const roleDef = defs.resolve("role", "analyst");
    const profileDef = defs.resolve("profile", "default");
    if (!roleDef || !profileDef) throw new Error("falta el rol o el perfil de prueba");
    defs.save({ kind: "role", slug: "analyst", scope: "user", body: { ...role, prompt: "Eres otro." }, source: "ui" });
    defs.save({
      kind: "profile",
      slug: "default",
      scope: "user",
      body: { roles: { analyst: { model: "opus" } } },
      source: "ui",
    });

    await agents.run({
      ...request(),
      roleDef: { id: roleDef.id, version: roleDef.version },
      profileDef: { id: profileDef.id, version: profileDef.version },
    });

    expect(calls.starts[0]).toMatchObject({ systemPrompt: "Eres un analista.", model: "sonnet" });
  });
});

describe("política de sesión", () => {
  const MIN = 60_000;
  const dirs: string[] = [];
  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  /** Un repo real con un commit y un archivo modificado después: el `git diff --stat` del handoff sale de ahí. */
  function repoWithChange(): string {
    const dir = mkdtempSync(join(tmpdir(), "agents-session-"));
    dirs.push(dir);
    const git = (...args: string[]) =>
      execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], { cwd: dir, stdio: "pipe" });
    git("init", "-q", "-b", "main");
    writeFileSync(join(dir, "a.ts"), "uno\n");
    git("add", ".");
    git("commit", "-q", "-m", "base");
    writeFileSync(join(dir, "a.ts"), "uno\ndos\ntres\n");
    return dir;
  }

  /** Un turno del modelo con el contexto que pesa `context` tokens, del que sale cuán grande es la sesión. */
  const turn = (context: number): AgentEvent => ({
    type: "usage",
    turn: 1,
    usage: { ...usage, turns: 1, tokensIn: 1, tokensOut: 1, tokensCacheRead: context - 11, tokensCacheWrite: 10 },
  });

  const done: Step = { result: { structured: { outcome: "done", summary: "listo", payload: { done: true } } } };

  /** Corre la sesión previa (modo `audit`, sesión nueva) a la hora `at` y deja el reloj ahí. */
  async function afterFirst(opts: { context?: number; events?: AgentEvent[]; cacheTtl?: "1h"; report?: unknown; later?: Step[] } = {}) {
    const clock = { t: 1_000_000 };
    const workspace = repoWithChange();
    const env = setup(
      [
        {
          result: { structured: opts.report ?? validReport },
          events: async function* () {
            for (const e of opts.events ?? [turn(opts.context ?? 20_000)]) yield e;
          },
        },
        ...(opts.later ?? [done, done, done]),
      ],
      () => clock.t,
    );
    const profileName = opts.cacheTtl === undefined ? "default" : "lento";
    if (opts.cacheTtl) {
      env.defs.save({
        kind: "profile",
        slug: "lento",
        scope: "user",
        body: { roles: { analyst: { model: "sonnet", cacheTtl: opts.cacheTtl } } },
        source: "ui",
      });
    }
    const first = await env.agents.run({ ...request(), profile: profileName, workspace });
    const next = (mode: string) => ({
      ...request(mode),
      profile: profileName,
      brief: { ...brief(mode), base: "HEAD" },
      workspace,
      resumeFrom: first.sessionId,
    });
    return { ...env, clock, first, next };
  }

  test("new ignora resumeFrom: sesión nueva y sin handoff", async () => {
    const { agents, calls, next } = await afterFirst({ later: [{ result: { structured: validReport } }] });

    await agents.run(next("audit"));

    expect(calls.resumes).toHaveLength(0);
    expect(calls.starts).toHaveLength(2);
    expect(calls.starts[1]?.prompt).not.toContain("Handoff");
  });

  test("resume retoma desde resumeFrom aunque la caché esté fría y el contexto sea enorme", async () => {
    const { agents, calls, clock, next } = await afterFirst({ context: 150_000 });
    clock.t += 60 * MIN;

    await agents.run(next("followup"));

    expect(calls.starts).toHaveLength(1);
    expect(calls.resumes.map((r) => r.ref.sessionId)).toEqual(["stub-1"]);
    expect(calls.resumes[0]?.message).not.toContain("Handoff");
  });

  test("resume-if-warm retoma con la caché caliente: menos de 4 min y menos de 80k", async () => {
    const { agents, calls, clock, next } = await afterFirst({ context: WARM_MAX_CONTEXT_TOKENS - 1 });
    clock.t += WARM_WINDOW_MS["5m"] - 1;

    await agents.run(next("fix"));

    expect(calls.starts).toHaveLength(1);
    expect(calls.resumes.map((r) => r.ref.sessionId)).toEqual(["stub-1"]);
  });

  test("resume-if-warm en frío abre una sesión nueva con handoff: reporte anterior y git diff --stat", async () => {
    const { store, agents, calls, clock, first, next } = await afterFirst();
    clock.t += WARM_WINDOW_MS["5m"];

    const result = await agents.run(next("fix"));

    expect(result.status).toBe("success");
    expect(calls.resumes).toHaveLength(0);
    expect(calls.starts).toHaveLength(2);
    const prompt = calls.starts[1]?.prompt ?? "";
    expect(prompt).toContain("respondió por última vez hace 4 min");
    expect(prompt).toContain("Reporte (findings): uno");
    expect(prompt).toContain('"x"');
    expect(prompt).toMatch(/Cambios contra HEAD \(git diff --stat\):\na\.ts \| 2 \+\+/);
    expect(prompt.indexOf("Handoff")).toBeLessThan(prompt.indexOf("Arregla lo que pidieron."));
    expect(calls.starts[1]?.systemPrompt).toBe(role.prompt);
    expect(store.db.select().from(agentSessions).all()).toHaveLength(2);
    expect(result.sessionId).not.toBe(first.sessionId);
  });

  test("resume-if-warm con 80k de contexto o más es frío aunque la última respuesta sea de ahora", async () => {
    const { agents, calls, next } = await afterFirst({ context: WARM_MAX_CONTEXT_TOKENS });

    await agents.run(next("fix"));

    expect(calls.resumes).toHaveLength(0);
    expect(calls.starts[1]?.prompt).toContain("su contexto pesa 80k tokens");
  });

  test("resume-if-warm sin ningún turno registrado no puede probar que la caché esté caliente", async () => {
    const { agents, calls, next } = await afterFirst({ events: [] });

    await agents.run(next("fix"));

    expect(calls.resumes).toHaveLength(0);
    expect(calls.starts[1]?.prompt).toContain("no registró ningún turno");
  });

  test("con cacheTtl 1h del perfil la caché sigue caliente pasados los 4 min, y el TTL llega al retomar", async () => {
    const { agents, calls, clock, next } = await afterFirst({ cacheTtl: "1h" });
    clock.t += 30 * MIN;

    await agents.run(next("fix"));
    expect(calls.resumes).toHaveLength(1);
    expect(calls.resumes[0]?.spec.cacheTtl).toBe("1h");

    clock.t += WARM_WINDOW_MS["1h"];
    await agents.run({ ...next("fix"), brief: { ...brief("fix"), base: "HEAD" } });
    expect(calls.resumes).toHaveLength(1);
    expect(calls.starts).toHaveLength(2);
  });

  test("una sesión compactada no se retoma con ninguna política: la ronda siguiente va nueva con handoff", async () => {
    const { store, agents, calls, first, next } = await afterFirst({ events: [turn(20_000), { type: "compaction" }] });

    expect(store.db.select().from(agentSessions).get()).toMatchObject({ id: first.sessionId, compactions: 1 });
    await agents.run(next("fix"));
    await agents.run(next("followup"));

    expect(calls.resumes).toHaveLength(0);
    expect(calls.starts).toHaveLength(3);
    expect(calls.starts[1]?.prompt).toContain("la sesión anterior de esta tarea se compactó");
    expect(calls.starts[2]?.prompt).toContain("se compactó");
  });

  test("el handoff se acota a ~15k tokens", async () => {
    const huge = { ...validReport, payload: { findings: ["x".repeat(HANDOFF_MAX_CHARS * 2)] } };
    const { agents, calls, clock, next } = await afterFirst({ report: huge });
    clock.t += 10 * MIN;

    await agents.run(next("fix"));

    const prompt = calls.starts[1]?.prompt ?? "";
    expect(prompt).toContain("truncado");
    expect(prompt.length).toBeLessThan(HANDOFF_MAX_CHARS + 5_000);
  });

  test("si git falla, el handoff lo dice y la corrida lo avisa; el agente corre igual", async () => {
    const { store, agents, calls, clock, next } = await afterFirst();
    clock.t += 10 * MIN;

    const result = await agents.run({ ...next("fix"), workspace: "/no/existe" });

    expect(result.status).toBe("success");
    expect(calls.starts[1]?.prompt).toContain("(no se pudo calcular:");
    const errors = store.events.since(0, { types: ["error"] }).filter((e) => e.payload.scope === "agent.handoff");
    expect(errors).toHaveLength(1);
  });
});

describe("prefijo compartido", () => {
  const deferred = () => {
    let resolve!: () => void;
    const promise = new Promise<void>((r) => (resolve = r));
    return { promise, resolve };
  };
  /** Deja correr todo lo que ya puede correr sin esperar nada externo. */
  const settleMicrotasks = () => new Promise<void>((r) => setImmediate(r));

  /** Un paso que anota cuándo parte su sesión y, si `until`, no emite su primer token hasta que se cumpla. */
  const stepOf = (name: string, log: string[], until?: Promise<void>): Step => ({
    result: { structured: validReport },
    events: () => {
      log.push(`parte ${name}`);
      return (async function* () {
        await until;
        log.push(`primer token ${name}`);
        yield { type: "first_token" } as const;
      })();
    },
  });

  test("las ramas con el mismo prefijo parten recién cuando la primera emite su primer token", async () => {
    const log: string[] = [];
    const firstToken = deferred();
    const { agents } = setup([stepOf("A", log, firstToken.promise), stepOf("B", log), stepOf("C", log)]);

    const runs = [agents.run(request()), agents.run(request()), agents.run(request())];
    await vi.waitFor(() => expect(log).toEqual(["parte A"]), WAIT);
    await settleMicrotasks();
    expect(log).toEqual(["parte A"]);
    firstToken.resolve();
    const results = await Promise.all(runs);

    expect(results.map((r) => r.status)).toEqual(["success", "success", "success"]);
    expect(log).toEqual(["parte A", "primer token A", "parte B", "parte C", "primer token B", "primer token C"]);
  });

  test("si la primera termina sin emitir nada, las demás parten igual", async () => {
    const log: string[] = [];
    const { agents } = setup([
      { result: { structured: validReport }, events: () => (log.push("parte A"), (async function* () {})()) },
      stepOf("B", log),
    ]);

    await Promise.all([agents.run(request()), agents.run(request())]);

    expect(log).toEqual(["parte A", "parte B", "primer token B"]);
  });

  test("si la primera no responde en prefixWaitMs, las demás parten igual", async () => {
    const log: string[] = [];
    const firstToken = deferred();
    const { agents } = setup([stepOf("A", log, firstToken.promise), stepOf("B", log)], undefined, 50);

    const a = agents.run(request());
    const b = agents.run(request());

    await vi.waitFor(() => expect(log).toEqual(["parte A", "parte B", "primer token B"]), WAIT);
    firstToken.resolve();
    await Promise.all([a, b]);
  });

  test("otro modelo es otro prefijo: no espera", async () => {
    const log: string[] = [];
    const firstToken = deferred();
    const { agents } = setup([stepOf("A", log, firstToken.promise), stepOf("B", log)]);

    const a = agents.run(request());
    const b = agents.run({ ...request(), profileRole: "analyst-opus" });
    await vi.waitFor(() => expect(log).toContain("primer token B"), WAIT);
    expect(log[0]).toBe("parte A");
    firstToken.resolve();
    await Promise.all([a, b]);
  });

  test("un paso cancelado no se queda esperando el primer token de otro", async () => {
    const log: string[] = [];
    const firstToken = deferred();
    const { agents } = setup([stepOf("A", log, firstToken.promise), stepOf("B", log)]);

    const a = agents.run(request());
    await vi.waitFor(() => expect(log).toEqual(["parte A"]), WAIT);
    const controller = new AbortController();
    const b = agents.run({ ...request(), signal: controller.signal });
    await settleMicrotasks();
    expect(log).toEqual(["parte A"]);
    controller.abort();
    await vi.waitFor(() => expect(log).toContain("parte B"), WAIT);
    firstToken.resolve();
    await Promise.all([a, b]);
  });
});

describe("signal", () => {
  test("abortar la señal interrumpe la sesión, esté ya abortada o se aborte con el agente corriendo", async () => {
    const interrupts: string[] = [];
    const during = new AbortController();
    const { agents } = setup([
      { result: { structured: validReport }, onInterrupt: () => interrupts.push("antes") },
      {
        result: { structured: validReport },
        onInterrupt: () => interrupts.push("durante"),
        events: async function* () {
          during.abort();
        },
      },
    ]);

    await agents.run({ ...request(), signal: AbortSignal.abort() });
    await agents.run({ ...request(), signal: during.signal });

    expect(interrupts).toEqual(["antes", "durante"]);
  });
});

describe("agent.activity", () => {
  test("sale como máximo una vez cada 2 s por sesión", async () => {
    const clock = { t: 10_000 };
    const toolAt = (ms: number, tool: string): AgentEvent => {
      clock.t = ms;
      return { type: "tool_start", tool, detail: `d-${tool}` };
    };
    const { store, agents } = setup(
      [
        {
          result: { structured: validReport },
          events: async function* () {
            yield toolAt(10_000, "Read");
            yield toolAt(10_000 + ACTIVITY_INTERVAL_MS - 1, "Grep");
            yield { type: "text", text: "pensando" };
            yield toolAt(10_000 + ACTIVITY_INTERVAL_MS, "Bash");
            yield toolAt(10_000 + ACTIVITY_INTERVAL_MS + 100, "Edit");
          },
        },
      ],
      () => clock.t,
    );

    await agents.run(request());

    const activity = store.events.since(0, { types: ["agent.activity"] });
    expect(activity.map((e) => e.payload)).toEqual([
      expect.objectContaining({ tool: "Read", detail: "d-Read" }),
      expect.objectContaining({ tool: "Bash", detail: "d-Bash" }),
    ]);
  });
});

describe("contexto del rol", () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  /** Un worktree real con el AGENTS.md dado; el rol pide ese archivo, otro que no existe y un paquete que tampoco. */
  function withContext(steps: Step[], agentsMd = "reglas v1") {
    const worktree = mkdtempSync(join(tmpdir(), "agents-context-"));
    dirs.push(worktree);
    writeFileSync(join(worktree, "AGENTS.md"), agentsMd);
    const env = setup(steps);
    env.defs.save({
      kind: "role",
      slug: "analyst",
      scope: "user",
      body: {
        ...role,
        context: [
          { kind: "repo", files: ["AGENTS.md", "lore/core_patterns.md"] },
          { kind: "pack", id: "lore" },
        ],
      },
      source: "ui",
    });
    return { ...env, worktree, request: () => ({ ...request(), workspace: worktree }) };
  }

  const warnings = (store: Store) =>
    store.events.since(0, { types: ["error"] }).filter((e) => e.payload.scope === "agent.context");

  test("un archivo o paquete que falta avisa en la corrida y el agente corre igual con lo demás", async () => {
    const { store, agents, calls, request } = withContext([{ result: { structured: validReport } }]);
    const req = request();

    const result = await agents.run(req);

    expect(result.status).toBe("success");
    expect(calls.starts[0]?.references).toEqual([{ label: "AGENTS.md", content: "reglas v1" }]);
    expect(warnings(store).map((e) => [e.runId, e.payload.message])).toEqual([
      [req.brief.run.id, expect.stringContaining('el paquete de contexto "lore"')],
      [req.brief.run.id, expect.stringContaining("lore/core_patterns.md")],
    ]);
  });

  test("cada aviso sale una vez por corrida aunque la corrida lance varios pasos, y otra corrida vuelve a avisar", async () => {
    const { store, agents, request } = withContext([
      { result: { structured: validReport } },
      { result: { structured: validReport } },
      { result: { structured: validReport } },
    ]);
    const req = request();

    await agents.run(req);
    await agents.run(req);
    expect(warnings(store)).toHaveLength(2);

    const other = request();
    await agents.run(other);
    expect(warnings(store).map((e) => e.runId)).toEqual([req.brief.run.id, req.brief.run.id, other.brief.run.id, other.brief.run.id]);
  });

  test("retomar la sesión vuelve a leer el archivo: lo editado vale desde ese lanzamiento", async () => {
    const { agents, calls, request, worktree } = withContext([
      { result: { structured: validReport } },
      { result: { structured: { outcome: "done", summary: "ok", payload: { done: true } } } },
    ]);
    const first = await agents.run(request());

    writeFileSync(join(worktree, "AGENTS.md"), "reglas v2");
    await agents.resume({ sessionId: first.sessionId, profile: "default", mode: "followup", brief: brief("followup") });

    expect(calls.resumes[0]?.spec.references).toEqual([{ label: "AGENTS.md", content: "reglas v2" }]);
  });

  test("el reintento por un reporte inválido reusa lo resuelto y no avisa otra vez", async () => {
    const bad = { outcome: "findings", summary: "x", payload: {} };
    const { store, agents, calls, request } = withContext([{ result: { structured: bad } }, { result: { structured: validReport } }]);

    await agents.run(request());

    expect(calls.resumes[0]?.spec.references).toEqual(calls.starts[0]?.references);
    expect(warnings(store)).toHaveLength(2);
  });

  test("un evento error del runtime queda en la corrida con su ámbito", async () => {
    const { store, agents } = setup([
      {
        events: async function* () {
          yield { type: "error", kind: "other", message: "no se pudo observar las skills" } as const;
        },
        result: { structured: validReport },
      },
    ]);

    await agents.run(request());

    expect(store.events.since(0, { types: ["error"] }).map((e) => e.payload)).toEqual([
      { scope: "agent.runtime", message: "no se pudo observar las skills" },
    ]);
  });
});

describe("varios runtimes", () => {
  const followupReport = { outcome: "done", summary: "listo", payload: { done: true } };

  /** Un core con `claude-sdk` y `opencode`; `analyst-oc` es la entrada del perfil que pide opencode. */
  function setupBoth(claudeSteps: Step[], opencodeSteps: Step[]) {
    const store = openStore({ path: ":memory:" });
    open.push(store);
    const defs = createDefs({ store });
    const claude = stubRuntime(claudeSteps, "claude-sdk");
    const opencode = stubRuntime(opencodeSteps, "opencode");
    const agents = createAgents({ store, defs, runtimes: createRuntimeRegistry([claude.runtime, opencode.runtime], {}) });
    defs.save({ kind: "role", slug: "analyst", scope: "user", body: role, source: "ui" });
    defs.save({
      kind: "profile",
      slug: "default",
      scope: "user",
      body: { roles: { analyst: { model: "sonnet" }, "analyst-oc": { runtime: "opencode", model: "openai/gpt-6.1-terra", effort: "high" } } },
      source: "ui",
    });
    return { store, agents, claude: claude.calls, opencode: opencode.calls };
  }

  test("cada entrada del perfil corre con su runtime y la sesión queda con él", async () => {
    const { store, agents, claude, opencode } = setupBoth([{ result: { structured: validReport } }], [{ result: { structured: validReport } }]);

    const byDefault = await agents.run(request());
    const byOpencode = await agents.run({ ...request(), profileRole: "analyst-oc" });

    expect([byDefault.status, byOpencode.status]).toEqual(["success", "success"]);
    expect(claude.starts.map((s) => s.model)).toEqual(["sonnet"]);
    expect(opencode.starts.map((s) => [s.model, s.effort])).toEqual([["openai/gpt-6.1-terra", "high"]]);
    expect(store.db.select().from(agentSessions).all().map((row) => [row.runtime, row.model])).toEqual([
      ["claude-sdk", "sonnet"],
      ["opencode", "openai/gpt-6.1-terra"],
    ]);
  });

  test("retomar una sesión va al runtime que la abrió", async () => {
    const { agents, claude, opencode } = setupBoth([], [{ result: { structured: validReport } }, { result: { structured: followupReport } }]);
    const first = await agents.run({ ...request(), profileRole: "analyst-oc" });

    const resumed = await agents.resume({ profile: "default", sessionId: first.sessionId, mode: "followup", brief: brief("followup") });

    expect(resumed.status).toBe("success");
    expect(opencode.resumes.map((r) => r.ref)).toEqual([{ runtime: "opencode", sessionId: "opencode-1", cwd: "/work/tree" }]);
    expect(claude.resumes).toEqual([]);
  });

  test("resumeFrom una sesión de otro runtime abre una nueva con handoff", async () => {
    const { agents, claude, opencode } = setupBoth([{ result: { structured: validReport } }], [{ result: { structured: followupReport } }]);
    const first = await agents.run(request());

    const next = await agents.run({ ...request("followup"), profileRole: "analyst-oc", resumeFrom: first.sessionId });

    expect(next.status).toBe("success");
    expect(claude.resumes).toEqual([]);
    expect(opencode.starts[0]?.prompt).toContain('corrió con el runtime "claude-sdk" y esta entrada del perfil usa "opencode"');
  });

  test("un fallo de entorno dice qué runtime falló", async () => {
    const { agents } = setupBoth([], [{ result: { status: "login_expired", message: "opencode: el login de openai venció." } }]);

    const result = await agents.run({ ...request(), profileRole: "analyst-oc" });

    expect(result).toMatchObject({ status: "login_expired", runtime: "opencode" });
  });

  test("una entrada que pide un runtime que el core no tiene falla antes de lanzar", async () => {
    const store = openStore({ path: ":memory:" });
    open.push(store);
    const defs = createDefs({ store });
    const claude = stubRuntime([], "claude-sdk");
    const agents = createAgents({ store, defs, runtimes: createRuntimeRegistry([claude.runtime], {}) });
    defs.save({ kind: "role", slug: "analyst", scope: "user", body: role, source: "ui" });
    defs.save({ kind: "profile", slug: "default", scope: "user", body: { roles: { analyst: { runtime: "opencode", model: "openai/gpt-6.1-terra" } } }, source: "ui" });

    await expect(agents.run(request())).rejects.toThrow(RuntimeUnavailableError);
    expect(claude.calls.starts).toEqual([]);
  });
});

describe("createRuntimeRegistry", () => {
  const { runtime } = stubRuntime([]);
  const claude = { ...stubRuntime([]).runtime, id: "claude-sdk" as const };
  const opencode = { ...stubRuntime([]).runtime, id: "opencode" as const };

  test("cada entrada elige su runtime y sin runtime corre con claude-sdk", () => {
    const registry = createRuntimeRegistry([claude, opencode], {});
    expect(registry.get(undefined)).toBe(claude);
    expect(registry.get("opencode")).toBe(opencode);
    expect(registry.forced).toBeUndefined();
  });

  test("CORE_RUNTIME fuerza todos los agentes a uno", () => {
    const registry = createRuntimeRegistry([claude, runtime], { CORE_RUNTIME: "fake" });
    expect(registry.get("claude-sdk")).toBe(runtime);
    expect(registry.idFor("opencode")).toBe("fake");
  });

  test("un CORE_RUNTIME que no está registrado dice cuáles hay", () => {
    expect(() => createRuntimeRegistry([runtime], { CORE_RUNTIME: "claude-sdk" })).toThrow(/CORE_RUNTIME="claude-sdk".*fake/);
  });

  test("un runtime que el core no tiene falla al pedirlo, no al armar el registro", () => {
    const registry = createRuntimeRegistry([claude], {});
    expect(registry.idFor("opencode")).toBe("opencode");
    expect(() => registry.get("opencode")).toThrow(RuntimeUnavailableError);
  });
});

describe("roles como datos", () => {
  test("ningún nombre de rol aparece en el código del módulo", () => {
    // Como palabra, no como parte de una ruta: `/dev/null` no es el rol dev.
    const forbidden =
      /(?<![\w/-])(dev|techlead|committer|review-[a-z]+|bot-reviewer|judge|triage|plan-check|council)(?![\w/])/i;
    const here = fileURLToPath(new URL(".", import.meta.url));
    const files = [
      ...readdirSync(here)
        .filter((f) => f.endsWith(".ts") && !f.endsWith(".test.ts"))
        .map((f) => join(here, f)),
      fileURLToPath(new URL("../../../api/src/agents.ts", import.meta.url)),
    ];

    expect(files.length).toBeGreaterThanOrEqual(3);
    for (const file of files) {
      expect(readFileSync(file, "utf8"), file).not.toMatch(forbidden);
    }
  });
});

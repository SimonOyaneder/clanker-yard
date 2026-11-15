import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, test } from "vitest";
import type { Brief, Profile, Role } from "@clanker/api";
import { createDefs } from "../defs/defs";
import { newId } from "../store/conventions";
import { agentSessions } from "../store/schema";
import { openStore, type Store } from "../store/store";
import { ACTIVITY_INTERVAL_MS, createAgents, type Agents } from "./agents";
import {
  selectRuntime,
  type AgentEvent,
  type AgentRun,
  type AgentRuntime,
  type ResumeSpec,
  type RunResult,
  type RunSpec,
  type SessionRef,
  type Usage,
} from "./runtime";

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
  context: [{ kind: "repo", files: ["AGENTS.md"] }],
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
  },
};

const profile: Profile = {
  roles: { analyst: { model: "sonnet", effort: "high", budget: { maxUsd: 0.5 } } },
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
function stubRuntime(steps: Step[]) {
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
      ref: { runtime: "fake", sessionId: step.sessionId ?? `stub-${++n}`, cwd },
      events: events(),
      interrupt: async () => step.onInterrupt?.(),
      result: Promise.resolve({ status: "success", text: "", usage, ...step.result }),
    };
  };
  const runtime: AgentRuntime = {
    id: "fake",
    capabilities: { structuredOutput: true, costPerTurn: true, resume: true, fork: false, steer: false },
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

function setup(steps: Step[], now?: () => number) {
  const store = openStore({ path: ":memory:" });
  open.push(store);
  const defs = createDefs(store);
  const stub = stubRuntime(steps);
  const agents: Agents = createAgents({ store, defs, runtime: stub.runtime, now });
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

  test("falla con un mensaje accionable si falta el rol, el modo, el perfil o el payload es inválido", async () => {
    const { agents } = setup([]);

    await expect(agents.run({ ...request(), role: "nadie" })).rejects.toThrow('No existe el rol "nadie"');
    await expect(agents.run({ ...request(), mode: "x", brief: brief("x") })).rejects.toThrow(
      /no tiene el modo "x" \(tiene: audit, followup\)/,
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
    store.db.update(agentSessions).set({ runtime: "acp" }).run();

    await expect(
      agents.resume({
        sessionId: first.sessionId,
        profile: "default",
        mode: "followup",
        brief: brief("followup"),
      }),
    ).rejects.toThrow(`La sesión ${first.sessionId} es del runtime "acp"`);
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

describe("selectRuntime", () => {
  const { runtime } = stubRuntime([]);

  test("elige por CORE_RUNTIME", () => {
    expect(selectRuntime([runtime], { CORE_RUNTIME: "fake" })).toBe(runtime);
  });

  test("sin CORE_RUNTIME usa claude-sdk y, si no está registrado, dice cuáles hay", () => {
    expect(() => selectRuntime([runtime], {})).toThrow(/CORE_RUNTIME="claude-sdk".*fake/);
  });
});

describe("roles como datos", () => {
  test("ningún nombre de rol aparece en el código del módulo", () => {
    const forbidden =
      /\b(dev|techlead|committer|review-[a-z]+|bot-reviewer|judge|triage|plan-check|council)\b/i;
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

import { createRuntimeRegistry } from "../agents/runtime";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FlowDef, Role, type Profile, type RunId, type SubjectRef, type RepoId } from "@clanker/api";
import { z } from "zod";
import { createAgents } from "../agents/agents";
import type { AgentRuntime, RunResult, RunSpec, SessionRef, Usage } from "../agents/runtime";
import { createArtifacts } from "../artifacts/artifacts";
import { createDecisions } from "../decisions/decisions";
import { createDefs } from "../defs/defs";
import { openStore, type Store, type Tx } from "../store/store";
import type { ActionCtx, ActionDef, ActionResult } from "../flows/catalog";
import type { LaneCapacity } from "../flows/lanes";
import type { EngineDeps } from "../flows/engine";
import { createFlows } from "../flows/flows";

// Un motor de flujos sobre una base en memoria y un runtime que responde con un guion, para los
// tests del motor. `cleanup` lo cierra: quien lo usa lo engancha a su `afterEach`.

const usage: Usage = {
  turns: 2,
  tokensIn: 10,
  tokensOut: 20,
  tokensCacheRead: 0,
  tokensCacheWrite: 0,
  costMicros: 500,
  costSource: "runtime",
};

/** El plazo de un `vi.waitFor` sobre una corrida: el default de 1 s no alcanza con la suite en paralelo y bajo carga. */
export const WAIT = { timeout: 10_000 };

export const reportSchema = {
  type: "object",
  properties: { n: { type: "number" }, issueDoubts: { type: "array", items: { type: "string" } } },
};
export const devRole = (prompt: string): Role => ({
  prompt,
  context: [],
  modes: {
    plan: { instructions: "Planifica.", report: reportSchema, outcomes: ["ok", "changes"], session: "new" },
    implement: { instructions: "Implementa.", report: reportSchema, outcomes: ["ok", "changes"], session: "resume", learnings: true },
  },
});
export const devProfile = (model: string): Profile => ({ roles: { dev: { model } } });

export interface AgentCall {
  kind: "start" | "resume";
  sessionId: string;
  spec?: RunSpec;
  /** El `subject.id` del brief, para distinguir de qué corrida es. */
  subject: string;
  /** El mensaje completo que recibió el agente. */
  prompt: string;
}
export type AgentScript = (call: AgentCall, interrupted: Promise<void>) => Promise<Partial<RunResult>>;

export const okReport = (payload: unknown = { n: 1 }, outcome = "ok") => ({
  structured: { outcome, summary: "listo", payload },
});

export const subjectOf = (prompt: string) => /"subject": \{[^}]*"id": "([^"]+)"/.exec(prompt)?.[1] ?? "?";

/** Dónde vive lo que sobrevive a un corte: el archivo de la base y la carpeta de artefactos. */
export interface HarnessHome {
  dbPath: string;
  dir: string;
}

export function harness(
  options: {
    maxAgents?: number;
    probeEverySec?: number;
    script?: AgentScript;
    roles?: Record<string, Role>;
    bootId?: string;
    /** La base en un archivo (`home` del resultado), para simular un corte: otro `harness` con `reopen` sigue donde quedó este. */
    persist?: boolean;
    reopen?: HarnessHome;
    onClockJump?: () => void;
    /** Un resume vuelve con el mismo id de sesión, como Claude; por defecto abre uno nuevo. */
    resumeKeepsSession?: boolean;
    /** El worktree que tiene tomado cada corrida; por defecto todas tienen el mismo. */
    workspaceOf?: (runId: RunId) => { path: string; base: string; repoId?: RepoId; workspaceId?: string; fencingToken?: number } | undefined;
    /** Lo que hace el préstamo del sujeto con los worktrees (en producción, `workspaces.handOver`). */
    handOverWorkspaces?: (tx: Tx, from: RunId, to: RunId) => void;
    /** La capacidad de cada carril; sin ella ningún carril tiene tope. */
    laneCapacity?: () => LaneCapacity;
    /** Los breakers y el runtime de los agentes; recibe la base del harness para armar `createBreakers` sobre ella. */
    environment?: (store: Store) => EngineDeps["environment"];
  } = {},
) {
  const dir = options.reopen?.dir ?? mkdtempSync(join(tmpdir(), "clanker-flows-"));
  const dbPath = options.reopen?.dbPath ?? (options.persist ? join(dir, "clanker.db") : ":memory:");
  const store = openStore({ path: dbPath });
  const defs = createDefs({ store });

  // Los ids de sesión del runtime no se repiten entre arranques de la misma base.
  const bootPrefix = options.bootId ? `${options.bootId}-` : "";
  const calls: AgentCall[] = [];
  const script: AgentScript = options.script ?? (() => Promise.resolve(okReport()));
  const run = (call: AgentCall, cwd: string) => {
    calls.push(call);
    let interrupt = () => {};
    const interrupted = new Promise<void>((resolve) => (interrupt = resolve));
    const ref: SessionRef = { runtime: "fake", sessionId: call.sessionId, cwd };
    return {
      ref,
      events: (async function* () {})(),
      interrupt: () => Promise.resolve(interrupt()),
      result: Promise.race([
        script(call, interrupted).then((r): RunResult => ({ status: "success", text: "", usage, ...r })),
        interrupted.then((): RunResult => ({ status: "error", text: "", usage, message: "interrumpido" })),
      ]),
    };
  };
  const runtime: AgentRuntime = {
    id: "fake",
    capabilities: { costPerTurn: true },
    start: (spec) =>
      Promise.resolve(run({ kind: "start", sessionId: `${bootPrefix}ses-${calls.length + 1}`, spec, subject: subjectOf(spec.prompt), prompt: spec.prompt }, spec.cwd)),
    resume: (ref, message) =>
      Promise.resolve(run({ kind: "resume", sessionId: options.resumeKeepsSession ? ref.sessionId : `${bootPrefix}ses-${calls.length + 1}`, subject: subjectOf(message), prompt: message }, ref.cwd)),
  };

  const agents = createAgents({ store, defs, runtimes: createRuntimeRegistry([runtime], {}) });
  const artifacts = createArtifacts({ store, dir });
  const flows = createFlows({
    store,
    defs,
    agents,
    artifacts,
    roles: (id) => {
      const def = defs.resolve("role", id);
      if (!def) return undefined;
      const role = Role.parse(def.body);
      return { modes: Object.fromEntries(Object.entries(role.modes).map(([name, m]) => [name, { outcomes: m.outcomes }])) };
    },
    workspaceOf: options.workspaceOf ?? (() => ({ path: "/work/tree", base: "main" })),
    maxAgents: options.maxAgents,
    probeEverySec: options.probeEverySec,
    bootId: options.bootId,
    onClockJump: options.onClockJump,
    handOverWorkspaces: options.handOverWorkspaces,
    laneCapacity: options.laneCapacity,
    environment: options.environment?.(store),
  });
  let crashed = false;
  /** Un corte: deja de despachar y no espera a lo que tenía en vuelo (un proceso muerto no termina nada). */
  const crash = () => {
    crashed = true;
    return flows.close();
  };
  const cleanup = async () => {
    if (!crashed) await flows.close();
    store.close();
    rmSync(dir, { recursive: true, force: true });
  };

  defs.save({ kind: "role", slug: "dev", scope: "user", body: devRole("Eres dev v1."), source: "ui" });
  const extraRoles = options.roles ?? {};
  for (const [slug, role] of Object.entries(extraRoles)) defs.save({ kind: "role", slug, scope: "user", body: role, source: "ui" });
  const profile: Profile = { roles: { ...devProfile("sonnet").roles, ...Object.fromEntries(Object.keys(extraRoles).map((slug) => [slug, { model: "sonnet" }])) } };
  defs.save({ kind: "profile", slug: "default", scope: "user", body: profile, source: "ui" });

  const anyArgs = z.record(z.string(), z.unknown());
  /** Registra una acción de prueba con los outcomes que da y lo que hace. */
  function action(
    name: string,
    outcomes: string[],
    fn: (args: Record<string, unknown>, ctx: ActionCtx) => Promise<ActionResult> | ActionResult = () => ({ outcome: "ok" }),
    traits: Partial<Pick<ActionDef, "effects" | "needsRepoEnv">> = {},
  ) {
    flows.registerAction({
      name,
      outcomes,
      effects: traits.effects ?? "local",
      needsRepoEnv: traits.needsRepoEnv,
      args: anyArgs,
      run: async (args, ctx) => fn(args, ctx),
    });
  }

  function save(def: unknown) {
    flows.save(FlowDef.parse(def));
  }

  const start = (flow: string, subject: SubjectRef = { type: "issue", id: "ENG-1" }, params?: Record<string, unknown>) =>
    flows.start(flow, subject, params, { profile: "default" });

  /** Resuelve cuando la corrida terminó o quedó estacionada. */
  function finished(runId: RunId): Promise<void> {
    const filter = { runId, types: ["run.finished" as const, "run.parked" as const] };
    return new Promise((resolve) => {
      if (store.events.since(0, filter).length > 0) return resolve();
      const off = store.events.subscribe(() => {
        off();
        resolve();
      }, filter);
    });
  }

  const eventTypes = (runId: RunId) =>
    store.events
      .since(0, { runId })
      .map((e) => e.type)
      .filter((type) => /^(run|step|agent)\./.test(type));

  const nodes = (runId: RunId) => flows.getRun(runId).steps.map((s) => s.nodeId);

  return { store, defs, flows, artifacts, decisions: createDecisions({ store }), calls, home: { dbPath, dir } satisfies HarnessHome, crash, action, save, start, finished, eventTypes, nodes, cleanup };
}

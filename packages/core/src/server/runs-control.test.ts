import type { FlowDef, RunId, StepRunId } from "@clanker/api";
import { createRouterClient, ORPCError } from "@orpc/server";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { z } from "zod";
import { openStore, type Store } from "../store/store";
import { createIssues } from "../tracker/issues";
import { createRouter } from "./router";
import { apiDeps, withPrs } from "../testing/router-deps";
import { WAIT } from "../testing/flows-harness";

// `runs.pause|resume|cancel|interrupt|retryStep|steerStep|forceOutcome` sobre un motor real con acciones
// que esperan hasta que se las aborta.

let store: Store;
let deps: ReturnType<typeof apiDeps>;
let started: StepRunId[];

beforeEach(() => {
  store = openStore({ path: ":memory:" });
  deps = apiDeps(store, "/tmp/clanker");
  started = [];
  deps.flows.registerAction({
    name: "slow",
    args: z.record(z.string(), z.unknown()),
    outcomes: ["ok", "fail"],
    effects: "local",
    run: (_args, ctx) => {
      started.push(ctx.stepId as StepRunId);
      return new Promise(() => {});
    },
  });
  const flow: FlowDef = {
    schema: 1,
    id: "slow",
    name: "Lento",
    trigger: { type: "manual" },
    start: "slow",
    nodes: { slow: { type: "action", action: "slow", args: {}, on: { ok: "@done", fail: "@failed" } } },
  };
  deps.flows.save(flow);
});

afterEach(async () => {
  for (const { id } of deps.flows.listRuns({ status: ["running", "paused"] })) deps.flows.control(id, "cancel", "core");
  await deps.flows.close();
  store.close();
});

function api(origin: "ui" | "cli" | "mcp" = "ui") {
  const router = createRouter(withPrs({
    store,
    connections: {} as never,
    issues: createIssues(store),
    ...deps,
    coreVersion: "0",
    bootId: "boot",
    startedAt: 0,
    dataDir: "/tmp/clanker",
    onShutdown: () => {},
  }));
  return createRouterClient(router, { context: { origin } });
}

const code = (expected: string, message?: RegExp) => (e: unknown) => e instanceof ORPCError && e.code === expected && (message?.test(e.message) ?? true);

async function slowRun(): Promise<{ id: RunId; stepId: StepRunId }> {
  const id = deps.flows.start("slow", { type: "issue", id: "ENG-1" });
  await vi.waitFor(() => expect(started).toHaveLength(1), WAIT);
  return { id, stepId: started[0] as StepRunId };
}

test("pause, resume e interrupt devuelven la corrida como quedó y dejan al actor en los eventos", async () => {
  const client = api("mcp");
  const { id } = await slowRun();

  expect(await client.runs.pause({ id })).toMatchObject({ id, status: "paused" });
  expect(await client.runs.resume({ id })).toMatchObject({ status: "running" });
  expect(await client.runs.interrupt({ id })).toMatchObject({ status: "paused" });

  expect(store.events.since(0, { runId: id, types: ["run.status"] }).map((e) => [e.origin, e.payload.from, e.payload.to, e.payload.now])).toEqual([
    ["mcp", "running", "paused", false],
    ["mcp", "paused", "running", undefined],
    ["mcp", "running", "paused", true],
  ]);
});

test("cancel termina la corrida con su actor y una corrida que no existe es NOT_FOUND", async () => {
  const client = api("cli");
  const { id } = await slowRun();

  expect(await client.runs.cancel({ id })).toMatchObject({ status: "canceled", steps: [{ status: "canceled" }] });
  expect(store.events.since(0, { runId: id, types: ["run.finished"] })).toMatchObject([{ origin: "cli", payload: { outcome: "canceled" } }]);
  await expect(client.runs.pause({ id })).rejects.toSatisfy(code("BAD_REQUEST", /solo se pausa una corrida que corre/));
  await expect(client.runs.resume({ id: "run_00000000000000000000000000" as RunId })).rejects.toSatisfy(code("NOT_FOUND"));
});

test("forceOutcome sigue el edge del outcome; con uno que el nodo no declara o sobre un paso que no existe falla", async () => {
  const client = api();
  const { id, stepId } = await slowRun();

  await expect(client.runs.forceOutcome({ stepId, outcome: "nope" })).rejects.toSatisfy(code("BAD_REQUEST", /no declara el outcome "nope": ok, fail/));
  await expect(client.runs.forceOutcome({ stepId: "stp_00000000000000000000000000" as StepRunId, outcome: "ok" })).rejects.toSatisfy(code("NOT_FOUND"));
  expect(await client.runs.forceOutcome({ stepId, outcome: "ok" })).toMatchObject({ id, status: "done", outcome: "done", steps: [{ status: "done", outcome: "ok" }] });
  expect(store.events.since(0, { runId: id, types: ["step.commanded"] })).toMatchObject([{ origin: "ui", payload: { command: "force", outcome: "ok" } }]);
});

test("retryStep abre una visita nueva del nodo; steerStep sobre una acción es BAD_REQUEST", async () => {
  const client = api();
  const { id, stepId } = await slowRun();

  await expect(client.runs.steerStep({ stepId, message: "hola" })).rejects.toSatisfy(code("BAD_REQUEST", /Solo un paso de agente/));
  const retried = await client.runs.retryStep({ stepId });

  expect(retried.steps.map((s) => [s.nodeId, s.visit, s.status])).toEqual([
    ["slow", 1, "canceled"],
    ["slow", 2, "running"],
  ]);
  expect(retried.id).toBe(id);
  await vi.waitFor(() => expect(started).toHaveLength(2), WAIT);
});

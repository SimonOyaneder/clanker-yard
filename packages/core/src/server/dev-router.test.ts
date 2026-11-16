import type { FlowDef, RunId, StepRunId } from "@clanker/api";
import { createRouterClient, ORPCError } from "@orpc/server";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { z } from "zod";
import { openStore, type Store } from "../store/store";
import { createDevRouter, type DevTools } from "./dev-router";
import { apiDeps } from "./testing";

/** El plazo de un `vi.waitFor`: el default de 1 s no alcanza con la suite en paralelo y bajo carga. */
const WAIT = { timeout: 10_000 };

// El router `dev` sobre un motor real con una acción que espera hasta que se la aborta.

let store: Store;
let deps: ReturnType<typeof apiDeps>;
let started: StepRunId[];
let seeded: string[];
let clock: number;

beforeEach(() => {
  store = openStore({ path: ":memory:" });
  deps = apiDeps(store, "/tmp/clanker");
  started = [];
  seeded = [];
  clock = 1_000;
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

function api() {
  const dev: DevTools = {
    fixtures: { escenario: async () => void seeded.push("escenario") },
    advanceClock: (ms) => (clock += ms),
  };
  return createRouterClient(createDevRouter({ flows: deps.flows, dev }), { context: { origin: "mcp" } });
}

const code = (expected: string, message?: RegExp) => (e: unknown) => e instanceof ORPCError && e.code === expected && (message?.test(e.message) ?? true);

test("injectStepResult cierra el paso en marcha con el outcome y la corrida sigue su edge", async () => {
  const client = api();
  const id: RunId = deps.flows.start("slow", { type: "issue", id: "ENG-1" });
  await vi.waitFor(() => expect(started).toHaveLength(1), WAIT);
  const stepId = started[0] as StepRunId;

  await expect(client.injectStepResult({ stepId, outcome: "nope" })).rejects.toSatisfy(code("BAD_REQUEST", /no declara el outcome "nope": ok, fail/));
  await expect(client.injectStepResult({ stepId: "stp_00000000000000000000000000" as StepRunId, outcome: "ok" })).rejects.toSatisfy(code("NOT_FOUND"));
  expect(await client.injectStepResult({ stepId, outcome: "fail" })).toMatchObject({ id, status: "failed", steps: [{ status: "done", outcome: "fail" }] });
  expect(store.events.since(0, { runId: id, types: ["step.commanded"] })).toMatchObject([{ origin: "mcp", payload: { command: "force", outcome: "fail" } }]);
});

test("loadFixture corre el escenario pedido; con un nombre desconocido o heredado de Object falla y lista los que hay", async () => {
  const client = api();

  expect(await client.loadFixture({ name: "escenario" })).toEqual({ name: "escenario" });
  expect(seeded).toEqual(["escenario"]);
  await expect(client.loadFixture({ name: "nope" })).rejects.toSatisfy(code("BAD_REQUEST", /No existe el fixture "nope": hay escenario\./));
  await expect(client.loadFixture({ name: "toString" })).rejects.toSatisfy(code("BAD_REQUEST", /No existe el fixture "toString"/));
  expect(seeded).toEqual(["escenario"]);
});

test("advanceClock suma los ms y devuelve la hora nueva; 0 o negativos no valen", async () => {
  const client = api();

  expect(await client.advanceClock({ ms: 500 })).toEqual({ now: 1_500 });
  expect(await client.advanceClock({ ms: 500 })).toEqual({ now: 2_000 });
  await expect(client.advanceClock({ ms: 0 })).rejects.toSatisfy(code("BAD_REQUEST"));
});

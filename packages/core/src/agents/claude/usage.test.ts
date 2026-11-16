import { createRuntimeRegistry } from "../runtime";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import type { Brief, Profile, Role } from "@clanker/api";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { createDefs } from "../../defs/defs";
import { newId } from "../../store/conventions";
import { agentSessions, agentTurns } from "../../store/schema";
import { openStore, type Store } from "../../store/store";
import { createAgents, type Agents } from "../agents";
import { createClaudeRuntime, type QueryFn } from "./claude-runtime";
import { subscriptionCredentials } from "./credentials";

// Agents sobre el runtime claude-sdk de verdad y un `query` falso con la forma de los mensajes del SDK:
// lo que se prueba es lo que queda guardado turno a turno y contra el total del `result`.

let home: string;
const open: Store[] = [];
beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), "claude-usage-home-"));
});
afterEach(async () => {
  for (const store of open.splice(0)) store.close();
  await rm(home, { recursive: true, force: true });
});

const MODEL = "claude-sonnet-5-5";

const role: Role = {
  prompt: "Eres un analista.",
  context: [{ kind: "native", sources: [], skills: [] }],
  modes: {
    audit: {
      instructions: "Audita.",
      report: { type: "object", properties: {} },
      outcomes: ["clean"],
      session: "new",
    },
    followup: {
      instructions: "Sigue.",
      report: { type: "object", properties: {} },
      outcomes: ["clean"],
      session: "resume",
    },
  },
};
const profile: Profile = { roles: { analyst: { model: "sonnet" } } };

const brief = (mode: string): Brief => ({
  run: { id: newId("run") as Brief["run"]["id"], subject: { type: "issue", id: "1" }, round: 1, attempt: 1 },
  worktree: "/work/tree",
  base: "origin/main",
  mode,
  artifacts: {},
  payload: {},
});

const message = (m: Record<string, unknown>) => ({ session_id: "sess-1", ...m }) as SDKMessage;
const init = message({ type: "system", subtype: "init", apiKeySource: "none" });

/**
 * Un turno de 14 500 micros con el modelo de `MODEL`: 1 000 de entrada, 500 de salida, 10 000 de
 * lectura de caché y 2 000 de escritura, la mitad en la caché de 1 h (los precios, en la migración).
 */
const TURN_MICROS = 14_500;
const TURN_TOKENS = { in: 1000, out: 500, cacheRead: 10_000, cacheWrite: 2000 };
const turnUsage = {
  input_tokens: TURN_TOKENS.in,
  output_tokens: TURN_TOKENS.out,
  cache_read_input_tokens: TURN_TOKENS.cacheRead,
  cache_creation_input_tokens: TURN_TOKENS.cacheWrite,
  cache_creation: { ephemeral_5m_input_tokens: 1000, ephemeral_1h_input_tokens: 1000 },
};
const assistant = (id: string, extra: Record<string, unknown> = {}) =>
  message({
    type: "assistant",
    parent_tool_use_id: null,
    message: { id, model: MODEL, content: [{ type: "text", text: "hola" }], usage: turnUsage },
    ...extra,
  });

/** El `result` con el acumulado de la sesión tras `turns` turnos, como lo manda el SDK. */
const result = (turns: number, totalMicros = turns * TURN_MICROS, model = MODEL, otherModels: Record<string, unknown> = {}) =>
  message({
    type: "result",
    subtype: "success",
    is_error: false,
    result: "listo",
    structured_output: { outcome: "clean", summary: "", payload: {} },
    total_cost_usd: totalMicros / 1_000_000,
    modelUsage: {
      [model]: {
        inputTokens: turns * TURN_TOKENS.in,
        outputTokens: turns * TURN_TOKENS.out,
        cacheReadInputTokens: turns * TURN_TOKENS.cacheRead,
        cacheCreationInputTokens: turns * TURN_TOKENS.cacheWrite,
        costUSD: totalMicros / 1_000_000,
      },
      ...otherModels,
    },
  });

const queryOf =
  (...scripts: SDKMessage[][]): QueryFn =>
  () => {
    const script = scripts.shift();
    if (script === undefined) throw new Error("el query falso se quedó sin guiones");
    return (async function* () {
      yield* script;
    })();
  };

function setup(query: QueryFn) {
  const store = openStore({ path: ":memory:" });
  open.push(store);
  const defs = createDefs(store);
  const runtime = createClaudeRuntime({
    credentials: async () => subscriptionCredentials({ executable: "/bin/claude" }),
    home,
    query,
    baseEnv: { PATH: "/usr/bin", HOME: "/Users/x", USER: "x" },
  });
  const agents: Agents = createAgents({ store, defs, runtimes: createRuntimeRegistry([runtime], {}) });
  defs.save({ kind: "role", slug: "analyst", scope: "user", body: role, source: "ui" });
  defs.save({ kind: "profile", slug: "default", scope: "user", body: profile, source: "ui" });
  return { store, agents };
}

const audit = (agents: Agents) =>
  agents.run({ role: "analyst", profile: "default", mode: "audit", brief: brief("audit"), workspace: "/work/tree" });

const turnsOf = (store: Store) => store.db.select().from(agentTurns).orderBy(agentTurns.seq).all();
const sessionOf = (store: Store) => store.db.select().from(agentSessions).get();
const eventsOf = (store: Store, type: string) => store.events.since(0).filter((e) => e.type === type);

describe("turnos", () => {
  test("guarda un turno por message.id, con su USD de la tabla de precios, y la sesión queda en el total del runtime", async () => {
    const { store, agents } = setup(
      queryOf([init, assistant("m1"), assistant("m1"), assistant("m2"), result(2)]),
    );

    await audit(agents);

    expect(turnsOf(store)).toMatchObject([
      { seq: 1, model: MODEL, tokensIn: 1000, tokensCacheWrite: 2000, tokensCacheWrite1h: 1000, costMicros: TURN_MICROS },
      { seq: 2, costMicros: TURN_MICROS },
    ]);
    expect(sessionOf(store)).toMatchObject({
      status: "success",
      turns: 2,
      tokensIn: 2000,
      tokensCacheWrite: 4000,
      costMicros: 2 * TURN_MICROS,
      costSource: "estimate",
    });
    expect(eventsOf(store, "agent.usage").map((e) => e.payload)).toMatchObject([
      { turn: 1, costMicros: TURN_MICROS, tokens: { in: 1000, out: 500, cacheRead: 10_000, cacheWrite: 2000 } },
      { turn: 2, costMicros: TURN_MICROS },
    ]);
    expect(eventsOf(store, "error")).toEqual([]);
  });

  test("un mensaje repetido con otro intercalado no suma dos veces", async () => {
    const { store, agents } = setup(
      queryOf([init, assistant("m1"), assistant("sub", { parent_tool_use_id: "t1" }), assistant("m1"), result(2)]),
    );

    await audit(agents);

    expect(turnsOf(store)).toHaveLength(2);
    expect(sessionOf(store)).toMatchObject({ turns: 2, costMicros: 2 * TURN_MICROS });
  });

  test("una sesión retomada no cuenta dos veces lo que ya traía", async () => {
    const { store, agents } = setup(
      queryOf(
        [init, assistant("m1"), assistant("m2"), result(2)],
        // El SDK arrastra el acumulado al retomar: el `result` ya trae lo de antes.
        [init, assistant("m3"), result(3)],
      ),
    );
    const first = await audit(agents);

    await agents.resume({ sessionId: first.sessionId, profile: "default", mode: "followup", brief: brief("followup") });

    expect(turnsOf(store).map((t) => t.seq)).toEqual([1, 2, 3]);
    expect(sessionOf(store)).toMatchObject({ turns: 3, tokensIn: 3000, costMicros: 3 * TURN_MICROS });
    expect(eventsOf(store, "error")).toEqual([]);
  });

  test("sin result (el proceso murió) quedan las estimaciones por turno", async () => {
    const dying: QueryFn = () =>
      (async function* () {
        yield init;
        yield assistant("m1");
        yield assistant("m2");
        throw new Error("el proceso murió");
      })();
    const { store, agents } = setup(dying);

    const outcome = await audit(agents);

    expect(outcome.status).toBe("error");
    expect(sessionOf(store)).toMatchObject({ status: "error", turns: 2, costMicros: 2 * TURN_MICROS, costSource: "estimate" });
  });
});

describe("diferencia con el total del runtime", () => {
  const mismatches = (store: Store) => eventsOf(store, "error").filter((e) => e.payload.scope === "agent.usage");

  test("más de 2% deja un evento error, y el total del runtime es el que queda en la sesión", async () => {
    // Las estimaciones suman 29 000 y el runtime dice 29 700: 2,4%.
    const { store, agents } = setup(queryOf([init, assistant("m1"), assistant("m2"), result(2, 29_700)]));

    await audit(agents);

    expect(mismatches(store)).toHaveLength(1);
    expect(mismatches(store)[0]?.payload.message).toMatch(/29000 micros.*29700 micros/);
    expect(sessionOf(store)?.costMicros).toBe(29_700);
  });

  test("hasta 2% no deja evento", async () => {
    // 29 000 contra 29 500: 1,7%.
    const { store, agents } = setup(queryOf([init, assistant("m1"), assistant("m2"), result(2, 29_500)]));

    await audit(agents);

    expect(mismatches(store)).toEqual([]);
    expect(sessionOf(store)?.costMicros).toBe(29_500);
  });
});

describe("uso por turno que no es final", () => {
  // El SDK avisa que el `usage` de un `assistant` en streaming no es final: la salida llega en el total.
  const streaming = (id: string) =>
    message({
      type: "assistant",
      parent_tool_use_id: null,
      message: { id, model: MODEL, content: [{ type: "text", text: "hola" }], usage: { ...turnUsage, output_tokens: 1 } },
    });

  test("la salida que falta en los turnos se suma al último turno del modelo y los turnos suman el total", async () => {
    const { store, agents } = setup(queryOf([init, streaming("m1"), streaming("m2"), result(2)]));

    await audit(agents);

    expect(turnsOf(store)).toMatchObject([
      { seq: 1, tokensOut: 1, costMicros: TURN_MICROS - 499 * 10 },
      { seq: 2, tokensOut: 1 + 2 * 499, costMicros: TURN_MICROS + 499 * 10 },
    ]);
    expect(sessionOf(store)).toMatchObject({ turns: 2, tokensOut: 2 * TURN_TOKENS.out, costMicros: 2 * TURN_MICROS });
    expect(eventsOf(store, "error")).toEqual([]);
  });

  test("un modelo que solo gastó en llamadas internas queda en un turno propio", async () => {
    const haiku = { inputTokens: 50_000, outputTokens: 0, cacheReadInputTokens: 0, cacheCreationInputTokens: 0, costUSD: 0.005 };
    const withHaiku = result(1, TURN_MICROS + 5000, MODEL, { "claude-haiku-5-5": haiku });
    const { store, agents } = setup(queryOf([init, assistant("m1"), withHaiku]));

    await audit(agents);

    expect(turnsOf(store)).toMatchObject([
      { seq: 1, model: MODEL, costMicros: TURN_MICROS },
      { seq: 2, model: "claude-haiku-5-5", tokensIn: 50_000, costMicros: 5000 },
    ]);
    expect(sessionOf(store)).toMatchObject({ turns: 2, costMicros: TURN_MICROS + 5000 });
    expect(eventsOf(store, "error")).toEqual([]);
  });
});

describe("precios", () => {
  test("un modelo sin precio deja el turno en 0 y un evento error", async () => {
    const unknown = assistant("m1", {
      message: { id: "m1", model: "claude-mystery-1", content: [], usage: turnUsage },
    });
    const { store, agents } = setup(queryOf([init, unknown, result(1, undefined, "claude-mystery-1")]));

    await audit(agents);

    expect(turnsOf(store)).toMatchObject([{ model: "claude-mystery-1", costMicros: 0 }]);
    expect(eventsOf(store, "error")[0]?.payload).toMatchObject({
      scope: "agent.usage",
      message: expect.stringContaining("claude-mystery-1"),
    });
  });
});

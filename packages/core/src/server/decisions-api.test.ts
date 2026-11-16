import { createRouterClient } from "@orpc/server";
import { afterEach, beforeEach, expect, test } from "vitest";
import { openDecision } from "../decisions/decisions";
import { newId } from "../store/conventions";
import { mergeOffers, pullRequests } from "../store/schema";
import { openStore, type Store } from "../store/store";
import { createIssues } from "../tracker/issues";
import { createRouter } from "./router";
import { apiDeps, withPrs } from "./testing";

let store: Store;
let deps: ReturnType<typeof apiDeps>;

beforeEach(() => {
  store = openStore({ path: ":memory:" });
  deps = apiDeps(store, "/tmp/clanker");
});

afterEach(async () => {
  await deps.flows.close();
  store.close();
});

function api(origin: "ui" | "cli" | "mcp") {
  const router = createRouter(
    withPrs({ store, connections: {} as never, issues: createIssues(store), ...deps, coreVersion: "0", bootId: "boot", startedAt: 0, dataDir: "/tmp/clanker", onShutdown: () => {} }),
  );
  return createRouterClient(router, { context: { origin } });
}

/** Una oferta de merge como la deja `startMergeReactions`: una `question` sin corrida y su fila en `merge_offers`. */
function mergeOffer() {
  return store.tx((tx) => {
    const prId = newId("pr");
    tx.db
      .insert(pullRequests)
      .values({ id: prId, repoId: "repo_00000000000000000000000001", number: 1, nodeId: "PR_1", headRef: "one", baseRef: "main", headSha: "a".repeat(40), state: "open", isDraft: false, owned: true })
      .run();
    const decision = openDecision(tx, { kind: "question", title: "¿Mergeo #1?", body: "Está listo para mergear.", options: ["Comentar /merge", "Todavía no"], subject: { type: "pr", id: prId } });
    tx.db.insert(mergeOffers).values({ decisionId: decision.id, prId, headSha: "a".repeat(40) }).run();
    return decision;
  });
}

test.each(["cli", "mcp"] as const)("una oferta de merge resuelta por %s es FORBIDDEN y sigue pendiente", async (origin) => {
  const offer = mergeOffer();

  await expect(api(origin).decisions.resolve({ id: offer.id, option: "Comentar /merge" })).rejects.toMatchObject({ code: "FORBIDDEN" });
  expect(deps.decisions.get(offer.id)).toMatchObject({ status: "pending" });
});

test("desde la app la oferta de merge se resuelve", async () => {
  const offer = mergeOffer();

  expect(await api("ui").decisions.resolve({ id: offer.id, option: "Todavía no" })).toMatchObject({ status: "answered", resolvedBy: "ui" });
});

test("otra pregunta se resuelve desde el CLI", async () => {
  const question = store.tx((tx) => openDecision(tx, { kind: "question", title: "¿De qué repo es CLA-1?", body: "Ningún label calza.", options: ["api"] }));

  expect(await api("cli").decisions.resolve({ id: question.id, option: "api" })).toMatchObject({ status: "answered", resolvedBy: "cli" });
});

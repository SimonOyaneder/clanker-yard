import { afterEach, describe, expect, test } from "vitest";
import { newId } from "../store/conventions";
import { openStore, type Store } from "../store/store";
import { createDecisions, expireMergedReviewNotes, openDecision, type NewDecision } from "./decisions";
import { seedPr } from "../testing/pull-requests";

let store: Store;
afterEach(() => store.close());

function pull(state: "open" | "merged") {
  return { type: "pr", id: seedPr(store, { repoId: newId("repo"), number: 1, state, owned: false }) } as const;
}
const open = (decision: NewDecision) => store.tx((tx) => openDecision(tx, decision));

describe("expireMergedReviewNotes", () => {
  test("expira las review_note pendientes de un PR mergeado y deja las demás", () => {
    store = openStore({ path: ":memory:" });
    const merged = pull("merged");
    const stale = open({ kind: "review_note", title: "a", body: "a", subject: merged });
    const live = open({ kind: "review_note", title: "b", body: "b", subject: pull("open") });
    const noSubject = open({ kind: "review_note", title: "c", body: "c" });
    const question = open({ kind: "question", title: "d", body: "d", subject: merged, options: ["sí"] });
    const note = open({ kind: "note", title: "e", body: "e", subject: merged });

    expect(expireMergedReviewNotes(store)).toBe(1);

    const status = (d: typeof stale) => createDecisions(store).get(d.id)?.status;
    expect([stale, live, noSubject, question, note].map(status)).toEqual(["expired", "pending", "pending", "pending", "pending"]);
    expect(createDecisions(store).get(stale.id)).toMatchObject({ resolvedBy: "watch", resolution: { reason: "pr_merged" } });
    expect(store.events.since(0, { types: ["decision.resolved"] })).toMatchObject([{ origin: "core", payload: { decisionId: stale.id, status: "expired" } }]);
  });

  test("una segunda pasada no encuentra nada que expirar ni escribe", () => {
    store = openStore({ path: ":memory:" });
    open({ kind: "review_note", title: "a", body: "a", subject: pull("merged") });
    expireMergedReviewNotes(store);
    const events = store.events.since(0).length;

    expect(expireMergedReviewNotes(store)).toBe(0);
    expect(store.events.since(0)).toHaveLength(events);
  });
});

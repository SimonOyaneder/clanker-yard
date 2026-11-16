import type { PrState } from "@clanker/api";
import { describe, expect, test } from "vitest";
import { evaluateMerge, GITHUB_BUTTON, type MergeFacts, type MergeRules } from "./merge-strategy";

/** Las listas del pack de ejemplo (`packages/testkit/fixtures/packs/example`). */
const EXAMPLE: MergeRules = {
  ready: ["notDraft", "approved", "ciGreen", "baseIsDefault", "noConflict", "noHumanOpenThreads", "notQueued"],
  offer: ["ready", "humanApprover", "noHumanTalk", "noCouncilOpen", "notHold"],
  auto: ["offer", "noHumanResolvedThreads", "noCouncilEver"],
};

/** Un PR aprobado por un humano, con el CI verde y nada pendiente. */
const clean: MergeFacts = {
  state: "open",
  baseRef: "main",
  baseIsDefault: true,
  mergeable: "clean",
  reviewDecision: "approved",
  ci: { state: "green", sha: "a", failing: [], flaky: [] },
  threads: { unresolved: 0, humanOpen: 0, humanResolved: 0, botOpen: 0, councilOpen: [], councilEver: false },
  talk: [],
  approvers: ["ana"],
  hold: false,
  defaultBranch: "main",
  queue: null,
};
const facts = (changes: Partial<MergeFacts>): MergeFacts => ({ ...clean, ...changes });
const talk = (): PrState["talk"] => [{ kind: "comment", author: "beto", at: "2026-11-10T10:00:00Z", excerpt: "ojo" }];

describe("ready, offer y auto", () => {
  test("un PR limpio cumple los tres niveles", () => {
    expect(evaluateMerge(clean, EXAMPLE)).toEqual({ ready: true, blockers: [], queue: null, offer: true, auto: true });
  });

  test("los blockers salen en el orden de la lista, con el texto de Control", () => {
    const blocked = facts({
      state: "draft",
      reviewDecision: "changes_requested",
      ci: { state: "red", sha: "a", failing: ["rspec"], flaky: [] },
      baseRef: "feat/padre",
      baseIsDefault: false,
      mergeable: "conflict",
      threads: { ...clean.threads, humanOpen: 2 },
    });

    expect(evaluateMerge(blocked, EXAMPLE)).toMatchObject({
      ready: false,
      offer: false,
      auto: false,
      blockers: ["es draft", "pidieron cambios", "el CI no está verde", "va sobre feat/padre, no sobre main", "tiene conflictos", "2 hilos de humanos sin resolver"],
    });
    expect(evaluateMerge(facts({ reviewDecision: "review_required" }), EXAMPLE).blockers).toEqual(["falta aprobación"]);
  });

  test("un PR sin checks que cuenten es CI verde, pendiente no", () => {
    expect(evaluateMerge(facts({ ci: { state: "none", sha: "a", failing: [], flaky: [] } }), EXAMPLE).ready).toBe(true);
    expect(evaluateMerge(facts({ ci: { state: "pending", sha: "a", failing: [], flaky: [] } }), EXAMPLE).blockers).toEqual(["el CI no está verde"]);
  });

  test("en cola apaga ready sin un blocker: `queue` ya lo dice", () => {
    expect(evaluateMerge(facts({ queue: "queued" }), EXAMPLE)).toEqual({ ready: false, blockers: [], queue: "queued", offer: false, auto: false });
    expect(evaluateMerge(facts({ queue: "failed" }), EXAMPLE)).toMatchObject({ ready: false, blockers: [], queue: "failed" });
  });

  test("offer pide un humano que apruebe y que nadie haya hablado ni haya council sin atender", () => {
    expect(evaluateMerge(facts({ approvers: [] }), EXAMPLE)).toMatchObject({ ready: true, offer: false });
    expect(evaluateMerge(facts({ talk: talk() }), EXAMPLE)).toMatchObject({ ready: true, offer: false });
    expect(evaluateMerge(facts({ threads: { ...clean.threads, councilOpen: [7] } }), EXAMPLE)).toMatchObject({ ready: true, offer: false });
  });

  test("auto no tolera hilos de humanos resueltos ni council, aunque estén resueltos", () => {
    expect(evaluateMerge(facts({ threads: { ...clean.threads, humanResolved: 1 } }), EXAMPLE)).toMatchObject({ offer: true, auto: false });
    expect(evaluateMerge(facts({ threads: { ...clean.threads, councilEver: true } }), EXAMPLE)).toMatchObject({ offer: true, auto: false });
  });

  test("hold apaga offer y auto sea cual sea la lista del pack, y no toca ready", () => {
    const withoutNotHold: MergeRules = { ...EXAMPLE, offer: ["ready", "humanApprover"] };

    expect(evaluateMerge(facts({ hold: true }), withoutNotHold)).toEqual({ ready: true, blockers: [], queue: null, offer: false, auto: false });
  });

  test("auto implica offer aunque la lista de auto no cite a offer", () => {
    const rules: MergeRules = { ...EXAMPLE, auto: ["noCouncilEver"] };

    expect(evaluateMerge(facts({ approvers: [] }), rules)).toMatchObject({ offer: false, auto: false });
    expect(evaluateMerge(clean, rules)).toMatchObject({ offer: true, auto: true });
  });

  test("un PR mergeado o cerrado no tiene merge", () => {
    for (const state of ["merged", "closed"] as const) {
      expect(evaluateMerge(facts({ state, queue: "queued" }), EXAMPLE)).toEqual({ ready: false, blockers: [], queue: null, offer: false, auto: false });
    }
  });
});

describe("el botón de GitHub (sin pack, o donde la estrategia no aplica)", () => {
  test("ofrece cuando está listo, sin pedir un humano que apruebe, y nunca mergea solo", () => {
    expect(evaluateMerge(facts({ approvers: [] }), GITHUB_BUTTON)).toEqual({ ready: true, blockers: [], queue: null, offer: true, auto: false });
    expect(evaluateMerge(clean, GITHUB_BUTTON).auto).toBe(false);
  });

  test("hold y un PR que no está listo no ofrecen", () => {
    expect(evaluateMerge(facts({ hold: true }), GITHUB_BUTTON)).toMatchObject({ ready: true, offer: false });
    expect(evaluateMerge(facts({ reviewDecision: "none" }), GITHUB_BUTTON)).toMatchObject({ ready: false, offer: false, blockers: ["falta aprobación"] });
  });
});

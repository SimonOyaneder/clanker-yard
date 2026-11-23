import type { FlowDef } from "@clanker/api"

// Flujos de ejemplo para `createMemoryAppData`: el que la app trae para elegir (con rondas y un parallel) y el de rebase,
// que es interno. El de juguete solo lo usan los tests.

export const SEED_TECHLEAD: FlowDef = {
  schema: 1,
  id: "de-issue-a-pr",
  name: "De issue a PR",
  description: "De la issue al PR con review: implementa, revisa en rondas, corre los checks, abre el PR y atiende el feedback hasta dejarlo listo.",
  trigger: { type: "issue.queued" },
  lane: "dev",
  params: {
    repo: "RepoRef",
    base: "string",
    reviewRounds: { type: "number", default: 3 },
    checkRounds: { type: "number", default: 3 },
    externalRounds: { type: "number", default: 3 },
  },
  start: "ws",
  nodes: {
    ws: { type: "action", action: "workspace.acquire", args: {}, on: { ok: "plan" } },
    plan: { type: "agent", role: "dev", mode: "plan", brief: {}, on: { ok: "implement" } },
    implement: { type: "agent", role: "dev", mode: "implement", brief: {}, on: { ok: "checks" } },
    checks: {
      type: "action",
      action: "recipe.check",
      args: {},
      on: { ok: "reviews", fail: { to: "fix", maxRounds: "$run.params.checkRounds", exhausted: { to: "reviews", note: "Tests o lint siguen rojos" } } },
    },
    fix: { type: "agent", role: "dev", mode: "fix", brief: {}, on: { ok: "checks" } },
    reviews: {
      type: "parallel",
      branches: ["rv-bugs", "rv-tests", "rv-patterns", "rv-lore"],
      join: { fn: "items.merge" },
      on: {
        ok: "sync",
        changes: { to: "fix", counter: "review", maxRounds: "$run.params.reviewRounds", exhausted: { to: "sync", note: "Quedan 🔴/🟡 tras las rondas de review" } },
      },
    },
    "rv-bugs": { type: "agent", role: "review-bugs", mode: "review", brief: {} },
    "rv-tests": { type: "agent", role: "review-tests", mode: "review", brief: {} },
    "rv-patterns": { type: "agent", role: "review-patterns", mode: "review", brief: {} },
    "rv-lore": { type: "agent", role: "review-lore", mode: "review", brief: {} },
    sync: { type: "action", action: "workspace.syncBase", args: {}, on: { same: "commit", rebased: { to: "checks", maxRounds: 3, exhausted: "commit" } } },
    commit: { type: "agent", role: "committer", mode: "plan", brief: {}, on: { ok: "publish" } },
    publish: { type: "action", action: "pr.publish", args: {}, on: { ok: "feedback" } },
    feedback: { type: "flow", flow: "pr-feedback", params: {}, on: { done: "@done", blocked: "@blocked", failed: "@failed" } },
  },
}

export const SEED_TOY: FlowDef = {
  schema: 1,
  id: "juguete",
  name: "Juguete",
  trigger: { type: "manual" },
  start: "acquire",
  nodes: {
    acquire: { type: "action", action: "workspace.acquire", args: {}, on: { ok: "saludar" } },
    saludar: { type: "agent", role: "juguete", mode: "saludar", brief: {}, on: { ok: "release" } },
    release: { type: "action", action: "workspace.release", args: {}, on: { ok: "@done" } },
  },
}

// El flujo que rebasea un PR en conflicto: se dispara solo y lee `checkRounds` y `externalRounds` igual que el flujo por defecto.
export const SEED_REBASE: FlowDef = {
  schema: 1,
  id: "rebase-conflicto",
  name: "Rebase de un PR en conflicto",
  internal: true,
  trigger: { type: "pr.conflict" },
  lane: "maintenance",
  params: {
    pr: "PrRef",
    rebaseNonDraft: { type: "string", default: "auto" },
    conflictRounds: { type: "number", default: 20 },
    checkRounds: { type: "number", default: 2 },
    externalRounds: { type: "number", default: 3 },
  },
  start: "rebase",
  nodes: {
    rebase: { type: "action", action: "workspace.rebase", args: {}, on: { ok: "@done" } },
  },
}

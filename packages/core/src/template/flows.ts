import type { FlowDef } from "@clanker/api";

// Las plantillas de flujo de "equipo clanker-loop" (`docs/design.html#d-flows`, "Plantillas incluidas"). Son
// datos que usan los roles de esta plantilla; el core no las nombra. Las acciones y waits que citan los
// registran sus módulos (Workspaces, CodeHost), así que `installBuiltins` las guardará cuando existan todas.
//
// Desvío del diseño: `workspace.acquire` recibe `branch` (el id de la issue, como en `juguete`) en lugar de `issue`.

/** "Techlead clásico": el flujo del techlead sin LLM orquestador. Llama a `pr-feedback` para el tramo externo. */
export const TECHLEAD_CLASICO: FlowDef = {
  schema: 1,
  id: "techlead-clasico",
  name: "Techlead clásico",
  trigger: { type: "issue.queued" },
  lane: "dev",
  params: {
    repo: "RepoRef",
    base: "string",
    reviewRounds: { type: "number", default: 3 },
    checkRounds: { type: "number", default: 3 },
    externalRounds: { type: "number", default: 3 },
  },
  limits: { maxCostUsd: null, maxSteps: 200 },
  start: "ws",
  nodes: {
    ws: {
      type: "action",
      action: "workspace.acquire",
      args: { repo: "$run.params.repo", branch: "$run.subject.id", base: "$run.params.base" },
      on: { ok: "plan" },
    },
    plan: {
      type: "agent",
      role: "dev",
      mode: "plan",
      brief: { issue: "$run.subject", ws: "$ws" },
      on: { ok: "plan-check" },
    },
    "plan-check": {
      type: "agent",
      role: "plan-check",
      mode: "check",
      when: "$plan.issueDoubts",
      brief: { plan: "$plan" },
      on: { ok: "implement", changes: { to: "plan", maxRounds: 2, exhausted: "implement" } },
    },
    implement: {
      type: "agent",
      role: "dev",
      mode: "implement",
      resumeFrom: "plan",
      brief: { plan: "$plan", notes: "$plan-check" },
      on: { ok: "checks" },
    },
    checks: {
      type: "action",
      action: "recipe.check",
      args: { ws: "$ws", scope: "changed" },
      on: {
        ok: "reviews",
        fail: {
          to: "fix",
          maxRounds: "$run.params.checkRounds",
          exhausted: { to: "reviews", note: "Tests o lint siguen rojos" },
        },
      },
    },
    fix: {
      type: "agent",
      role: "dev",
      mode: "fix",
      resumeFrom: "implement",
      brief: { plan: "$plan", input: "$prev" },
      escalate: { counter: "review", from: 2, profileRole: "dev-escala" },
      on: { ok: "checks" },
    },
    reviews: {
      type: "parallel",
      branches: ["rv-bugs", "rv-tests", "rv-patterns", "rv-lore"],
      rerun: "not-ok",
      onBranchError: "ignore",
      join: { fn: "items.merge", args: { items: "findings", rank: "severity", changesIf: ["red", "yellow"] } },
      on: {
        ok: "sync",
        changes: {
          to: "fix",
          counter: "review",
          maxRounds: "$run.params.reviewRounds",
          exhausted: { to: "sync", note: "Quedan 🔴/🟡 tras las rondas de review" },
        },
      },
    },
    "rv-bugs": { type: "agent", role: "review-bugs", mode: "review", brief: { ws: "$ws", plan: "$plan", previous: "$self" } },
    "rv-tests": { type: "agent", role: "review-tests", mode: "review", brief: { ws: "$ws", plan: "$plan", previous: "$self" } },
    "rv-patterns": { type: "agent", role: "review-patterns", mode: "review", brief: { ws: "$ws", plan: "$plan", previous: "$self" } },
    "rv-lore": { type: "agent", role: "review-lore", mode: "review", brief: { ws: "$ws", plan: "$plan", previous: "$self" } },
    sync: {
      type: "action",
      action: "workspace.syncBase",
      args: { ws: "$ws" },
      on: {
        same: "commit",
        rebased: { to: "checks", maxRounds: 3, exhausted: "commit" },
        conflict: { to: "fix", maxRounds: 2, exhausted: "@failed" },
      },
    },
    commit: {
      type: "agent",
      role: "committer",
      mode: "plan",
      brief: { ws: "$ws", cuts: "$implement.cuts", issue: "$run.subject" },
      on: { ok: "publish" },
    },
    publish: {
      type: "action",
      action: "pr.publish",
      args: { ws: "$ws", plan: "$commit", draft: true },
      on: { ok: "feedback", replan: { to: "commit", maxRounds: 2, exhausted: "@failed" } },
    },
    feedback: {
      type: "flow",
      flow: "pr-feedback",
      params: { ws: "$ws", pr: "$publish.pr", externalRounds: "$run.params.externalRounds" },
      on: { done: "@done", blocked: "@blocked", failed: "@failed" },
    },
  },
};

/**
 * El tramo de feedback externo (bot de review y CI) de un PR, como subflujo: lo reusan "Techlead clásico",
 * rebase y restack. Las rondas con el bot y con el CI comparten el contador `external`.
 */
export const PR_FEEDBACK: FlowDef = {
  schema: 1,
  id: "pr-feedback",
  name: "Feedback del PR",
  trigger: { type: "subflow" },
  params: { ws: "Workspace", pr: "PrRef", externalRounds: { type: "number", default: 3 } },
  start: "bot-req",
  nodes: {
    "bot-req": {
      type: "action",
      action: "review.requestBot",
      args: { pr: "$run.params.pr" },
      on: { ok: "bot-wait", none: "ci-wait" },
    },
    "bot-wait": {
      type: "wait",
      event: "pr.botReview",
      args: { pr: "$run.params.pr", after: "$prev.requestedAt" },
      timeoutSec: 540,
      on: { lgtm: "ci-wait", findings: "triage", timeout: { to: "ci-wait", note: "El bot no respondió" } },
    },
    triage: {
      type: "agent",
      role: "triage",
      mode: "bot",
      brief: { items: "$bot-wait.items" },
      on: {
        fix: {
          to: "fix",
          counter: "external",
          maxRounds: "$run.params.externalRounds",
          exhausted: { to: "reply", note: "Sin LGTM tras las rondas externas" },
        },
        reply: "reply",
      },
    },
    fix: {
      type: "agent",
      role: "dev",
      mode: "fix",
      resumeFrom: "implement",
      brief: { input: "$prev" },
      on: { ok: "checks" },
    },
    checks: {
      type: "action",
      action: "recipe.check",
      args: { ws: "$run.params.ws", scope: "changed" },
      on: { ok: "light", fail: { to: "fix", maxRounds: 2, exhausted: "light" } },
    },
    light: {
      type: "parallel",
      branches: ["lr-bugs", "lr-tests"],
      join: { fn: "items.merge", args: { items: "findings", rank: "severity", changesIf: ["red", "yellow"] } },
      on: { ok: "fixups", changes: { to: "fix", maxRounds: 1, exhausted: "fixups" } },
    },
    "lr-bugs": { type: "agent", role: "review-bugs", mode: "re-review", brief: { ws: "$run.params.ws" } },
    "lr-tests": {
      type: "agent",
      role: "review-tests",
      mode: "re-review",
      when: "$checks.specsChanged",
      brief: { ws: "$run.params.ws" },
    },
    fixups: {
      type: "action",
      action: "pr.pushFixups",
      // `items` son los hallazgos del bot (sin ellos, p. ej. tras un CI rojo, es null y la acción lo toma como
      // ninguno); `route` es el reporte del committer, que solo existe cuando la acción ya devolvió `route`.
      args: { ws: "$run.params.ws", items: "$bot-wait.items", route: "$route" },
      on: { ok: "reply-fixed", route: { to: "route", maxRounds: 1, exhausted: "@failed" } },
    },
    route: {
      type: "agent",
      role: "committer",
      mode: "route",
      brief: { hunks: "$fixups.unrouted" },
      on: { ok: "fixups" },
    },
    "reply-fixed": {
      type: "action",
      action: "pr.reply",
      args: { pr: "$run.params.pr", triage: "$triage", shas: "$fixups.byItem", rerequestBot: true },
      on: { ok: "bot-wait" },
    },
    reply: {
      type: "action",
      action: "pr.reply",
      args: { pr: "$run.params.pr", triage: "$triage" },
      on: { ok: "ci-wait" },
    },
    "ci-wait": {
      type: "wait",
      event: "pr.ci",
      args: { pr: "$run.params.pr" },
      timeoutSec: 5400,
      on: { ok: "@done", fail: "ci-triage", timeout: { to: "@done", note: "CI sigue corriendo" } },
    },
    "ci-triage": {
      type: "agent",
      role: "triage",
      mode: "ci",
      brief: { items: "$ci-wait.failures" },
      on: {
        fix: {
          to: "fix",
          counter: "external",
          maxRounds: "$run.params.externalRounds",
          exhausted: { to: "@done", note: "CI rojo por el cambio" },
        },
        foreign: { to: "@done", note: "CI rojo ajeno o flaky" },
      },
    },
  },
};

export const flows: Record<string, FlowDef> = { "techlead-clasico": TECHLEAD_CLASICO, "pr-feedback": PR_FEEDBACK };

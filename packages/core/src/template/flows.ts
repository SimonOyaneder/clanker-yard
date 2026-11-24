import type { FlowDef, Node } from "@clanker/api";

// Las plantillas de flujo de "equipo clanker-loop" (`docs/design.html#d-flows`, "Plantillas incluidas"). Son
// datos que usan los roles de esta plantilla; el core no las nombra. Las acciones y waits que citan los
// registran sus módulos (Workspaces, CodeHost); `installBuiltins` las guarda en cada arranque, después de que esos módulos
// registraron todo lo que citan.
//
// Desvío del diseño: `workspace.acquire` recibe `branch` (`$run.params.branch`, que pone el core) en lugar de `issue`.

const reviewJoin = {
  fn: "items.merge",
  args: { items: "findings", rank: "severity", changesIf: ["red", "yellow"], previous: "$self.byBranch" },
};

const lightReview: Node = {
  type: "parallel",
  branches: ["lr-bugs", "lr-tests"],
  rerun: { pending: "$self.pending", onChange: ["lr-bugs", "lr-tests"] },
  join: reviewJoin,
  on: { ok: "fixups", changes: { to: "fix", maxRounds: 1, exhausted: "fixups" } },
};

function exhaustedGate(question: string, next: string): Node {
  return {
    type: "gate", question,
    options: [{ id: "continue", label: "Aceptar el riesgo y continuar hacia el PR draft" }, { id: "stop", label: "Detener sin publicar" }],
    timeoutSec: 86_400, default: "stop",
    on: { continue: next, stop: "@blocked" },
  };
}

/** De issue a PR delega el feedback del bot y la CI al subflujo `pr-feedback`. */
export const DE_ISSUE_A_PR: FlowDef = {
  schema: 1,
  id: "de-issue-a-pr",
  name: "De issue a PR",
  description: "De la issue al PR con review: implementa, revisa en rondas, corre los checks, abre el PR y atiende el feedback hasta dejarlo listo.",
  trigger: { type: "issue.queued" },
  lane: "dev",
  params: {
    repo: "RepoRef",
    base: "string",
    /** La branch de la issue (`eng-1234-slug`): la pone el core al lanzar la corrida (`issueBranch`). */
    branch: "string",
    /** `repo#n` de los PRs de otros repos de los que depende (los pone el Scheduler desde la cola): abren el body del PR. */
    dependsOn: { type: "string[]", default: [] },
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
      args: { repo: "$run.params.repo", branch: "$run.params.branch", base: "$run.params.base" },
      on: { ok: "plan" },
    },
    plan: {
      type: "agent",
      role: "dev",
      mode: "plan",
      brief: { issue: "$run.subject", ws: "$ws", notes: "$plan-check" },
      on: { ok: "plan-check" },
    },
    "plan-check": {
      type: "agent",
      role: "plan-check",
      mode: "check",
      when: "$plan.issueDoubts",
      brief: { plan: "$plan" },
      on: {
        ok: "implement",
        changes: { to: "plan", maxRounds: 2, exhausted: "plan-decision" },
        covered: { to: "@done", note: "Objetivo ya cubierto por el comportamiento existente; sin cambios ni PR" },
        "needs-decision": "plan-decision",
      },
    },
    "plan-decision": {
      type: "gate",
      question: "El plan no tiene un cambio justificado. Revisa el reporte de plan-check: ¿se aclaró la issue para volver a planificar?",
      options: [
        { id: "replan", label: "Ya aclaré la issue: volver a planificar" },
        { id: "leave", label: "Dejar la corrida bloqueada sin implementar" },
      ],
      timeoutSec: 86_400,
      default: "leave",
      on: { replan: { to: "plan", maxRounds: 2, exhausted: "@blocked" }, leave: "@blocked" },
    },
    implement: {
      type: "agent",
      role: "dev",
      mode: "implement",
      resumeFrom: "plan",
      brief: { plan: "$plan", notes: "$plan-check" },
      escalate: { counter: "review", from: 2, profileRole: "dev-escala" },
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
          exhausted: "checks-exhausted",
        },
      },
    },
    "checks-exhausted": exhaustedGate("Los checks siguen rojos tras agotar los intentos. ¿Continuar con las reviews y permitir publicar el draft con esos checks rojos?", "reviews"),
    "reviews-exhausted": exhaustedGate("Quedan hallazgos rojos o amarillos tras agotar las rondas de review. ¿Permitir publicar el draft con esos hallazgos abiertos?", "sync"),
    fix: {
      type: "agent",
      role: "dev",
      mode: "fix",
      resumeFrom: "implement",
      // El dev recibe las instrucciones consolidadas; los pendientes por reviewer son para la ronda siguiente.
      brief: { plan: "$plan", input: { findings: "$prev.findings", failures: "$prev.failures", checks: "$prev.checks", conflicts: "$prev.conflicts", backup: "$prev.backup" } },
      escalate: { counter: "review", from: 2, profileRole: "dev-escala" },
      on: { ok: "checks" },
    },
    reviews: {
      type: "parallel",
      branches: ["rv-bugs", "rv-tests", "rv-patterns", "rv-lore"],
      rerun: { pending: "$self.pending", onChange: ["rv-tests", "rv-patterns"] },
      onBranchError: "fail",
      join: reviewJoin,
      on: {
        ok: "sync",
        changes: {
          to: "fix",
          counter: "review",
          maxRounds: "$run.params.reviewRounds",
          exhausted: "reviews-exhausted",
        },
      },
    },
    "rv-bugs": { type: "agent", role: "review-bugs", mode: "review", brief: { ws: "$ws", plan: "$plan", previous: "$reviews.byBranch.rv-bugs", rejected: "$fix.rejected" } },
    "rv-tests": { type: "agent", role: "review-tests", mode: "review", brief: { ws: "$ws", plan: "$plan", previous: "$reviews.byBranch.rv-tests", rejected: "$fix.rejected" } },
    "rv-patterns": { type: "agent", role: "review-patterns", mode: "review", brief: { ws: "$ws", plan: "$plan", previous: "$reviews.byBranch.rv-patterns", rejected: "$fix.rejected" } },
    "rv-lore": { type: "agent", role: "review-lore", mode: "review", brief: { ws: "$ws", plan: "$plan", previous: "$reviews.byBranch.rv-lore", rejected: "$fix.rejected" } },
    sync: {
      type: "action",
      action: "workspace.syncBase",
      args: { ws: "$ws" },
      on: {
        same: "commit",
        rebased: { to: "checks", maxRounds: 3, exhausted: { to: "@blocked", note: "La base volvió a cambiar: el último rebase no pasó por checks ni reviews. No se publicó el PR." } },
        conflict: { to: "fix", maxRounds: 2, exhausted: "@failed" },
      },
    },
    commit: {
      type: "agent",
      role: "committer",
      mode: "plan",
      brief: { ws: "$ws", cuts: "$implement.cuts", issue: "$run.subject", failures: "$prev.failures" },
      on: { ok: "publish" },
    },
    publish: {
      type: "action",
      action: "pr.publish",
      args: { ws: "$ws", plan: "$commit", draft: true, dependsOn: "$run.params.dependsOn" },
      on: {
        ok: "feedback",
        local: { to: "@done", note: "PR local: se publica cuando se mergee su base" },
        replan: { to: "commit", maxRounds: 2, exhausted: "@failed" },
      },
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
 * El tramo de feedback externo (bot de review y CI) de un PR, como subflujo: lo reusan "De issue a PR",
 * rebase y restack. Las rondas con el bot y con el CI comparten el contador `external`.
 */
export const PR_FEEDBACK: FlowDef = {
  schema: 1,
  id: "pr-feedback",
  name: "Feedback del PR",
  internal: true,
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
    light: lightReview,
    "lr-bugs": { type: "agent", role: "review-bugs", mode: "re-review", brief: { ws: "$run.params.ws", previous: "$light.byBranch.lr-bugs" } },
    "lr-tests": {
      type: "agent",
      role: "review-tests",
      mode: "re-review",
      brief: { ws: "$run.params.ws", previous: "$light.byBranch.lr-tests" },
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
      brief: { hunks: "$fixups.unrouted", commits: "$fixups.commits", failures: "$fixups.failures" },
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
      on: { ok: "ci-bots", fail: "ci-report", timeout: { to: "@done", note: "CI sigue corriendo" } },
    },
    // El check rojo con el detalle de su falla (los tests que fallaron), si el pack sabe cómo traerlo.
    "ci-report": {
      type: "action",
      action: "ci.failureReport",
      args: { pr: "$run.params.pr", failures: "$ci-wait.failures" },
      on: { ok: "ci-triage" },
    },
    // Con el CI verde, los threads que dejaron los otros bots que el pack deja resolver (lint, cobertura): pasan
    // por triage, se arreglan con fixups y se responden y resuelven, y el CI vuelve a correr sobre el push.
    "ci-bots": {
      type: "action",
      action: "pr.botThreads",
      args: { pr: "$run.params.pr" },
      on: { ok: "ci-bots-triage", none: "@done" },
    },
    "ci-bots-triage": {
      type: "agent",
      role: "triage",
      mode: "bot",
      brief: { items: "$ci-bots.items" },
      on: {
        fix: {
          to: "ci-bots-fix",
          counter: "external",
          maxRounds: "$run.params.externalRounds",
          exhausted: { to: "ci-bots-reply", note: "Los bots del CI siguen comentando tras las rondas externas" },
        },
        reply: "ci-bots-reply",
      },
    },
    "ci-bots-fix": {
      type: "agent",
      role: "dev",
      mode: "fix",
      resumeFrom: "implement",
      brief: { input: "$prev" },
      on: { ok: "ci-bots-checks" },
    },
    "ci-bots-checks": {
      type: "action",
      action: "recipe.check",
      args: { ws: "$run.params.ws", scope: "changed" },
      on: { ok: "ci-bots-fixups", fail: { to: "ci-bots-fix", maxRounds: 2, exhausted: "ci-bots-fixups" } },
    },
    "ci-bots-fixups": {
      type: "action",
      action: "pr.pushFixups",
      args: { ws: "$run.params.ws", items: "$ci-bots.items", route: "$ci-bots-route" },
      on: { ok: "ci-bots-reply-fixed", route: { to: "ci-bots-route", maxRounds: 1, exhausted: "@failed" } },
    },
    "ci-bots-route": {
      type: "agent",
      role: "committer",
      mode: "route",
      brief: { hunks: "$ci-bots-fixups.unrouted", commits: "$ci-bots-fixups.commits", failures: "$ci-bots-fixups.failures" },
      on: { ok: "ci-bots-fixups" },
    },
    "ci-bots-reply-fixed": {
      type: "action",
      action: "pr.reply",
      args: { pr: "$run.params.pr", triage: "$ci-bots-triage", shas: "$ci-bots-fixups.byItem" },
      on: { ok: "ci-wait" },
    },
    "ci-bots-reply": {
      type: "action",
      action: "pr.reply",
      args: { pr: "$run.params.pr", triage: "$ci-bots-triage" },
      on: { ok: "@done" },
    },
    "ci-triage": {
      type: "agent",
      role: "triage",
      mode: "ci",
      brief: { items: "$ci-report.items" },
      on: {
        fix: {
          to: "fix",
          counter: "external",
          maxRounds: "$run.params.externalRounds",
          exhausted: { to: "@done", note: "CI rojo por el cambio" },
        },
        foreign: { to: "@done", note: "CI rojo ajeno o flaky" },
        unsure: "ci-unsure",
      },
    },
    // Sin evidencia el triage no adivina: una persona decide si el cambio lo causó.
    "ci-unsure": {
      type: "gate",
      question:
        "El CI quedó rojo y el triage no pudo saber si lo causó el cambio (su reporte dice qué le faltó). ¿Lo arregla el dev o lo dejo así?",
      options: [
        { id: "fix", label: "Que el dev lo arregle" },
        { id: "leave", label: "Dejarlo así: lo reviso yo" },
      ],
      // Sin respuesta en un día queda como "lo reviso yo": el PR sigue en rojo con la nota.
      timeoutSec: 86_400,
      default: "leave",
      on: {
        fix: {
          to: "ci-fix",
          counter: "external",
          maxRounds: "$run.params.externalRounds",
          exhausted: { to: "@done", note: "CI rojo por el cambio" },
        },
        leave: { to: "@done", note: "CI rojo sin causa clara: lo revisa una persona" },
      },
    },
    "ci-fix": {
      type: "agent",
      role: "dev",
      mode: "fix",
      resumeFrom: "implement",
      brief: { input: "$ci-triage" },
      on: { ok: "checks" },
    },
  },
};

const REBASE_ROUNDS_EXHAUSTED = {
  to: "abort",
  note: "El conflicto no quedó resuelto tras las rondas del agente: se abortó el rebase y el PR sigue en conflicto",
};

/**
 * "Rebase por conflicto": un PR del sistema que quedó en conflicto con su base (`pr.conflict`; `startTriggers`
 * no lo arranca si el PR tiene threads de council: un rebase reescribiría su historia). Corre en mantenimiento.
 * `repo`, `branch`, `base` y `pr` los pone el trigger; `rebaseNonDraft` (`auto` o `ask`) es la política del
 * proyecto para un PR fuera de draft sin conflicto de comportamiento (decisión 30).
 *
 * El agente resuelve un commit a la vez y el core hace `continue`. Si resolver exige decidir comportamiento
 * (`behavior`), el agente deja la resolución más conservadora: en draft el flujo sigue con una nota; fuera de
 * draft un gate estaciona solo esta corrida y el PR queda en conflicto hasta que alguien decida (decisión 32).
 * Un rebase que falla sin conflicto estaciona solo esta corrida con una pregunta. Cada visita de `workspace.rebase` pasa la misma `base`: `from` (el sha viejo de la base, si se squasheó) se
 * calcula contra ella. Lo que deja el `afterRebase` de la receta lo commitea el core (`workspace.commitAfterRebase`).
 * Tras el push, un draft sigue con `pr-feedback` (que pide `/review`) y uno listo deja una nota para la persona.
 */
export const REBASE_CONFLICTO: FlowDef = {
  schema: 1,
  id: "rebase-conflicto",
  name: "Rebase por conflicto",
  internal: true,
  trigger: { type: "pr.conflict", filter: { local: false } },
  lane: "maintenance",
  params: {
    pr: "PrRef",
    repo: "RepoRef",
    branch: "string",
    base: "string",
    rebaseNonDraft: { type: "string", default: "auto" },
    conflictRounds: { type: "number", default: 20 },
    checkRounds: { type: "number", default: 2 },
    externalRounds: { type: "number", default: 3 },
  },
  limits: { maxCostUsd: null, maxSteps: 200 },
  start: "ws",
  nodes: {
    ws: {
      type: "action",
      action: "workspace.attach",
      args: { repo: "$run.params.repo", branch: "$run.params.branch", base: "$run.params.base" },
      on: { ok: "rebase" },
    },
    rebase: {
      type: "action",
      action: "workspace.rebase",
      args: { ws: "$ws", base: "$run.params.base" },
      on: {
        clean: "checks",
        conflict: { to: "resolve", counter: "conflict", maxRounds: "$run.params.conflictRounds", exhausted: REBASE_ROUNDS_EXHAUSTED },
        error: "rebase-error",
      },
    },
    "rebase-error": {
      type: "gate",
      question:
        "El rebase falló sin conflicto (ver el error del paso): se abortó y la branch quedó como estaba. ¿Lo reintento o dejo el PR en conflicto?",
      options: [
        { id: "retry", label: "Reintentar el rebase" },
        { id: "leave", label: "Dejar el PR en conflicto" },
      ],
      on: { retry: { to: "rebase", maxRounds: 2, exhausted: "@blocked" }, leave: "@blocked" },
    },
    resolve: {
      type: "agent",
      role: "dev",
      mode: "conflict",
      brief: { failures: "$prev.failures" },
      on: { resolved: "policy", behavior: "behavior-check" },
    },
    policy: {
      type: "action",
      action: "pr.rebaseApproval",
      args: { pr: "$run.params.pr", behavior: false, policy: "$run.params.rebaseNonDraft" },
      on: { proceed: "continue", ask: "ask" },
    },
    "behavior-check": {
      type: "action",
      action: "pr.rebaseApproval",
      args: { pr: "$run.params.pr", behavior: true, policy: "$run.params.rebaseNonDraft" },
      on: {
        proceed: { to: "continue", note: "Resolver el conflicto exigía decidir comportamiento: se aplicó la resolución más conservadora, revísala" },
        ask: "behavior-gate",
      },
    },
    ask: {
      type: "gate",
      question: "El PR ya no está en draft y el proyecto pide confirmar antes de rebasearlo (rebaseNonDraft: ask). El conflicto ya está resuelto en el worktree. ¿Sigo con el rebase?",
      options: [
        { id: "continue", label: "Seguir con el rebase" },
        { id: "abort", label: "Dejar el PR en conflicto" },
      ],
      on: { continue: "continue", abort: "abort" },
    },
    "behavior-gate": {
      type: "gate",
      question:
        "Resolver el conflicto exige decidir comportamiento y el PR ya no está en draft. El agente dejó la resolución más conservadora (ver su nota). ¿Sigo con el rebase?",
      options: [
        { id: "continue", label: "Seguir con esa resolución" },
        { id: "abort", label: "Dejar el PR en conflicto" },
      ],
      on: { continue: "continue", abort: "abort" },
    },
    continue: {
      type: "action",
      action: "workspace.rebase",
      args: { ws: "$ws", base: "$run.params.base", continue: true },
      on: {
        clean: "checks",
        conflict: { to: "resolve", counter: "conflict", maxRounds: "$run.params.conflictRounds", exhausted: REBASE_ROUNDS_EXHAUSTED },
        error: "rebase-error",
      },
    },
    checks: {
      type: "action",
      action: "recipe.check",
      args: { ws: "$ws", scope: "changed", afterRebase: true },
      on: {
        ok: "commit",
        fail: { to: "fix", maxRounds: "$run.params.checkRounds", exhausted: { to: "commit", note: "Tests o lint siguen rojos tras el rebase" } },
      },
    },
    fix: {
      type: "agent",
      role: "dev",
      mode: "fix",
      brief: { failures: "$prev.failures" },
      on: { ok: "checks" },
    },
    commit: {
      type: "action",
      action: "workspace.commitAfterRebase",
      args: { ws: "$ws" },
      on: { ok: "push" },
    },
    push: {
      type: "action",
      action: "pr.pushLease",
      args: { ws: "$ws" },
      on: { draft: "feedback", ready: { to: "@done", note: "Pide /review: el PR salió del conflicto y ya no está en draft" } },
    },
    feedback: {
      type: "flow",
      flow: "pr-feedback",
      params: { ws: "$ws", pr: "$run.params.pr", externalRounds: "$run.params.externalRounds" },
      on: { done: "@done", blocked: "@blocked", failed: "@failed" },
    },
    abort: {
      type: "action",
      action: "workspace.rebaseAbort",
      args: { ws: "$ws" },
      on: { ok: "@blocked" },
    },
  },
};

/**
 * "Rebase por conflicto" de un PR local (stacks locales, `pr.conflict` con `local: true`): el restack no pudo dejarlo
 * sobre su base nueva. Como `rebase-conflicto` pero en la máquina: `workspace.acquire` en vez de `attach` (la branch no
 * está en el remoto), sin `pr.rebaseApproval` (un PR local se trata como un draft: un conflicto de comportamiento
 * sigue con la resolución conservadora y una nota) y sin push: `pr.saveLocal` guarda la punta y la base en la fila.
 * Si quedó sobre la branch por defecto se publica (`pr.promote` y `pr-feedback`); si no, sigue local.
 */
export const REBASE_CONFLICTO_LOCAL: FlowDef = {
  schema: 1,
  id: "rebase-conflicto-local",
  name: "Rebase por conflicto de un PR local",
  internal: true,
  trigger: { type: "pr.conflict", filter: { local: true } },
  lane: "maintenance",
  params: {
    prId: "string",
    repo: "RepoRef",
    branch: "string",
    base: "string",
    conflictRounds: { type: "number", default: 20 },
    checkRounds: { type: "number", default: 2 },
    externalRounds: { type: "number", default: 3 },
  },
  limits: { maxCostUsd: null, maxSteps: 200 },
  start: "ws",
  nodes: {
    ws: {
      type: "action",
      action: "workspace.acquire",
      args: { repo: "$run.params.repo", branch: "$run.params.branch", base: "$run.params.base" },
      on: { ok: "rebase" },
    },
    rebase: {
      type: "action",
      action: "workspace.rebase",
      args: { ws: "$ws", base: "$run.params.base" },
      on: {
        clean: "checks",
        conflict: { to: "resolve", counter: "conflict", maxRounds: "$run.params.conflictRounds", exhausted: REBASE_ROUNDS_EXHAUSTED },
        error: { to: "@blocked", note: "El rebase del PR local falló sin conflicto: la branch quedó como estaba" },
      },
    },
    resolve: {
      type: "agent",
      role: "dev",
      mode: "conflict",
      brief: { failures: "$prev.failures" },
      on: {
        resolved: "continue",
        behavior: { to: "continue", note: "Resolver el conflicto exigía decidir comportamiento: se aplicó la resolución más conservadora, revísala" },
      },
    },
    continue: {
      type: "action",
      action: "workspace.rebase",
      args: { ws: "$ws", base: "$run.params.base", continue: true },
      on: {
        clean: "checks",
        conflict: { to: "resolve", counter: "conflict", maxRounds: "$run.params.conflictRounds", exhausted: REBASE_ROUNDS_EXHAUSTED },
        error: { to: "@blocked", note: "El rebase del PR local falló sin conflicto: la branch quedó como estaba" },
      },
    },
    checks: {
      type: "action",
      action: "recipe.check",
      args: { ws: "$ws", scope: "changed", afterRebase: true },
      on: {
        ok: "commit",
        fail: { to: "fix", maxRounds: "$run.params.checkRounds", exhausted: { to: "commit", note: "Tests o lint siguen rojos tras el rebase" } },
      },
    },
    fix: {
      type: "agent",
      role: "dev",
      mode: "fix",
      brief: { failures: "$prev.failures" },
      on: { ok: "checks" },
    },
    commit: {
      type: "action",
      action: "workspace.commitAfterRebase",
      args: { ws: "$ws" },
      on: { ok: "save" },
    },
    save: {
      type: "action",
      action: "pr.saveLocal",
      args: { ws: "$ws", prId: "$run.params.prId" },
      on: { local: { to: "@done", note: "PR local: se publica cuando se mergee su base" }, promotable: "promote" },
    },
    promote: {
      type: "action",
      action: "pr.promote",
      args: { ws: "$ws", prId: "$run.params.prId" },
      on: { ok: "feedback" },
    },
    feedback: {
      type: "flow",
      flow: "pr-feedback",
      params: { ws: "$ws", pr: "$promote.pr", externalRounds: "$run.params.externalRounds" },
      on: { done: "@done", blocked: "@blocked", failed: "@failed" },
    },
    abort: {
      type: "action",
      action: "workspace.rebaseAbort",
      args: { ws: "$ws" },
      on: { ok: "@blocked" },
    },
  },
};

/**
 * "Base combinada en conflicto" (`pr.baseConflict`, carril maintenance): al restackear un PR que sale de una base
 * combinada, sus padres chocan entre sí. El core junta los padres con un merge real en un worktree propio
 * (`resolveBranch`) con `rerere`; el dev resuelve lo que choca (modo conflict) y el core sigue con los demás padres.
 * Con todos juntos, `workspace.combinedBaseMerge` rearma la base por el camino de siempre (que con `rerere` ya no choca)
 * y `pr.requestRebase` pide el rebase del PR sobre ella (`rebase-conflicto` o `rebase-conflicto-local`). La misma
 * resolución se reaplica sola la próxima vez que esos padres se muevan.
 */
export const BASE_COMBINADA_CONFLICTO: FlowDef = {
  schema: 1,
  id: "base-combinada-conflicto",
  name: "Base combinada en conflicto",
  internal: true,
  trigger: { type: "pr.baseConflict" },
  lane: "maintenance",
  params: {
    prId: "string",
    repo: "RepoRef",
    base: "string",
    resolveBranch: "string",
    defaultBranch: "string",
    conflictRounds: { type: "number", default: 20 },
  },
  limits: { maxCostUsd: null, maxSteps: 200 },
  start: "ws",
  nodes: {
    ws: {
      type: "action",
      action: "workspace.acquire",
      args: { repo: "$run.params.repo", branch: "$run.params.resolveBranch", base: "$run.params.defaultBranch" },
      on: { ok: "merge" },
    },
    merge: {
      type: "action",
      action: "workspace.combinedBaseMerge",
      args: { ws: "$ws", base: "$run.params.base" },
      on: {
        clean: "rebase",
        conflict: { to: "resolve", counter: "conflict", maxRounds: "$run.params.conflictRounds", exhausted: { to: "@blocked", note: "La base combinada sigue en conflicto tras las rondas del agente" } },
        error: { to: "@blocked", note: "La base combinada no se pudo rearmar con la resolución" },
      },
    },
    resolve: {
      type: "agent",
      role: "dev",
      mode: "conflict",
      brief: { failures: "$prev.failures" },
      on: {
        resolved: "continue",
        behavior: { to: "continue", note: "Juntar los padres exigía decidir comportamiento: se aplicó la resolución más conservadora, revísala" },
      },
    },
    continue: {
      type: "action",
      action: "workspace.combinedBaseMerge",
      args: { ws: "$ws", base: "$run.params.base", continue: true },
      on: {
        clean: "rebase",
        conflict: { to: "resolve", counter: "conflict", maxRounds: "$run.params.conflictRounds", exhausted: { to: "@blocked", note: "La base combinada sigue en conflicto tras las rondas del agente" } },
        error: { to: "@blocked", note: "La base combinada no se pudo rearmar con la resolución" },
      },
    },
    rebase: {
      type: "action",
      action: "pr.requestRebase",
      args: { prId: "$run.params.prId", base: "$run.params.base" },
      on: { ok: "@done" },
    },
  },
};

/**
 * Le pide `/review` a cada draft que el restack pusheó (`stack.restack` y `stack.restackRewritten` dejan
 * `changedDrafts` en el nodo `restack` de quien lo llama): una corrida de `restack-feedback` por PR, en
 * paralelo, cada una con su propio worktree. Sin drafts cambiados la lista es vacía, no corre ninguna rama y no
 * hay ningún agente. Un PR fuera de draft no entra en la lista: el restack no lo mueve de listo.
 */
const FEEDBACK_CHANGED_DRAFTS: Node = {
  type: "parallel",
  branches: {
    forEach: "$restack.changedDrafts",
    branch: {
      type: "flow",
      flow: "restack-feedback",
      params: {
        pr: "$item.pr",
        repo: "$run.params.repo",
        branch: "$item.branch",
        base: "$item.base",
        externalRounds: "$run.params.externalRounds",
      },
    },
  },
  join: "flows.worst",
  on: { done: "@done", blocked: "@blocked", failed: "@failed" },
};

/**
 * Subflujo de `restack` y `restack-rewritten`: un draft que el restack pusheó vuelve a pasar por `pr-feedback`
 * (que pide `/review`). `pr-feedback` necesita un worktree y el forEach de quien lo llama es un solo nodo,
 * así que el `workspace.attach` de cada PR vive aquí. `branch` y `base` son los del `changedDrafts`.
 */
export const RESTACK_FEEDBACK: FlowDef = {
  schema: 1,
  id: "restack-feedback",
  name: "Feedback de un PR restackeado",
  internal: true,
  trigger: { type: "subflow" },
  params: {
    pr: "PrRef",
    repo: "RepoRef",
    branch: "string",
    base: "string",
    externalRounds: { type: "number", default: 3 },
  },
  start: "ws",
  nodes: {
    ws: {
      type: "action",
      action: "workspace.attach",
      args: { repo: "$run.params.repo", branch: "$run.params.branch", base: "$run.params.base" },
      on: { ok: "feedback" },
    },
    feedback: {
      type: "flow",
      flow: "pr-feedback",
      params: { ws: "$ws", pr: "$run.params.pr", externalRounds: "$run.params.externalRounds" },
      on: { done: "@done", blocked: "@blocked", failed: "@failed" },
    },
  },
};

/**
 * Publica en GitHub cada PR local que el restack dejó sobre la branch por defecto (`promotable` del nodo `restack` de
 * quien lo llama): una corrida de `promote-local` por PR, en paralelo. Sin promovibles no corre nada.
 */
const PROMOTE_LOCALS: Node = {
  type: "parallel",
  branches: {
    forEach: "$restack.promotable",
    branch: {
      type: "flow",
      flow: "promote-local",
      params: {
        prId: "$item.prId",
        repo: "$run.params.repo",
        branch: "$item.branch",
        base: "$item.base",
        externalRounds: "$run.params.externalRounds",
      },
    },
  },
  join: "flows.worst",
  on: { done: "feedback", blocked: "@blocked", failed: "@failed" },
};

/**
 * Subflujo (stacks locales): un PR que vivía solo en la máquina sale a GitHub. Su base cambió desde que pasó los
 * checks (el restack o una persona que pidió publicarlo ya), así que corren otra vez sobre sus archivos contra la base
 * nueva (los que no usan `{{files}}`, enteros); rojos, el dev los arregla
 * y el core commitea lo que dejó. `pr.promote` pushea y abre el PR draft en la misma fila, y `pr-feedback` sigue como
 * con cualquier PR nuevo.
 */
export const PROMOTE_LOCAL: FlowDef = {
  schema: 1,
  id: "promote-local",
  name: "Publicar un PR local",
  internal: true,
  trigger: { type: "subflow" },
  // Como subflujo hereda el carril de quien lo llama; `prs.publishLocal` lo arranca solo, en mantenimiento.
  lane: "maintenance",
  params: {
    prId: "string",
    repo: "RepoRef",
    branch: "string",
    base: "string",
    checkRounds: { type: "number", default: 3 },
    externalRounds: { type: "number", default: 3 },
  },
  start: "ws",
  nodes: {
    ws: {
      type: "action",
      action: "workspace.acquire",
      args: { repo: "$run.params.repo", branch: "$run.params.branch", base: "$run.params.base" },
      on: { ok: "checks" },
    },
    checks: {
      type: "action",
      action: "recipe.check",
      // `changed`: los archivos del PR contra su base nueva; los checks que no usan `{{files}}` corren igual.
      args: { ws: "$ws", scope: "changed" },
      on: {
        ok: "commit",
        fail: { to: "fix", maxRounds: "$run.params.checkRounds", exhausted: { to: "commit", note: "Tests o lint siguen rojos antes de publicar el PR local" } },
      },
    },
    fix: {
      type: "agent",
      role: "dev",
      mode: "fix",
      brief: { failures: "$prev.failures" },
      on: { ok: "checks" },
    },
    commit: {
      type: "action",
      action: "workspace.commitAfterRebase",
      args: { ws: "$ws" },
      on: { ok: "promote" },
    },
    promote: {
      type: "action",
      action: "pr.promote",
      args: { ws: "$ws", prId: "$run.params.prId", base: "$run.params.base" },
      on: { ok: "feedback" },
    },
    feedback: {
      type: "flow",
      flow: "pr-feedback",
      params: { ws: "$ws", pr: "$promote.pr", externalRounds: "$run.params.externalRounds" },
      on: { done: "@done", blocked: "@blocked", failed: "@failed" },
    },
  },
};

/**
 * "Restack": se mergeó un PR del sistema (`pr.merged`) y los que iban encima tienen que quedar sobre la base
 * donde se mergeó. Corre en mantenimiento. `stack.restack` rebasea la cadena sin agentes; un hijo que choca no
 * frena a los demás, anota su `pr.conflict` y lo resuelve `rebase-conflicto`, por lo que el conflicto también
 * sigue a `feedback`: los hijos que sí se restackearon lo necesitan. Los que quedaron en draft piden `/review`
 * otra vez (la regla del clanker-loop); el resto no pasa por ningún agente. Los PRs locales que quedaron sobre la
 * branch por defecto se publican antes (`promote-local`).
 */
export const RESTACK: FlowDef = {
  schema: 1,
  id: "restack",
  name: "Restack",
  internal: true,
  trigger: { type: "pr.merged" },
  lane: "maintenance",
  params: { pr: "PrRef", repo: "RepoRef", externalRounds: { type: "number", default: 3 } },
  limits: { maxCostUsd: null, maxSteps: 50 },
  start: "restack",
  nodes: {
    restack: {
      type: "action",
      action: "stack.restack",
      args: { pr: "$run.params.pr" },
      on: { ok: "promote", conflict: { to: "promote", note: "Algún hijo quedó en conflicto: el flujo de rebase por conflicto lo toma" } },
    },
    promote: PROMOTE_LOCALS,
    feedback: FEEDBACK_CHANGED_DRAFTS,
  },
};

/**
 * "Restack por base reescrita": la branch de un PR del sistema se reescribió (`pr.base_rewritten`, el
 * `from` y el `to` del evento son su punta vieja y la nueva) y sus hijos tienen que seguirla. Corre en
 * mantenimiento. Un hijo que choca no frena a los demás: `stack.restackRewritten` anota su `pr.conflict` y
 * lo resuelve `rebase-conflicto`, por lo que aquí el conflicto también sigue a `feedback`, igual que en `restack`.
 */
export const RESTACK_REWRITTEN: FlowDef = {
  schema: 1,
  id: "restack-rewritten",
  name: "Restack por base reescrita",
  internal: true,
  trigger: { type: "pr.base_rewritten" },
  lane: "maintenance",
  params: {
    pr: { type: "PrRef", default: null },
    prId: { type: "string", default: null },
    repo: "RepoRef",
    from: "string",
    to: "string",
    externalRounds: { type: "number", default: 3 },
  },
  limits: { maxCostUsd: null, maxSteps: 50 },
  start: "restack",
  nodes: {
    restack: {
      type: "action",
      action: "stack.restackRewritten",
      args: { pr: "$run.params.pr", prId: "$run.params.prId", from: "$run.params.from", to: "$run.params.to" },
      on: { ok: "promote", conflict: { to: "promote", note: "Algún hijo quedó en conflicto: el flujo de rebase por conflicto lo toma" } },
    },
    promote: PROMOTE_LOCALS,
    feedback: FEEDBACK_CHANGED_DRAFTS,
  },
};

/**
 * "Council": atiende los threads `[clanker-council]` de un PR del sistema (`pr.comment`, en mantenimiento, con
 * el PR en draft o no). `repo`, `branch`, `base` y `pr` los pone el trigger. Un dev nuevo aplica cada thread
 * o lo rechaza con su razón (`rejected`); lo aplicado queda como commits `fixup!` visibles en el remoto
 * (`pr.pushFixups` con council no hace autosquash ni force push, así que no hay paso de squash) y `pr.reply`
 * responde cada thread con el sha o con la razón, sin resolverlo. No hay bot: tras el push solo se espera
 * al CI, con una ronda de triage. Los threads se atienden una sola vez: uno ya respondido no se reabre.
 */
export const COUNCIL: FlowDef = {
  schema: 1,
  id: "council",
  name: "Council",
  internal: true,
  trigger: { type: "pr.comment" },
  lane: "maintenance",
  params: {
    pr: "PrRef",
    repo: "RepoRef",
    branch: "string",
    base: "string",
    checkRounds: { type: "number", default: 2 },
    externalRounds: { type: "number", default: 1 },
  },
  limits: { maxCostUsd: null, maxSteps: 100 },
  start: "ws",
  nodes: {
    ws: {
      type: "action",
      action: "workspace.attach",
      args: { repo: "$run.params.repo", branch: "$run.params.branch", base: "$run.params.base" },
      on: { ok: "threads" },
    },
    threads: {
      type: "action",
      action: "council.threads",
      args: { pr: "$run.params.pr" },
      on: { ok: "work", none: "@done" },
    },
    work: {
      type: "agent",
      role: "dev",
      mode: "council",
      brief: { instructions: "$threads.items" },
      on: { ok: "checks" },
    },
    checks: {
      type: "action",
      action: "recipe.check",
      args: { ws: "$ws", scope: "changed" },
      on: {
        ok: "light",
        fail: { to: "fix", maxRounds: "$run.params.checkRounds", exhausted: { to: "light", note: "Tests o lint siguen rojos" } },
      },
    },
    fix: {
      type: "agent",
      role: "dev",
      mode: "fix",
      resumeFrom: "work",
      brief: { input: "$prev" },
      on: { ok: "checks" },
    },
    light: lightReview,
    "lr-bugs": { type: "agent", role: "review-bugs", mode: "re-review", brief: { ws: "$ws", previous: "$light.byBranch.lr-bugs" } },
    "lr-tests": { type: "agent", role: "review-tests", mode: "re-review", brief: { ws: "$ws", previous: "$light.byBranch.lr-tests" } },
    fixups: {
      type: "action",
      action: "pr.pushFixups",
      // `route` es el reporte del committer, que solo existe cuando la acción ya devolvió `route`.
      args: { ws: "$ws", items: "$threads.items", route: "$route" },
      on: { ok: "reply", route: { to: "route", maxRounds: 1, exhausted: "@failed" } },
    },
    route: {
      type: "agent",
      role: "committer",
      mode: "route",
      brief: { hunks: "$fixups.unrouted", commits: "$fixups.commits", failures: "$fixups.failures" },
      on: { ok: "fixups" },
    },
    reply: {
      type: "action",
      action: "pr.reply",
      args: { pr: "$run.params.pr", triage: "$threads", shas: "$fixups.byItem", rejected: "$work.rejected" },
      on: { ok: "ci-wait" },
    },
    "ci-wait": {
      type: "wait",
      event: "pr.ci",
      args: { pr: "$run.params.pr" },
      timeoutSec: 5400,
      on: { ok: "@done", fail: "ci-report", timeout: { to: "@done", note: "CI sigue corriendo" } },
    },
    // El check rojo con el detalle de su falla (los tests que fallaron), si el pack sabe cómo traerlo.
    "ci-report": {
      type: "action",
      action: "ci.failureReport",
      args: { pr: "$run.params.pr", failures: "$ci-wait.failures" },
      on: { ok: "ci-triage" },
    },
    "ci-triage": {
      type: "agent",
      role: "triage",
      mode: "ci",
      brief: { items: "$ci-report.items" },
      on: {
        fix: {
          to: "fix",
          counter: "external",
          maxRounds: "$run.params.externalRounds",
          exhausted: { to: "@done", note: "CI rojo por el cambio" },
        },
        foreign: { to: "@done", note: "CI rojo ajeno o flaky" },
        unsure: "ci-unsure",
      },
    },
    // Sin evidencia el triage no adivina: una persona decide si el cambio lo causó.
    "ci-unsure": {
      type: "gate",
      question:
        "El CI quedó rojo y el triage no pudo saber si lo causó el cambio (su reporte dice qué le faltó). ¿Lo arregla el dev o lo dejo así?",
      options: [
        { id: "fix", label: "Que el dev lo arregle" },
        { id: "leave", label: "Dejarlo así: lo reviso yo" },
      ],
      // Sin respuesta en un día queda como "lo reviso yo": el PR sigue en rojo con la nota.
      timeoutSec: 86_400,
      default: "leave",
      on: {
        fix: {
          to: "ci-fix",
          counter: "external",
          maxRounds: "$run.params.externalRounds",
          exhausted: { to: "@done", note: "CI rojo por el cambio" },
        },
        leave: { to: "@done", note: "CI rojo sin causa clara: lo revisa una persona" },
      },
    },
    "ci-fix": {
      type: "agent",
      role: "dev",
      mode: "fix",
      resumeFrom: "work",
      brief: { input: "$ci-triage" },
      on: { ok: "checks" },
    },
  },
};

/**
 * "Republicar PR" (`prs.republish`): el cambio de un PR abierto del sistema vuelve a salir con la branch, el autor y los
 * commits de las reglas de hoy. `ws` toma un worktree nuevo sobre la base (`base`: la branch por defecto o la del
 * PR padre ya republicado), `replay` le deja el cambio del PR viejo (`head` es su sha) sin commits, el committer lo
 * corta en modo `plan` y `pr.publish` lo pushea y abre el PR nuevo con el título y cuerpo del viejo (`title` y `body`
 * ya traen "Reemplaza a #n"), exigiendo el árbol de `replay`. Recién entonces `supersede` cierra el viejo, así que un
 * fallo antes deja todo como estaba: la corrida termina `failed` (no estacionada) y `discard` suelta el worktree y borra
 * la branch local si nunca se pusheó, para que el reintento use el mismo nombre. Un PR que estaba en draft sigue a `pr-feedback` (`/review`), como el PR de
 * cualquier corrida del flujo normal. Lo lanza `prs.republish`; nada lo dispara solo.
 */
export const REPUBLISH_PR: FlowDef = {
  schema: 1,
  id: "republish-pr",
  name: "Republicar PR",
  internal: true,
  trigger: { type: "manual" },
  lane: "maintenance",
  params: {
    repo: "RepoRef",
    base: "string",
    branch: "string",
    head: "string",
    oldNumber: "number",
    oldHead: "string",
    oldBase: "string",
    title: "string",
    body: "string",
    draft: { type: "boolean", default: true },
    externalRounds: { type: "number", default: 3 },
  },
  limits: { maxCostUsd: null, maxSteps: 50 },
  start: "ws",
  nodes: {
    ws: {
      type: "action",
      action: "workspace.acquire",
      args: { repo: "$run.params.repo", branch: "$run.params.branch", base: "$run.params.base" },
      on: { ok: "replay" },
    },
    replay: {
      type: "action",
      action: "pr.replay",
      args: { ws: "$ws", head: "$run.params.head", base: "$run.params.oldBase" },
      on: { ok: "commit", error: "discard" },
    },
    commit: {
      type: "agent",
      role: "committer",
      mode: "plan",
      brief: { ws: "$ws", cuts: [], issue: "$run.subject", failures: "$prev.failures" },
      on: { ok: "publish", error: "discard" },
    },
    publish: {
      type: "action",
      action: "pr.publish",
      args: {
        ws: "$ws",
        plan: { commits: "$commit.commits", pr: { title: "$run.params.title", body: "$run.params.body" } },
        draft: "$run.params.draft",
        expectTree: "$replay.tree",
        forceRemote: true,
      },
      on: {
        ok: "supersede",
        local: "discard",
        replan: { to: "commit", maxRounds: 2, exhausted: "discard" },
        error: "discard",
      },
    },
    discard: {
      type: "action",
      action: "workspace.discard",
      args: { workspaceId: "$ws.workspaceId", fencingToken: "$ws.fencingToken" },
      on: { ok: "@failed" },
    },
    supersede: {
      type: "action",
      action: "pr.supersede",
      args: { pr: "$publish.pr", oldNumber: "$run.params.oldNumber", oldHead: "$run.params.oldHead", oldBase: "$run.params.oldBase", draft: "$run.params.draft" },
      on: { draft: "feedback", ready: "@done" },
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
 * Lo que comparten `chat-aplicar` y `chat-aplicar-local` (`chats/chats.ts`): la propuesta del chat queda sin commitear
 * en el worktree del PR (`chat.applyProposal`), pasa los checks de la receta (rojos, el dev los arregla), sale como
 * `fixup!` de los commits del PR (`pr.pushFixups`, que squashea y pushea con lease, o deja los fixups visibles sin
 * forzar si el PR tuvo council, o en un PR local commitea sin push) y los hijos del PR siguen su punta nueva
 * (`restack-rewritten` como subflujo, que marca la reescritura para que Watch no la anuncie otra vez). Una propuesta
 * que no calza (`stale`) o choca (`conflict`) termina sin tocar el PR.
 */
const CHAT_APPLY_PARAMS = {
  prId: "string",
  chatId: "string",
  rev: "number",
  repo: "RepoRef",
  branch: "string",
  base: "string",
  checkRounds: { type: "number", default: 2 },
  externalRounds: { type: "number", default: 3 },
} as const;

const chatApplyNodes = (next: string): Record<string, Node> => ({
  apply: {
    type: "action",
    action: "chat.applyProposal",
    args: { ws: "$ws", chatId: "$run.params.chatId", rev: "$run.params.rev" },
    on: {
      ok: "checks",
      stale: { to: "@done", note: "La propuesta ya no calza con el PR: el chat la puede rehacer" },
      conflict: { to: "@done", note: "La propuesta chocó con el worktree del PR: el PR quedó como estaba" },
    },
  },
  checks: {
    type: "action",
    action: "recipe.check",
    args: { ws: "$ws", scope: "changed" },
    on: {
      ok: "fixups",
      fail: { to: "fix", maxRounds: "$run.params.checkRounds", exhausted: "revert" },
    },
  },
  fix: {
    type: "agent",
    role: "dev",
    mode: "fix",
    brief: { failures: "$prev.failures" },
    on: { ok: "checks" },
  },
  revert: {
    type: "action",
    action: "chat.revert",
    args: { ws: "$ws" },
    on: { ok: { to: "@failed", note: "Los checks siguieron rojos: la propuesta no se aplicó" } },
  },
  fixups: {
    type: "action",
    action: "pr.pushFixups",
    args: { ws: "$ws", items: null, route: "$route" },
    on: { ok: "restack", route: { to: "route", maxRounds: 1, exhausted: "@failed" } },
  },
  route: {
    type: "agent",
    role: "committer",
    mode: "route",
    brief: { hunks: "$fixups.unrouted", commits: "$fixups.commits", failures: "$fixups.failures" },
    on: { ok: "fixups" },
  },
  restack: {
    type: "flow",
    flow: "restack-rewritten",
    params: {
      pr: null,
      prId: "$run.params.prId",
      repo: "$run.params.repo",
      from: "$fixups.from",
      to: "$fixups.to",
      externalRounds: "$run.params.externalRounds",
    },
    on: { done: next, blocked: next, failed: next },
  },
});

/** "Aplicar la propuesta del chat" en un PR publicado: después del restack, un draft vuelve a pedir review al bot. */
export const CHAT_APLICAR: FlowDef = {
  schema: 1,
  id: "chat-aplicar",
  name: "Aplicar la propuesta del chat",
  description: "Aplica al PR lo que propuso su chat y restackea los PRs que cuelgan de él.",
  internal: true,
  trigger: { type: "manual" },
  lane: "maintenance",
  params: { ...CHAT_APPLY_PARAMS, pr: "PrRef" },
  limits: { maxCostUsd: null, maxSteps: 100 },
  start: "ws",
  nodes: {
    ws: {
      type: "action",
      action: "workspace.attach",
      args: { repo: "$run.params.repo", branch: "$run.params.branch", base: "$run.params.base" },
      on: { ok: "apply" },
    },
    ...chatApplyNodes("state"),
    state: {
      type: "action",
      action: "chat.prState",
      args: { prId: "$run.params.prId" },
      on: { draft: "feedback", ready: { to: "@done", note: "Pide /review si hace falta" }, local: "@done" },
    },
    feedback: {
      type: "flow",
      flow: "pr-feedback",
      params: { ws: "$ws", pr: "$run.params.pr", externalRounds: "$run.params.externalRounds" },
      on: { done: "@done", blocked: "@blocked", failed: "@failed" },
    },
  },
};

/** Lo mismo en un PR local: los fixups quedan commiteados en la máquina, sin push ni review del bot. */
export const CHAT_APLICAR_LOCAL: FlowDef = {
  schema: 1,
  id: "chat-aplicar-local",
  name: "Aplicar la propuesta del chat en un PR local",
  description: "Aplica al PR local lo que propuso su chat y restackea los PRs locales que cuelgan de él, sin push.",
  internal: true,
  trigger: { type: "manual" },
  lane: "maintenance",
  params: CHAT_APPLY_PARAMS,
  limits: { maxCostUsd: null, maxSteps: 100 },
  start: "ws",
  nodes: {
    ws: {
      type: "action",
      action: "workspace.acquire",
      args: { repo: "$run.params.repo", branch: "$run.params.branch", base: "$run.params.base" },
      on: { ok: "apply" },
    },
    ...chatApplyNodes("@done"),
  },
};

/** Aplica un diff al head exacto de un PR local, sin preparar otro worktree, publicar ni restackear sus hijos. */
export const APPLY_LOCAL_PATCH: FlowDef = {
  schema: 1,
  id: "apply-local-patch",
  name: "Aplicar un patch a un PR local",
  description: "Agrega un commit a un PR local sin publicarlo.",
  internal: true,
  trigger: { type: "manual" },
  lane: "maintenance",
  // `effects: "local"` declara una corrida sin escritura al motor. Esta toma el sujeto del PR
  // como las demás que modifican su branch, aunque sus dos acciones no publican.
  params: { prId: "string", repo: "RepoRef", branch: "string", base: "string", head: "string", patch: "string" },
  start: "ws",
  nodes: {
    ws: {
      type: "action",
      action: "workspace.acquire",
      args: { repo: "$run.params.repo", branch: "$run.params.branch", base: "$run.params.base", existingOnly: true },
      on: { ok: "apply", error: "@failed" },
    },
    apply: {
      type: "action",
      action: "pr.applyLocalPatch",
      args: {
        ws: "$ws", prId: "$run.params.prId", repo: "$run.params.repo", branch: "$run.params.branch",
        base: "$run.params.base", head: "$run.params.head", patch: "$run.params.patch",
      },
      on: { ok: "@done", error: "@failed" },
    },
  },
};

/** Aprobación explícita: comprueba la receta sin arreglos automáticos y publica solo la revisión aprobada. */
const PROMOTE_APPROVED_LOCAL: FlowDef = {
  schema: 1,
  id: "promote-approved-local",
  name: "Publicar PR local aprobado",
  internal: true,
  trigger: { type: "manual" },
  lane: "maintenance",
  params: { prId: "string", repo: "RepoRef", branch: "string", base: "string", approval: "string" },
  start: "ws",
  nodes: {
    ws: {
      type: "action",
      action: "workspace.acquire",
      args: { repo: "$run.params.repo", branch: "$run.params.branch", base: "$run.params.base", existingOnly: true },
      on: { ok: "validate", error: "@failed" },
    },
    validate: {
      type: "action",
      action: "pr.validateLocalPublish",
      args: { ws: "$ws", prId: "$run.params.prId", base: "$run.params.base", approval: "$run.params.approval" },
      on: { ok: "checks", error: "@failed" },
    },
    checks: {
      type: "action",
      action: "recipe.check",
      args: { ws: "$ws", scope: "changed" },
      on: { ok: "publish", fail: { to: "@failed", note: "No se publicó el PR: fallaron los checks del repo" }, error: "@failed" },
    },
    publish: {
      type: "action",
      action: "pr.promote",
      args: { ws: "$ws", prId: "$run.params.prId", base: "$run.params.base", approval: "$run.params.approval" },
      on: { ok: "@done", error: "@failed" },
    },
  },
};

export const flows: Record<string, FlowDef> = {
  "de-issue-a-pr": DE_ISSUE_A_PR,
  "pr-feedback": PR_FEEDBACK,
  "rebase-conflicto": REBASE_CONFLICTO,
  "rebase-conflicto-local": REBASE_CONFLICTO_LOCAL,
  "restack-feedback": RESTACK_FEEDBACK,
  "promote-local": PROMOTE_LOCAL,
  "promote-approved-local": PROMOTE_APPROVED_LOCAL,
  "base-combinada-conflicto": BASE_COMBINADA_CONFLICTO,
  restack: RESTACK,
  "restack-rewritten": RESTACK_REWRITTEN,
  council: COUNCIL,
  "republish-pr": REPUBLISH_PR,
  "chat-aplicar": CHAT_APLICAR,
  "chat-aplicar-local": CHAT_APLICAR_LOCAL,
  "apply-local-patch": APPLY_LOCAL_PATCH,
};

import type { PRRisk, PRsResult, PullRequest } from "@/types"

// Stacks de PR de ejemplo para desarrollar la UI sin core. Todo cuelga de `now`, así "hace 2 min" se ve
// igual cada vez que se abre y los tests no dependen del reloj.
export function buildPrs(now: number): PRsResult {
  const at = (secondsAgo: number) => new Date(now - secondsAgo * 1000).toISOString()
  const min = (m: number) => m * 60

  // ─── PRs abiertos ──────────────────────────────────────────────────────────

  const viewer = { login: "alex", avatarUrl: "" }
  let nextId = 1000
  const pr = (
    repoName: string,
    number: number,
    title: string,
    headRef: string,
    o: Partial<PullRequest> & { reviewers?: PullRequest["reviewerStates"]; risk?: PRRisk | null; updated?: number } = {},
  ): PullRequest => {
    const { reviewers, updated, ...rest } = o
    return {
      id: nextId++,
      number,
      title,
      state: "open",
      url: `https://github.com/acme/${repoName}/pull/${number}`,
      repoName,
      repoFullName: `acme/${repoName}`,
      defaultBranch: "main",
      headRef,
      baseRef: "main",
      author: viewer,
      createdAt: at(60 * 60 * 30),
      updatedAt: at(updated ?? min(30)),
      comments: 0,
      unresolvedThreads: 0,
      additions: 120,
      deletions: 34,
      changedFiles: 6,
      reviewerStates: reviewers ?? [],
      botReview: null,
      reviewDecision: "review_required",
      ciStatus: "success",
      isDraft: false,
      labels: [],
      risk: null,
      clanker: null,
      merge: { ready: false, blockers: ["falta aprobación"], finMerge: null },
      ...rest,
    }
  }
  const human = (login: string, state: PullRequest["reviewerStates"][number]["state"]) => ({ login, avatarUrl: null, state })
  const label = (name: string, color: string, description: string) => ({ name, color, description })
  const riskLabel = (r: PRRisk) => label(`risk:${r}`, r === "high" ? "d73a4a" : r === "mid" ? "fbca04" : "0e8a16", `Riesgo ${r} según el bot de review`)

  const stackBase = pr("ledger", 421, "Prohibir imports cruzados entre engines", "eng-9160-no-cross-imports", {
    reviewers: [human("marta", "approved")],
    reviewDecision: "approved",
    botReview: "approved",
    risk: "mid",
    labels: [riskLabel("mid")],
    clanker: { slug: "boundaries-de-engines", loop: "Boundaries de engines", issueId: "ENG-9160" },
    merge: { ready: true, blockers: [], finMerge: null },
    additions: 210,
    deletions: 58,
    updated: min(11),
  })
  const stackMid = pr("ledger", 424, "Agregar checks de boundaries a CI", "eng-9167-boundary-checks", {
    baseRef: "eng-9160-no-cross-imports",
    reviewers: [human("marta", "changes_requested")],
    reviewDecision: "changes_requested",
    unresolvedThreads: 2,
    comments: 5,
    risk: "low",
    labels: [riskLabel("low")],
    clanker: { slug: "boundaries-de-engines", loop: "Boundaries de engines", issueId: "ENG-9167" },
    merge: { ready: false, blockers: ["pidieron cambios", "2 threads sin resolver"], finMerge: null },
    updated: min(2),
  })
  const stackTop = pr("ledger", 426, "Reglas de boundaries para engines nuevas", "eng-9173-new-engine-rules", {
    baseRef: "eng-9167-boundary-checks",
    isDraft: true,
    state: "draft",
    reviewDecision: "none",
    ciStatus: "pending",
    risk: "low",
    labels: [riskLabel("low")],
    merge: { ready: false, blockers: ["draft"], finMerge: null },
    additions: 64,
    deletions: 3,
    changedFiles: 2,
    updated: min(5),
  })
  const stackBranch = pr("ledger", 427, "Lint de imports entre engines", "eng-9174-import-lint", {
    baseRef: "eng-9160-no-cross-imports",
    reviewers: [human("diego", "pending")],
    ciStatus: "pending",
    merge: { ready: false, blockers: ["CI corriendo", "falta aprobación"], finMerge: null },
    updated: min(8),
  })

  const prsList: PullRequest[] = [
    stackBase,
    stackMid,
    stackTop,
    stackBranch,
    pr("payments-api", 388, "Renombrar Payments::Ledger a Payments::Posting", "eng-9163-rename-posting", {
      reviewers: [human("marta", "commented"), human("diego", "approved")],
      reviewDecision: "approved",
      botReview: "commented",
      unresolvedThreads: 1,
      comments: 3,
      risk: "high",
      labels: [riskLabel("high"), label("clanker", "8957e5", "PR del clanker-loop")],
      clanker: { slug: "boundaries-de-engines", loop: "Boundaries de engines", issueId: "ENG-9163" },
      merge: { ready: false, blockers: ["1 thread sin resolver"], finMerge: null },
      additions: 480,
      deletions: 395,
      changedFiles: 31,
      updated: min(22),
    }),
    pr("payments-api", 391, "Migrar el job de conciliación", "eng-9170-reconciliation-job", {
      ciStatus: "failure",
      reviewers: [human("marta", "approved")],
      reviewDecision: "approved",
      botReview: "approved",
      risk: "high",
      labels: [riskLabel("high")],
      clanker: { slug: "boundaries-de-engines", loop: "Boundaries de engines", issueId: "ENG-9170" },
      merge: { ready: false, blockers: ["merge-queue falló"], finMerge: "failed" },
      updated: min(18),
    }),
    pr("dashboard", 977, "Arreglar el scroll del listado de cuentas", "tw-31-accounts-scroll", {
      reviewers: [human("sofia", "approved")],
      reviewDecision: "approved",
      botReview: "approved",
      risk: "low",
      labels: [riskLabel("low")],
      clanker: { slug: "soporte", loop: "SOPORTE", issueId: "TW-31" },
      merge: { ready: true, blockers: [], finMerge: "queued" },
      additions: 18,
      deletions: 6,
      changedFiles: 2,
      updated: min(25),
    }),
    pr("dashboard", 979, "Quitar el modal duplicado de confirmación", "tw-33-duplicate-modal", {
      reviewers: [human("sofia", "pending")],
      risk: "low",
      labels: [riskLabel("low")],
      clanker: { slug: "soporte", loop: "SOPORTE", issueId: "TW-33" },
      merge: { ready: false, blockers: ["falta aprobación"], finMerge: null },
      additions: 40,
      deletions: 77,
      changedFiles: 4,
      updated: min(40),
    }),
    pr("dashboard", 955, "Pantalla de resumen del pago", "ch-14-payment-summary", {
      reviewers: [],
      risk: "mid",
      labels: [riskLabel("mid")],
      clanker: { slug: "migracion-checkout", loop: "Migración del checkout", issueId: "CH-14" },
      additions: 310,
      deletions: 12,
      changedFiles: 9,
      updated: 60 * 60 * 5,
    }),
    pr("ledger", 430, "Probar el nuevo índice de entradas en staging", "idx-entries-staging", {
      isDraft: true,
      state: "draft",
      reviewDecision: "none",
      ciStatus: "unknown",
      merge: { ready: false, blockers: ["draft"], finMerge: null },
      additions: 12,
      deletions: 0,
      changedFiles: 1,
      updated: 60 * 60 * 20,
    }),
  ]

  return {
    viewer,
    prs: prsList,
    fetchedAt: at(75),
    total: prsList.length,
    rate: { remaining: 4310, limit: 5000, cost: 6, resetAt: at(-min(41)) },
    pausedUntil: null,
  }
}

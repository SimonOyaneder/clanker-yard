import type { CachedPr, IssueId, LocalPrDetail, PrSignal, PrState, ReviewerState } from "@clanker/api"

// Stacks de PR de ejemplo para desarrollar la UI sin core: lo que `prs.list` serviría con el caché de Watch ya
// leído. Todo cuelga de `now`, así "hace 2 min" se ve igual cada vez que se abre y los tests no dependen del reloj.

/** Una señal de riesgo como la declararía un pack: el nombre de cada nivel, su tono y su tooltip vienen de él. */
const RISK: PrSignal = {
  id: "risk",
  match: "^risk[:/ _-]?(high|mid|medium|low)$",
  flags: "i",
  empty: "Sin riesgo",
  levels: {
    high: { label: "Riesgo alto", tone: "bad", hint: "Label risk:high del pack. Es un cambio delicado: revísalo con calma antes de mergear" },
    mid: { label: "Riesgo medio", tone: "warn", hint: "Label risk:mid del pack. Merece una revisada normal" },
    low: { label: "Riesgo bajo", tone: "ok", hint: "Label risk:low del pack. Cambio acotado y de bajo impacto" },
  },
}

const COMMAND = "merge please"

export function buildOpenPrs(now: number): CachedPr[] {
  const at = (secondsAgo: number) => new Date(now - secondsAgo * 1000).toISOString()
  const min = (m: number) => m * 60
  let nextId = 1

  const human = (login: string, state: ReviewerState["state"]): ReviewerState => ({ login, avatarUrl: null, state })
  const riskLabel = (level: "high" | "mid" | "low") => ({ name: `risk:${level}`, color: level === "high" ? "d73a4a" : level === "mid" ? "fbca04" : "0e8a16", description: `Riesgo ${level}` })

  interface Options extends Partial<Omit<PrState, "key" | "title" | "headRef" | "merge" | "signals" | "updatedAt">> {
    merge?: Partial<PrState["merge"]>
    risk?: "high" | "mid" | "low"
    updated?: number
    owned?: boolean
    parents?: CachedPr[]
    runId?: CachedPr["runId"]
    issueId?: IssueId
  }
  const pr = (repo: string, number: number, title: string, headRef: string, o: Options = {}): CachedPr => {
    const { merge, risk, updated, owned = false, parents = [], runId = null, issueId = null, ...rest } = o
    const state: PrState = {
      key: `${repo}#${number}`,
      title,
      url: `https://github.com/acme/${repo}/pull/${number}`,
      updatedAt: at(updated ?? min(30)),
      additions: 120,
      deletions: 34,
      comments: 0,
      state: "open",
      headRef,
      headSha: "a".repeat(40),
      baseRef: "main",
      baseIsDefault: true,
      mergeable: "clean",
      reviewDecision: "review_required",
      reviewers: [],
      approvers: [],
      bot: { state: "none", findings: [] },
      ci: { state: "green", sha: "a".repeat(40), failing: [], flaky: [] },
      threads: { unresolved: 0, humanOpen: 0, humanResolved: 0, botOpen: 0, councilOpen: [], councilEver: false },
      talk: [],
      labels: risk ? [riskLabel(risk)] : [],
      signals: risk ? { risk } : {},
      hold: false,
      ...rest,
      merge: { via: "comment", command: COMMAND, ready: false, blockers: ["falta aprobación"], queue: null, offer: false, auto: false, ...merge },
    }
    const id = `pr_${String(nextId++).padStart(26, "0")}`
    return {
      id,
      repo: `acme/${repo}`,
      ref: { account: "alex", repo: `acme/${repo}`, number },
      local: null,
      owned,
      issueId,
      runId,
      parents: parents.map((p) => p.id),
      signals: [RISK],
      reviewBot: true,
      state,
      readAt: now - 75_000,
    }
  }

  // ─── Un stack de 4 sobre `ledger`, con un PR hijo que sale de una base combinada más abajo ──────────────────
  const stackBase = pr("ledger", 421, "Prohibir imports cruzados entre engines", "eng-9160-no-cross-imports", {
    owned: true,
    issueId: "iss_eng_9160",
    reviewers: [human("marta", "approved")],
    reviewDecision: "approved",
    approvers: ["marta"],
    bot: { state: "lgtm", findings: [] },
    risk: "mid",
    additions: 210,
    deletions: 58,
    updated: min(11),
    merge: { ready: true, blockers: [], offer: true },
  })
  const stackMid = pr("ledger", 424, "Agregar checks de boundaries a CI", "eng-9167-boundary-checks", {
    owned: true,
    issueId: "iss_eng_9167",
    baseRef: "eng-9160-no-cross-imports",
    baseIsDefault: false,
    reviewers: [human("marta", "changes_requested")],
    reviewDecision: "changes_requested",
    threads: { unresolved: 2, humanOpen: 2, humanResolved: 0, botOpen: 0, councilOpen: [], councilEver: false },
    comments: 5,
    risk: "low",
    updated: min(2),
    merge: { blockers: ["pidieron cambios", "2 hilos de humanos sin resolver"] },
  })
  const stackTop = pr("ledger", 426, "Reglas de boundaries para engines nuevas", "eng-9173-new-engine-rules", {
    owned: true,
    issueId: "iss_eng_9173",
    state: "draft",
    baseRef: "eng-9167-boundary-checks",
    baseIsDefault: false,
    reviewDecision: "none",
    ci: { state: "pending", sha: "a".repeat(40), failing: [], flaky: [] },
    risk: "low",
    additions: 64,
    deletions: 3,
    updated: min(5),
    merge: { blockers: ["draft"] },
  })
  const stackBranch = pr("ledger", 427, "Lint de imports entre engines", "eng-9174-import-lint", {
    owned: true,
    issueId: "iss_eng_9174",
    baseRef: "eng-9160-no-cross-imports",
    baseIsDefault: false,
    reviewers: [human("diego", "pending")],
    ci: { state: "pending", sha: "a".repeat(40), failing: [], flaky: [] },
    updated: min(8),
    merge: { blockers: ["CI corriendo", "falta aprobación"] },
  })

  // Dos PRs de `payments-api` que un tercero junta en una rama sintética: su diff incluye los commits de los dos.
  const reconcile = pr("payments-api", 391, "Migrar el job de conciliación", "eng-9170-reconciliation-job", {
    owned: true,
    issueId: "iss_eng_9170",
    ci: { state: "red", sha: "a".repeat(40), failing: ["queue"], flaky: [] },
    reviewers: [human("marta", "approved")],
    reviewDecision: "approved",
    approvers: ["marta"],
    bot: { state: "lgtm", findings: [] },
    risk: "high",
    updated: min(18),
    merge: { queue: "failed", blockers: ["el merge falló en la cola"] },
  })
  const rename = pr("payments-api", 388, "Renombrar Payments::Ledger a Payments::Posting", "eng-9163-rename-posting", {
    owned: true,
    issueId: "iss_eng_9163",
    reviewers: [human("marta", "commented"), human("diego", "approved")],
    reviewDecision: "approved",
    approvers: ["diego"],
    bot: { state: "findings", findings: [{ id: "1", text: "Falta migrar el alias viejo", path: "app/ledger.rb", line: 12 }] },
    threads: { unresolved: 1, humanOpen: 1, humanResolved: 0, botOpen: 0, councilOpen: [], councilEver: false },
    comments: 3,
    risk: "high",
    additions: 480,
    deletions: 395,
    updated: min(22),
    merge: { blockers: ["1 hilo de humanos sin resolver"] },
  })
  const combined = pr("payments-api", 395, "Cerrar la conciliación con el nuevo nombre", "eng-9176-reconcile-posting", {
    owned: true,
    issueId: "iss_eng_9176",
    baseRef: "clanker/base/eng-9176",
    baseIsDefault: false,
    parents: [reconcile, rename],
    state: "draft",
    reviewDecision: "none",
    risk: "high",
    additions: 700,
    deletions: 410,
    updated: min(4),
    merge: { blockers: ["draft"] },
  })

  const localBase = pr("ledger", 430, "Probar el nuevo índice de entradas en staging", "idx-entries-staging", {
    state: "draft",
    reviewDecision: "none",
    ci: { state: "none", sha: "a".repeat(40), failing: [], flaky: [] },
    additions: 12,
    deletions: 0,
    updated: 60 * 60 * 20,
    merge: { blockers: ["draft"] },
  })
  const localMid: CachedPr = {
    id: `pr_${String(nextId++).padStart(26, "0")}`,
    repo: localBase.repo,
    ref: null,
    local: { branch: "idx-entries-metrics", base: "idx-entries-staging", title: "Medir el nuevo índice de entradas" },
    owned: true,
    issueId: null,
    runId: null,
    parents: [localBase.id],
    signals: [RISK],
    reviewBot: true,
    state: null,
    readAt: null,
  }
  const localTop: CachedPr = {
    ...localMid,
    id: `pr_${String(nextId++).padStart(26, "0")}`,
    local: { branch: "idx-entries-rollout", base: "idx-entries-metrics", title: "Preparar el despliegue del índice de entradas" },
    parents: [localMid.id],
  }

  return [
    stackBase,
    stackMid,
    stackTop,
    stackBranch,
    rename,
    reconcile,
    combined,
    pr("dashboard", 977, "Arreglar el scroll del listado de cuentas", "tw-31-accounts-scroll", {
      owned: true,
      issueId: "iss_tw_31",
      reviewers: [human("sofia", "approved")],
      reviewDecision: "approved",
      approvers: ["sofia"],
      bot: { state: "lgtm", findings: [] },
      comments: 1,
      risk: "low",
      additions: 18,
      deletions: 6,
      updated: min(25),
      merge: { ready: true, blockers: [], queue: "queued" },
    }),
    pr("dashboard", 979, "Quitar el modal duplicado de confirmación", "tw-33-duplicate-modal", {
      owned: true,
      issueId: "iss_tw_33",
      reviewers: [human("sofia", "pending")],
      risk: "low",
      additions: 40,
      deletions: 77,
      updated: min(40),
    }),
    pr("dashboard", 955, "Pantalla de resumen del pago", "ch-14-payment-summary", {
      risk: "mid",
      additions: 310,
      deletions: 12,
      updated: 60 * 60 * 5,
    }),
    localBase,
    localMid,
    localTop,
    pr("dashboard", 981, "Migrar los tooltips a Radix", "ch-19-radix-tooltips", {
      hold: true,
      reviewers: [human("sofia", "approved")],
      reviewDecision: "approved",
      approvers: ["sofia"],
      bot: { state: "lgtm", findings: [] },
      risk: "mid",
      updated: min(55),
      merge: { ready: true, blockers: [] },
    }),
  ]
}

/** El detalle de ejemplo de un PR local (`prs.localDetail`): descripción, dos commits y su diff. */
export function seedLocalPrDetail(id: string, local: NonNullable<CachedPr["local"]>, now: number): LocalPrDetail {
  const at = (hoursAgo: number) => new Date(now - hoursAgo * 3_600_000).toISOString()
  return {
    id,
    repo: "acme/ledger",
    branch: local.branch,
    base: local.base,
    title: local.title,
    body: `## Qué cambia\n\n- ${local.title}.\n- Suma un test que cubre el caso sin entradas.\n\n## Cómo probarlo\n\nCorre los specs de entradas.`,
    head: "9f2c4e1ab7d03c55e18f0b6a2d4c7e9f01b3a5c8",
    commits: [
      { sha: "4e1ab7d03c55e18f0b6a2d4c7e9f01b3a5c89f2c", subject: `feat(entries): ${local.title.toLowerCase()}`, body: "Lo usa el tablero de conciliación.", author: "Ana Pérez", date: at(5) },
      { sha: "9f2c4e1ab7d03c55e18f0b6a2d4c7e9f01b3a5c8", subject: "test(entries): cubrir el caso sin entradas", body: "", author: "Ana Pérez", date: at(4) },
    ],
    files: [
      { path: "app/models/entry_index.rb", additions: 3, deletions: 1 },
      { path: "spec/models/entry_index_spec.rb", additions: 4, deletions: 0 },
    ],
    patch: [
      "diff --git a/app/models/entry_index.rb b/app/models/entry_index.rb",
      "index 1a2b3c4..5d6e7f8 100644",
      "--- a/app/models/entry_index.rb",
      "+++ b/app/models/entry_index.rb",
      "@@ -12,4 +12,6 @@ class EntryIndex",
      "   def refresh",
      "-    rebuild",
      "+    return if entries.none?",
      "+",
      "+    rebuild(concurrently: true)",
      "   end",
      " end",
      "diff --git a/spec/models/entry_index_spec.rb b/spec/models/entry_index_spec.rb",
      "new file mode 100644",
      "index 0000000..9a8b7c6",
      "--- /dev/null",
      "+++ b/spec/models/entry_index_spec.rb",
      "@@ -0,0 +1,4 @@",
      "+describe EntryIndex do",
      "+  it { expect(described_class.new.refresh).to be_nil }",
      "+end",
      "+",
      "",
    ].join("\n"),
    truncated: false,
  }
}

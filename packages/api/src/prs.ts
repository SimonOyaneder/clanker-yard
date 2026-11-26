import * as z from "zod";
import { IssueId, ProjectId, RunId } from "./domain";
import { SignalTone } from "./pack";
import { RunStatus } from "./runs";

export const ReviewInboxRow = z.object({
  isDraft: z.boolean(),
  account: z.string(), repo: z.string(), number: z.number(), title: z.string(), url: z.string(),
  review: z.enum(["requested", "draft", "published", "none"]),
  scheduled: z.boolean(), run: RunStatus.nullable(), outcome: z.string().nullable(),
});
export type ReviewInboxRow = z.infer<typeof ReviewInboxRow>;

// El estado normalizado de un PR (`docs/design.html#d-ops`, interface PrState). Es genérico: lo que
// depende de la organización (quién es el bot de review, qué checks cuentan, qué labels son señales)
// lo decide el pack (`PackSettings`) y aquí solo llega ya resuelto. Sin pack: sin bot, sin señales y
// CI = checks requeridos de la branch protection.

/** Un PR de GitHub: la cuenta conectada que lo lee, `owner/repo` y el número. */
export const PrRef = z.object({
  account: z.string().min(1),
  repo: z.string().regex(/^[^/\s]+\/[^/\s]+$/, "debe ser owner/repo"),
  number: z.int().positive(),
});
export type PrRef = z.infer<typeof PrRef>;

export const ReviewerState = z.object({
  login: z.string(),
  avatarUrl: z.string().nullable(),
  /** `pending` es una review pedida que todavía no llegó. */
  state: z.enum(["approved", "changes_requested", "commented", "pending"]),
});
export type ReviewerState = z.infer<typeof ReviewerState>;

export const PrLabel = z.object({
  name: z.string(),
  /** Hex sin `#`, tal cual GitHub. */
  color: z.string(),
  description: z.string().nullable(),
});
export type PrLabel = z.infer<typeof PrLabel>;

export const PrTalk = z.object({
  /** `review` y `comment` son lo que un humano escribió; `changes` es una review que pide cambios. */
  kind: z.enum(["review", "changes", "comment"]),
  author: z.string(),
  /** ISO 8601 */
  at: z.string(),
  excerpt: z.string(),
});
export type PrTalk = z.infer<typeof PrTalk>;

/** Algo que el bot de review dejó abierto: un thread suyo sin resolver, con el lugar y el texto de su primer comentario. */
export const BotFinding = z.object({
  /** El `fullDatabaseId` del primer comentario del thread, como nombra `pr.reply` a un thread (`review-<id>` si el bot no dejó threads: el id es el de su review). */
  id: z.string(),
  path: z.string().optional(),
  line: z.int().optional(),
  text: z.string(),
});
export type BotFinding = z.infer<typeof BotFinding>;

/**
 * Qué dice la estrategia de merge sobre un PR abierto (`docs/design.html#d-ops`, "Tres niveles de merge"):
 * `ready` es la píldora verde, `blockers` lo que la apaga (el texto que ve
 * el usuario), `queue` si ya se pidió el merge (`queued`) o falló (`failed`). `offer` y `auto` son los otros
 * dos niveles: pedir una decisión y mergear sin preguntar; `auto` implica `offer`, y `hold` apaga los dos. Un
 * PR mergeado o cerrado no tiene nada de esto. `via` es cómo se mergea: `comment` con el comando de la
 * estrategia del pack, o `button` con el botón de GitHub (sin pack, o donde la estrategia no aplica).
 */
export const PrMerge = z.object({
  via: z.enum(["comment", "button"]),
  /** El comando que se comenta para mergear (`via: "comment"`); `button` no lo tiene. */
  command: z.string().optional(),
  ready: z.boolean(),
  blockers: z.array(z.string()),
  queue: z.enum(["queued", "failed"]).nullable(),
  offer: z.boolean(),
  auto: z.boolean(),
});
export type PrMerge = z.infer<typeof PrMerge>;

export const PrState = z.object({
  /** `repo#número`, por ejemplo `api#4251`. */
  key: z.string(),
  title: z.string(),
  /** El link del PR en GitHub. */
  url: z.string(),
  /** ISO 8601: la última vez que GitHub lo tocó. */
  updatedAt: z.string(),
  additions: z.int().nonnegative(),
  deletions: z.int().nonnegative(),
  /** Comentarios de la conversación (sin contar los threads de review). */
  comments: z.int().nonnegative(),
  state: z.enum(["draft", "open", "merged", "closed"]),
  headRef: z.string(),
  headSha: z.string(),
  baseRef: z.string(),
  baseIsDefault: z.boolean(),
  /** `unknown` mientras GitHub calcula la mergeabilidad y en PRs ya cerrados. */
  mergeable: z.enum(["clean", "conflict", "behind", "unknown"]),
  mergeCommitSha: z.string().optional(),
  reviewDecision: z.enum(["approved", "changes_requested", "review_required", "none"]),
  /** Solo humanos (no el autor, ni bots, ni lo que el pack ignora). */
  reviewers: z.array(ReviewerState),
  /** Humanos cuya última review que opina (aprueba o pide cambios) es una aprobación, como `latestOpinionatedReviews` del vigilante. Nunca la cuenta conectada. */
  approvers: z.array(z.string()),
  /**
   * Lo último que dijo el bot de review del pack. `lgtm` solo si esa review cumple la regla del pack
   * (estado, texto y, si lo pide, el mismo sha que el head); un LGTM de un sha anterior es `none`.
   * `sha`, `reviewId` y `at` (ISO 8601) son los de la review del bot: quien espere al bot compara `sha`
   * con `headSha` y `at` con el momento en que le pidió la review. `findings` solo viene con
   * `state: "findings"`: sus threads sin resolver o, si no dejó threads, el cuerpo de su review.
   * Sin bot en el pack siempre es `none`.
   */
  bot: z.object({
    state: z.enum(["none", "lgtm", "findings"]),
    sha: z.string().optional(),
    reviewId: z.int().optional(),
    at: z.string().optional(),
    findings: z.array(BotFinding),
  }),
  ci: z.object({
    state: z.enum(["pending", "green", "red", "none"]),
    sha: z.string(),
    /** Nombres de los checks en rojo que cuentan para el estado. */
    failing: z.array(z.string()),
    /** Los de `failing` que el pack declara flaky conocidos (`ciRules.knownFlaky`). */
    flaky: z.array(z.string()),
    /** Por check de `failing`, lo que dice de su falla (descripción o título y resumen) y dónde verla. */
    details: z.record(z.string(), z.object({ description: z.string().optional(), url: z.string().optional() })).optional(),
  }),
  threads: z.object({
    /** Todos los threads sin resolver, de quien sean (humanos, bots, council, la cuenta conectada): los "hilos sin resolver" que muestra la vista de PRs. */
    unresolved: z.int().nonnegative(),
    humanOpen: z.int().nonnegative(),
    humanResolved: z.int().nonnegative(),
    botOpen: z.int().nonnegative(),
    /** Id del primer comentario de cada thread de council sin resolver y sin respuesta con el `commentPrefix` del pack. */
    councilOpen: z.array(z.int()),
    /** Hubo algún thread de council, aunque ya esté resuelto. */
    councilEver: z.boolean(),
  }),
  /** Lo que los humanos dijeron en reviews, comentarios y threads sin resolver del PR (con cuerpo), de lo más antiguo a lo más reciente. */
  talk: z.array(PrTalk),
  labels: z.array(PrLabel),
  /** Una entrada por señal del pack presente en el PR: id de la señal → nivel (`risk` → `high`). */
  signals: z.record(z.string(), z.string()),
  merge: PrMerge,
  /** "No mergear nunca este PR": lo marca el usuario (`pull_requests.hold`) y apaga `merge.offer` y `merge.auto`. */
  hold: z.boolean(),
});
export type PrState = z.infer<typeof PrState>;

/** Qué tan de tu lado está la pelota en un PR: lo primero que se mira para decidir cuál abrir. */
export type ReviewStatus = "changes" | "pending" | "approved" | "none";

/**
 * El estado de review de un PR abierto o en draft: pedir cambios o tener algo sin resolver o comentado
 * manda sobre una aprobación a medias.
 */
export function reviewStatusOf(pr: PrState): ReviewStatus {
  if (pr.state !== "open" && pr.state !== "draft") return "none";
  if (pr.reviewDecision === "changes_requested") return "changes";
  const kinds = new Set(pr.reviewers.map((r) => r.state));
  if (kinds.has("changes_requested")) return "changes";
  if (pr.reviewDecision === "approved" && kinds.has("approved")) return "approved";
  if (kinds.has("pending")) return "pending";
  if (kinds.has("commented") || pr.threads.unresolved > 0) return "changes";
  if (kinds.has("approved")) return "approved";
  if (pr.reviewDecision === "review_required" && pr.state === "open") return "pending";
  return "none";
}

/**
 * Cómo la UI pinta una señal del pack (`PackSettings.signals`) sin conocerla: el nombre de cada nivel, su tono y qué
 * dice el tooltip. `empty` es lo que se muestra cuando el PR no la tiene. `match` y `flags` son el patrón de sus
 * labels: la UI esconde esos labels porque ya se ven como el chip de la señal.
 */
export const PrSignal = z.object({
  id: z.string(),
  match: z.string(),
  flags: z.string().optional(),
  empty: z.string().optional(),
  levels: z.record(z.string(), z.object({ label: z.string(), tone: SignalTone, hint: z.string() })),
});
export type PrSignal = z.infer<typeof PrSignal>;

/** Un PR del caché de Watch (`pull_requests`): lo último que se leyó de él, sin ir a GitHub. */
export const CachedPr = z.object({
  /** El id del PR en el core: el `subject.id` de las corridas que lo toman como sujeto. */
  id: z.string(),
  repo: z.string(),
  /** `null` en un PR local: todavía no existe en GitHub. */
  ref: PrRef.nullable(),
  /** Un PR apilado que vive solo en la máquina hasta que su base se mergea; `null` en uno de GitHub. */
  local: z.object({ branch: z.string(), base: z.string(), title: z.string() }).nullable(),
  /** Lo abrió el sistema (`pr.publish`); los demás los descubrió la búsqueda de tus PRs. */
  owned: z.boolean(),
  /** El sujeto de la corrida que lo abrió. */
  issueId: IssueId.nullable(),
  runId: RunId.nullable(),
  /**
   * De qué PRs cuelga (`pr_parents`, el `id` de cada uno, ordenados por id). Con dos o más su base es
   * una base combinada: la rama sintética que junta a todos.
   */
  parents: z.array(z.string()),
  /** Las señales del pack de la org del repo: lo que `state.signals` (id → nivel) significa. */
  signals: z.array(PrSignal),
  /** El pack de la org del repo define un bot de review: sin él, `prs.requestReview` no tiene a quién pedírselo. */
  reviewBot: z.boolean(),
  /** `null` mientras Watch no lo haya leído ni una vez. */
  state: PrState.nullable(),
  /** ms epoch de la última lectura de `state`. */
  readAt: z.number().nullable(),
  /** La propuesta vigente del chat del PR, si está por aplicarse (`draft`) o aplicándose: lo que marcan la lista y el grafo. */
  chatProposal: z.enum(["draft", "applying"]).optional(),
});
export type CachedPr = z.infer<typeof CachedPr>;

export const PrFilter = z.object({
  issueId: IssueId.optional(),
  /** `owner/repo` */
  repo: z.string().optional(),
  owned: z.boolean().optional(),
  /** El estado de GitHub del PR (`draft` cuenta como `open`), o `local` para los que aún no se publican. */
  state: z.enum(["open", "closed", "merged", "local"]).optional(),
  /** Solo estos PRs (por su id), en cualquier estado: la vista de una corrida nombra así a uno que ya se cerró. */
  ids: z.array(z.string().min(1)).max(200).optional(),
});
export type PrFilter = z.infer<typeof PrFilter>;

/** `prs.republish`: qué PRs rehacer y si solo planearlo. */
export const RepublishInput = z.object({
  /** Solo los PRs de las issues de este proyecto; sin él, los de todos. */
  projectId: ProjectId.optional(),
  /** Solo los PRs con estos números (de cualquier repo); vacío: todos los abiertos del sistema. */
  prs: z.array(z.int().positive()).default([]),
  /** Solo los PRs en draft: uno que ya salió de draft no se toca (un draft apilado sobre él sale sobre su branch actual). */
  draftOnly: z.boolean().default(false),
  /** Lista `viejo → branch nueva` sin tocar GitHub, el repo ni el core, y sin correr al committer (no gasta). */
  dryRun: z.boolean().default(false),
});
export type RepublishInput = z.input<typeof RepublishInput>;

/**
 * Qué pasó (o pasaría, con `dryRun`: `planned`) con un PR. `branch` y `base` son los del PR nuevo. `commits`:
 * con `dryRun`, los commits que tiene hoy el PR viejo (el committer puede cortarlos distinto); si no, los del PR nuevo.
 * `newNumber` es el PR nuevo, que existe aunque `reason` diga que algo posterior (el feedback) quedó pendiente.
 * `skipped` y `failed` llevan su razón. `pending` espera a que su padre publique su PR nuevo y `running` tiene la corrida
 * en marcha (con `newNumber` en cuanto publicó): ninguno es final.
 */
export const PrRepublish = z.object({
  repo: z.string().min(1),
  number: z.int().positive(),
  status: z.enum(["planned", "pending", "running", "republished", "skipped", "failed"]),
  branch: z.string().optional(),
  base: z.string().optional(),
  commits: z.int().nonnegative().optional(),
  newNumber: z.int().positive().optional(),
  reason: z.string().optional(),
});
export type PrRepublish = z.infer<typeof PrRepublish>;

/**
 * El avance de una republicación: `results` en orden de stack y `done` cuando ninguno quedó `pending` ni `running`.
 * `id` es lo que pide `prs.republishProgress`.
 */
export const RepublishProgress = z.object({ id: z.string().min(1), done: z.boolean(), results: z.array(PrRepublish) });
export type RepublishProgress = z.infer<typeof RepublishProgress>;

/**
 * Por qué no se puede pedir el merge de un PR por la estrategia del pack (`prs.merge`), o `undefined` si se puede. Es
 * la regla del core: `prs.merge` rechaza con este motivo y la UI apaga el ítem con él, así nunca ofrece lo que el core
 * va a rechazar. Que el repo se mergee con el botón de GitHub (`merge.via`) no es un bloqueo: ahí la UI manda a GitHub.
 */
export function mergeBlocker({ hold, merge }: Pick<PrState, "hold" | "merge">): string | undefined {
  if (hold) return "tiene hold (no mergear nunca): quítalo antes de mergear";
  if (merge.queue === "queued") return "ya está en cola: el merge ya se pidió";
  if (merge.queue === "failed") return "el merge falló en la cola: revisa por qué en GitHub antes de volver a pedirlo";
  if (!merge.ready) return merge.blockers.length > 0 ? `no está listo para mergear: ${merge.blockers.join(", ")}` : "no está listo para mergear";
  return undefined;
}

/**
 * Por qué el core no rebasea un PR (`prs.rebase`), o `undefined` si puede: solo uno que abrió el sistema (`owned`),
 * abierto y que nunca tuvo threads de council (rebasear reescribe su historia). La UI ofrece rebasear con la misma regla.
 */
export function rebaseBlocker({ state, threads }: Pick<PrState, "state" | "threads">, owned: boolean): string | undefined {
  if (!owned) return "no lo abrió el sistema: el core nunca reescribe la branch de un PR ajeno";
  if (state === "merged" || state === "closed") return `ya está ${state === "merged" ? "mergeado" : "cerrado"}`;
  if (threads.councilEver) return "tiene threads de council: rebasear reescribiría su historia y eso nunca se fuerza";
  return undefined;
}

/** Un commit de un PR local, del más viejo al más nuevo. */
export const LocalPrCommit = z.object({
  sha: z.string(),
  subject: z.string(),
  /** El cuerpo del mensaje, sin el asunto. */
  body: z.string(),
  author: z.string(),
  /** ISO 8601, la fecha de autor. */
  date: z.string(),
});
export type LocalPrCommit = z.infer<typeof LocalPrCommit>;

/** Un archivo que cambia el PR local, como lo cuenta `git diff --numstat` (binario: `null`). */
export const LocalPrFile = z.object({ path: z.string(), additions: z.int().nullable(), deletions: z.int().nullable() });
export type LocalPrFile = z.infer<typeof LocalPrFile>;

/**
 * `prs.detail`: descripción, commits y diff de un PR local o remoto. El diff es
 * contra el punto donde la branch sale de su base (`git diff base...branch`, como GitHub), y `patch` se corta en
 * `LOCAL_PR_PATCH_MAX` caracteres (`truncated`).
 */
export const PrDetail = z.object({
  id: z.string(),
  repo: z.string(),
  branch: z.string(),
  base: z.string(),
  baseSha: z.string(),
  title: z.string(),
  body: z.string(),
  head: z.string(),
  commits: z.array(LocalPrCommit),
  files: z.array(LocalPrFile),
  patch: z.string(),
  truncated: z.boolean(),
});
export type PrDetail = z.infer<typeof PrDetail>;
export const LocalPrDetail = PrDetail;
export type LocalPrDetail = PrDetail;

export const LocalPrId = z.strictObject({ id: z.string().min(1) });
export const LocalPrUpdate = LocalPrId.extend({
  title: z.string().trim().min(1).max(256).regex(/^[^\r\n]+$/).optional(),
  body: z.string().max(65_536).optional(),
}).refine(({ title, body }) => title !== undefined || body !== undefined, "Indica un título o una descripción para cambiar.");
export type LocalPrUpdate = z.infer<typeof LocalPrUpdate>;
export const LocalPrMetadata = LocalPrId.extend({ title: z.string(), body: z.string() });
export type LocalPrMetadata = z.infer<typeof LocalPrMetadata>;

export const LocalPrPatch = LocalPrId.extend({
  /** SHA completo devuelto por `prs.localDetail`: un patch nunca se aplica a una punta distinta. */
  head: z.string().regex(/^[0-9a-f]{40}$/),
  patch: z.string().min(1).max(2_000_000),
});
export type LocalPrPatch = z.infer<typeof LocalPrPatch>;

/** `prs.localCommitDiff`: el diff de un solo commit de un PR local (contra su padre), para revisarlo commit por commit. */
export const LocalCommitDiff = z.object({ sha: z.string(), files: z.array(LocalPrFile), patch: z.string(), truncated: z.boolean() });
export type LocalCommitDiff = z.infer<typeof LocalCommitDiff>;
export const PrCommitDiff = LocalCommitDiff;
export type PrCommitDiff = LocalCommitDiff;

/** Hasta dónde llega el `patch` de `prs.localDetail`: más que esto no se lee en pantalla y congela la vista. */
export const LOCAL_PR_PATCH_MAX = 2_000_000;

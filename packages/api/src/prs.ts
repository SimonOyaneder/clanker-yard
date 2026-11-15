import * as z from "zod";
import { RunId } from "./domain";

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

export const PrState = z.object({
  /** `repo#número`, por ejemplo `api#4251`. */
  key: z.string(),
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
  }),
  threads: z.object({
    /** Todos los threads sin resolver, de quien sean (humanos, bots, council, la cuenta conectada): los "hilos sin resolver" de Clanker Control. */
    unresolved: z.int().nonnegative(),
    humanOpen: z.int().nonnegative(),
    humanResolved: z.int().nonnegative(),
    botOpen: z.int().nonnegative(),
    /** Id del primer comentario de cada thread de council sin resolver y sin respuesta con el `commentPrefix` del pack. */
    councilOpen: z.array(z.int()),
    /** Hubo algún thread de council, aunque ya esté resuelto. */
    councilEver: z.boolean(),
  }),
  /** Lo que los humanos dijeron en reviews y comentarios del PR (con cuerpo), de la más antigua a la más reciente. */
  talk: z.array(PrTalk),
  labels: z.array(PrLabel),
  /** Una entrada por señal del pack presente en el PR: id de la señal → nivel (`risk` → `high`). */
  signals: z.record(z.string(), z.string()),
});
export type PrState = z.infer<typeof PrState>;

/** Qué tan de tu lado está la pelota en un PR: lo primero que se mira para decidir cuál abrir. */
export type ReviewStatus = "changes" | "pending" | "approved" | "none";

/**
 * El estado de review de un PR abierto o en draft, con las reglas de `reviewStatus` de Clanker Control:
 * pedir cambios o tener algo sin resolver o comentado manda sobre una aprobación a medias.
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

/** Un PR del caché de Watch (`pull_requests`): lo último que se leyó de él, sin ir a GitHub. */
export const CachedPr = z.object({
  ref: PrRef,
  /** Lo abrió el sistema (`pr.publish`); los demás los descubrió la búsqueda de tus PRs. */
  owned: z.boolean(),
  /** El sujeto de la corrida que lo abrió. */
  issueId: z.string().nullable(),
  runId: RunId.nullable(),
  /** `null` mientras Watch no lo haya leído ni una vez. */
  state: PrState.nullable(),
  /** ms epoch de la última lectura de `state`. */
  readAt: z.number().nullable(),
});
export type CachedPr = z.infer<typeof CachedPr>;

export const PrFilter = z.object({
  /** `owner/repo` */
  repo: z.string().optional(),
  owned: z.boolean().optional(),
  /** El estado de GitHub del PR (`draft` cuenta como `open`). */
  state: z.enum(["open", "closed", "merged"]).optional(),
});
export type PrFilter = z.infer<typeof PrFilter>;

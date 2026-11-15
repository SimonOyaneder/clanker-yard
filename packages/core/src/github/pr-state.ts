import type { PrState, ReviewerState, ResolvedPack } from "@clanker/api";
import type { Actor, PrNode, RawContext, RawReview, RawThread } from "./pr-query";

export interface PrStateContext {
  /** Lo que el pack decide (`packs.packFor`); sin pack son los defaults neutros. */
  pack: ResolvedPack;
  /** Login de la cuenta conectada: lo que ella escribió no es un humano esperando respuesta. */
  viewer: string;
}

/** Largo máximo del extracto de un comentario o review en `talk`. */
export const EXCERPT_MAX_CHARS = 200;

const DEFAULT_OK_STATES = ["SUCCESS", "SKIPPED", "NEUTRAL"];

/**
 * El estado normalizado de un PR. Es puro: todo lo que depende de la organización sale del pack, y sin
 * pack no hay bot, ni señales, ni reglas de CI propias.
 */
export function buildPrState(node: PrNode, { pack, viewer }: PrStateContext): PrState {
  const botLogins = new Set(pack.reviewBot?.logins);
  const ignore = pack.actors.ignore === undefined ? undefined : new RegExp(pack.actors.ignore);
  // Un humano no es un bot de GitHub, ni una cuenta que el pack ignora, ni el bot de review del pack.
  const isHuman = (actor: Actor | null): actor is Actor =>
    !!actor && actor.__typename !== "Bot" && !botLogins.has(actor.login) && !ignore?.test(actor.login);

  return {
    key: `${node.repo.name}#${node.number}`,
    state: node.state === "MERGED" ? "merged" : node.state === "CLOSED" ? "closed" : node.isDraft ? "draft" : "open",
    headRef: node.headRefName,
    headSha: node.headRefOid,
    baseRef: node.baseRefName,
    baseIsDefault: node.baseRefName === node.repo.defaultBranch,
    mergeable: mergeableOf(node),
    ...(node.mergeCommit && { mergeCommitSha: node.mergeCommit.oid }),
    reviewDecision: node.reviewDecision?.toLowerCase() as PrState["reviewDecision"] ?? "none",
    reviewers: reviewersOf(node, isHuman),
    bot: botOf(node, pack),
    ci: ciOf(node, pack),
    threads: threadsOf(node, pack, isHuman, viewer),
    talk: talkOf(node, pack, isHuman, viewer),
    labels: node.labels,
    signals: signalsOf(node, pack),
  };
}

function mergeableOf(node: PrNode): PrState["mergeable"] {
  if (node.mergeable === "CONFLICTING") return "conflict";
  if (node.mergeable === "UNKNOWN") return "unknown";
  return node.mergeStateStatus === "BEHIND" ? "behind" : "clean";
}

type IsHuman = (actor: Actor | null) => actor is Actor;

const byTime = (time: string | null | undefined) => time ?? "";

/**
 * El último estado de cada revisor humano. Una review descartada lo borra, un comentario posterior no
 * le quita la aprobación y una review pedida de nuevo vuelve a `pending`.
 */
function reviewersOf(node: PrNode, isHuman: IsHuman): ReviewerState[] {
  const byLogin = new Map<string, ReviewerState>();
  const reviews = [...node.reviews].sort((a, b) => byTime(a.submittedAt).localeCompare(byTime(b.submittedAt)));
  for (const review of reviews) {
    const author = review.author;
    if (!isHuman(author) || author.login === node.author?.login) continue;
    if (review.state === "DISMISSED") {
      byLogin.delete(author.login);
      continue;
    }
    if (review.state === "PENDING") continue;
    const state = review.state === "APPROVED" ? "approved" : review.state === "CHANGES_REQUESTED" ? "changes_requested" : "commented";
    if (state === "commented" && byLogin.get(author.login)?.state === "approved") continue;
    byLogin.set(author.login, { login: author.login, avatarUrl: author.avatarUrl ?? null, state });
  }
  for (const requested of node.requestedReviewers) {
    if (!isHuman(requested) || requested.login === node.author?.login) continue;
    byLogin.set(requested.login, { login: requested.login, avatarUrl: requested.avatarUrl ?? null, state: "pending" });
  }
  return [...byLogin.values()];
}

function botOf(node: PrNode, { reviewBot }: ResolvedPack): PrState["bot"] {
  if (!reviewBot) return { state: "none" };
  const last = node.reviews
    .filter((r) => r.author && reviewBot.logins.includes(r.author.login) && r.state !== "PENDING" && r.state !== "DISMISSED")
    .sort((a, b) => byTime(a.submittedAt).localeCompare(byTime(b.submittedAt)))
    .at(-1);
  if (!last) return { state: "none" };

  const { lgtm } = reviewBot;
  const sha = last.commit?.oid;
  const review = { ...(sha && { sha }), reviewId: Number(last.fullDatabaseId) };
  if (!isLgtm(last, lgtm)) return { state: "findings", ...review };
  // Un LGTM de un commit anterior no vale para el head de hoy: es como si el bot no hubiera revisado.
  if (lgtm.sameSha && sha !== node.headRefOid) return { state: "none" };
  return { state: "lgtm", ...review };
}

function isLgtm(review: RawReview, lgtm: NonNullable<ResolvedPack["reviewBot"]>["lgtm"]): boolean {
  return review.state === lgtm.reviewState && (lgtm.bodyMatch === undefined || new RegExp(lgtm.bodyMatch).test(review.body));
}

type CheckState = "SUCCESS" | "SKIPPED" | "NEUTRAL" | "FAILURE" | "ERROR" | "PENDING";

function checkOf(context: RawContext): { name: string; state: CheckState; required: boolean } {
  if (context.__typename === "StatusContext") {
    return {
      name: context.context,
      state: context.state === "EXPECTED" ? "PENDING" : context.state,
      required: context.isRequired,
    };
  }
  const { conclusion } = context;
  // Un check completo sin conclusión no es verde: no sabemos cómo terminó.
  const state: CheckState =
    context.status !== "COMPLETED"
      ? "PENDING"
      : conclusion === "SUCCESS" || conclusion === "NEUTRAL" || conclusion === "SKIPPED"
        ? conclusion
        : "FAILURE";
  return { name: context.name, state, required: context.isRequired };
}

/**
 * Con `ciRules` del pack cuentan todos los checks menos `ignoreChecks`; sin ellas, solo los checks
 * requeridos de la branch protection. Rojo gana sobre pendiente.
 */
function ciOf(node: PrNode, { ciRules }: ResolvedPack): PrState["ci"] {
  const checks = node.head.contexts.map(checkOf);
  const ignored = new Set(ciRules?.ignoreChecks);
  const counted = ciRules ? checks.filter((c) => !ignored.has(c.name)) : checks.filter((c) => c.required);
  const ok = new Set<string>(ciRules?.okStates ?? DEFAULT_OK_STATES);

  const notOk = counted.filter((c) => !ok.has(c.state));
  const failing = notOk.filter((c) => c.state !== "PENDING").map((c) => c.name);
  const state = counted.length === 0 ? "none" : failing.length > 0 ? "red" : notOk.length > 0 ? "pending" : "green";
  return { state, sha: node.head.oid, failing };
}

/**
 * Cada thread es de quien escribe su primer comentario: council si lleva el prefijo del pack, bot si es
 * el bot de review, humano si no es ni un bot ni la cuenta conectada. Lo demás no se cuenta. Un thread de
 * council está abierto hasta que se resuelve o lo responde un comentario con el `commentPrefix` del
 * pack: el agente lo responde pero no lo resuelve (como `clanker-loop watch`).
 */
function threadsOf(node: PrNode, pack: ResolvedPack, isHuman: IsHuman, viewer: string): PrState["threads"] {
  const prefix = pack.conventions.councilPrefix;
  const threads: PrState["threads"] = { humanOpen: 0, humanResolved: 0, botOpen: 0, councilOpen: [], councilEver: false };
  for (const thread of node.reviewThreads) {
    const first = thread.comments.nodes[0];
    if (!first) continue;
    const login = first.author?.login;
    if (prefix && first.body.startsWith(prefix)) {
      threads.councilEver = true;
      if (!thread.isResolved && !answered(thread, pack.conventions.commentPrefix)) {
        threads.councilOpen.push(Number(first.fullDatabaseId));
      }
    } else if (login && pack.reviewBot?.logins.includes(login)) {
      if (!thread.isResolved) threads.botOpen++;
    } else if (isHuman(first.author) && login !== viewer) {
      if (thread.isResolved) threads.humanResolved++;
      else threads.humanOpen++;
    }
  }
  return threads;
}

function answered(thread: RawThread, prefix: string | undefined): boolean {
  return prefix !== undefined && thread.comments.nodes.slice(1).some((reply) => reply.body.startsWith(prefix));
}

/**
 * Lo que dijeron los humanos. Una review aprobada o comentada sin texto (o que calza con
 * `silentReviewBody`, sin distinguir mayúsculas: un "LGTM" solo) no cuenta; una que pide cambios siempre.
 */
function talkOf(node: PrNode, pack: ResolvedPack, isHuman: IsHuman, viewer: string): PrState["talk"] {
  const silent = pack.actors.silentReviewBody === undefined ? undefined : new RegExp(pack.actors.silentReviewBody, "i");
  const talk: PrState["talk"] = [];
  for (const review of node.reviews) {
    const { author, state, body } = review;
    if (!isHuman(author) || author.login === viewer || !review.submittedAt) continue;
    if (state === "PENDING" || state === "DISMISSED") continue;
    if (state === "CHANGES_REQUESTED") {
      talk.push({ kind: "changes", author: author.login, at: review.submittedAt, excerpt: excerptOf(body) });
    } else if (body.trim() !== "" && !silent?.test(body)) {
      talk.push({ kind: "review", author: author.login, at: review.submittedAt, excerpt: excerptOf(body) });
    }
  }
  for (const comment of node.comments) {
    if (isHuman(comment.author) && comment.author.login !== viewer) {
      talk.push({ kind: "comment", author: comment.author.login, at: comment.createdAt, excerpt: excerptOf(comment.body) });
    }
  }
  return talk.sort((a, b) => a.at.localeCompare(b.at));
}

function excerptOf(body: string): string {
  const text = body.replace(/\s+/g, " ").trim();
  return text.length > EXCERPT_MAX_CHARS ? `${text.slice(0, EXCERPT_MAX_CHARS - 1)}…` : text;
}

/** El primer label que calza con una señal da su nivel (en minúsculas, con los alias del pack). */
function signalsOf(node: PrNode, { signals }: ResolvedPack): PrState["signals"] {
  const out: PrState["signals"] = {};
  for (const signal of signals) {
    const match = new RegExp(signal.match, signal.flags);
    for (const label of node.labels) {
      const found = match.exec(label.name.trim());
      if (!found) continue;
      const raw = (found[1] ?? found[0]).toLowerCase();
      const level = signal.alias?.[raw] ?? raw;
      if (Object.hasOwn(signal.levels, level)) {
        out[signal.id] = level;
        break;
      }
    }
  }
  return out;
}

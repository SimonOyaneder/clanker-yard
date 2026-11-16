import { PrRef, type ResolvedPack } from "@clanker/api";
import * as z from "zod";
import { cleanMessage } from "../../commits/apply";
import type { Connections } from "../../connections/connections";
import { PermanentActionError, type ActionCtx, type ActionDef, type ActionResult } from "../../flows/catalog";
import type { Packs } from "../../packs/packs";
import type { GitHubClient } from "../client";
import { fetchPr, PrNotFoundError, type PrNode, type RawThread } from "../pr-query";
import { answered, humanTest } from "../pr-state";

// Lo que el core escribe en un PR además de publicarlo: comentarios, respuestas a threads, resolverlos y
// pedirle review al bot (`docs/design.html#d-agents`, biblioteca de acciones). Todo sale con el token de
// la cuenta del PR, o sea con la identidad del usuario, y lo que dice cada pack (prefijo de los
// comentarios, bot, autores resolubles, prefijo del council) se lee del pack de la org del repo.

/** Pausa entre dos escrituras seguidas: GitHub limita las escrituras de contenido (cuota secundaria). */
const WRITE_GAP_MS = 1000;

/** Un thread se nombra por el id de su primer comentario (el `fullDatabaseId`), como los ítems de triage. */
const ThreadId = z.union([z.string().min(1), z.int()]).transform(String);

const sleep = (ms: number, signal: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    const onAbort = () => (clearTimeout(timer), reject(signal.reason));
    const timer = setTimeout(() => (signal.removeEventListener("abort", onAbort), resolve()), ms);
    signal.addEventListener("abort", onAbort, { once: true });
  });

export interface PrFeedbackDeps {
  connections: Pick<Connections, "githubClient">;
  packs: Packs;
  /** Cómo se espera entre escrituras; los tests la reemplazan para no esperar. */
  pause?: (ms: number, signal: AbortSignal) => Promise<void>;
}

type Target = { client: GitHubClient; owner: string; name: string; number: number; pack: ResolvedPack };

/** Un PR que no existe no se arregla reintentando (un 401 ya dejó la cuenta revocada en el cliente). */
async function onPr<T>(deps: PrFeedbackDeps, ref: PrRef, run: (target: Target) => Promise<T>): Promise<T> {
  const [owner, name] = ref.repo.split("/") as [string, string];
  const target = { client: deps.connections.githubClient(ref.account), owner, name, number: ref.number, pack: deps.packs.packFor({ githubOrg: owner }) };
  try {
    return await run(target);
  } catch (error) {
    if (error instanceof PrNotFoundError) throw new PermanentActionError(error.message, { cause: error });
    throw error;
  }
}

/** Corre cada escritura de una acción con `WRITE_GAP_MS` desde la anterior. */
function spaced(deps: PrFeedbackDeps, signal: AbortSignal) {
  let wrote = false;
  return async <T>(write: () => Promise<T>): Promise<T> => {
    if (wrote) await (deps.pause ?? sleep)(WRITE_GAP_MS, signal);
    wrote = true;
    return write();
  };
}

/** La marca que identifica un comentario o respuesta del core: sin ella un reintento lo duplicaría. */
const markerOf = (key: string) => `<!-- clanker:${key} -->`;

/** El texto sin líneas que lo firmen como hecho por una IA, con el prefijo de comentarios del pack. */
const withPrefix = (pack: ResolvedPack, text: string) => `${pack.conventions.commentPrefix ?? ""}${cleanMessage(text)}`;

const IssueComment = z.object({ id: z.number(), body: z.string().nullable(), created_at: z.string(), html_url: z.string() });

const COMMENTS_ROUTE = "/repos/{owner}/{repo}/issues/{issue_number}/comments";

async function postComment({ client, owner, name, number }: Target, body: string, write: ReturnType<typeof spaced>) {
  const { data } = await write(() => client.request(`POST ${COMMENTS_ROUTE}`, { owner, repo: name, issue_number: number, body }));
  return IssueComment.parse(data);
}

/** Publica un comentario de la conversación del PR salvo que ya exista uno con la marca de `key`. */
async function ensureComment(
  target: Target,
  { key, body }: { key: string; body: string },
  write: ReturnType<typeof spaced>,
): Promise<{ created: boolean; comment: z.infer<typeof IssueComment> }> {
  const { client, owner, name, number } = target;
  const marker = markerOf(key);
  const PAGE = 100;
  for (let page = 1; ; page++) {
    const { data } = await client.request(`GET ${COMMENTS_ROUTE}`, { owner, repo: name, issue_number: number, per_page: PAGE, page });
    const comments = z.array(IssueComment).parse(data);
    const found = comments.find((c) => c.body?.includes(marker));
    if (found) return { created: false, comment: found };
    if (comments.length < PAGE) break;
  }
  return { created: true, comment: await postComment(target, `${body}\n\n${marker}`, write) };
}

/**
 * Pide la review al bot del pack con su comando exacto, sin prefijo ni marca HTML: el clanker-loop
 * comenta el comando solo, y lo que el bot hace con otro texto en el comentario no está a la vista (su
 * disparador puede exigir apenas que lo contenga). Sin marca no se puede buscar antes de publicar:
 * que un reintento no lo duplique lo da `ctx.once`, y si el proceso muere entre el comentario y el
 * guardado, el reintento comenta otra vez. `undefined`: el pack no tiene bot.
 */
async function requestBot(target: Target, ctx: ActionCtx, write: ReturnType<typeof spaced>): Promise<{ requestedAt: number } | undefined> {
  const bot = target.pack.reviewBot;
  if (!bot) return undefined;
  return ctx.once("requestBot", async () => {
    const comment = await postComment(target, bot.request.body, write);
    return { requestedAt: Date.parse(comment.created_at) };
  });
}

const RESOLVE_THREAD = `mutation ResolveThread($id: ID!) { resolveReviewThread(input: { threadId: $id }) { thread { id isResolved } } }`;

type ThreadOwner = "council" | "resolvable" | "automation" | "human";

/**
 * De quién es un thread: de quien escribe su primer comentario. Council (por el prefijo del pack, sea
 * quien sea el autor) antes que un autor resoluble del pack, antes que un bot o cuenta de sistema; el
 * resto es un humano.
 */
function ownerOf(thread: RawThread, pack: ResolvedPack): ThreadOwner {
  const first = thread.comments.nodes[0]!;
  const councilPrefix = pack.conventions.councilPrefix;
  if (councilPrefix && first.body.startsWith(councilPrefix)) return "council";
  if (first.author && pack.reviewBot?.resolvableAuthors?.includes(first.author.login)) return "resolvable";
  return humanTest(pack)(first.author) ? "human" : "automation";
}

/** El thread cuyo primer comentario es `id`, con lo que el core sabe de él. */
function findThread(node: PrNode, pack: ResolvedPack, id: string) {
  const thread = node.reviewThreads.find((t) => t.comments.nodes[0]?.fullDatabaseId === id);
  return thread && { thread, owner: ownerOf(thread, pack) };
}

async function resolveThread(client: GitHubClient, thread: RawThread, write: ReturnType<typeof spaced>): Promise<void> {
  await write(() => client.graphql(RESOLVE_THREAD, { id: thread.id }));
}

const CommentArgs = z.object({ pr: PrRef, body: z.string().min(1) });

/**
 * `pr.comment`: un comentario en la conversación del PR, con el prefijo de comentarios del pack. Lleva
 * `<!-- clanker:clave -->` con la `key` del paso y se busca antes de publicar, así que re-ejecutar no
 * lo duplica. Output: `{ created, url }` (`created: false` si ya estaba).
 */
export function prCommentAction(deps: PrFeedbackDeps): ActionDef<typeof CommentArgs> {
  return {
    name: "pr.comment",
    args: CommentArgs,
    outcomes: ["ok"],
    effects: "remote",
    run: (args, ctx) =>
      onPr(deps, args.pr, async (target) => {
        if (cleanMessage(args.body) === "") throw new PermanentActionError("pr.comment no tiene texto que publicar.");
        const body = withPrefix(target.pack, args.body);
        const { created, comment } = await ensureComment(target, { key: ctx.key, body }, spaced(deps, ctx.signal));
        return { outcome: "ok", output: { created, url: comment.html_url } };
      }),
  };
}

const ResolveArgs = z.object({ pr: PrRef, thread: ThreadId });

/**
 * `pr.resolveThread`: resuelve un thread solo si lo abrió un autor de `reviewBot.resolvableAuthors` del
 * pack. Los de humanos, los de council (cualquier autor) y los de cuentas que el pack no lista se
 * rechazan con outcome `refused` y `reason`, sin tocar GitHub.
 */
export function prResolveThreadAction(deps: PrFeedbackDeps): ActionDef<typeof ResolveArgs> {
  return {
    name: "pr.resolveThread",
    args: ResolveArgs,
    outcomes: ["ok", "refused"],
    effects: "remote",
    run: (args, ctx) =>
      onPr(deps, args.pr, async ({ client, owner, name, number, pack }) => {
        const found = findThread(await fetchPr(client, { owner, name }, number), pack, args.thread);
        if (!found) return { outcome: "refused", output: { reason: `El PR no tiene un thread abierto por el comentario ${args.thread}.` } };
        if (found.owner !== "resolvable") return { outcome: "refused", output: { reason: `El thread es de ${found.owner}: el core no lo resuelve.` } };
        if (!found.thread.isResolved) await resolveThread(client, found.thread, spaced(deps, ctx.signal));
        return { outcome: "ok", output: {} };
      }),
  };
}

const ReplyArgs = z.object({
  pr: PrRef,
  /**
   * El reporte del triage: cada ítem es un thread por el id de su primer comentario. Sin reporte (el flujo
   * llegó aquí sin triage del bot, p. ej. tras un CI rojo) no hay a quién responder.
   */
  triage: z
    .object({ items: z.array(z.object({ id: ThreadId, reply: z.string().optional() })) })
    .nullish()
    .transform((triage) => triage ?? { items: [] }),
  /** El sha del fixup que arregló cada ítem (`pr.pushFixups`): sin `reply`, es lo que se le dice al thread. */
  shas: z.record(z.string(), z.string()).default({}),
  /**
   * Los ítems que el dev no aplicó (`DevWorkReport.rejected`), cada uno con su razón: el thread recibe la
   * razón aunque `shas` traiga un sha para él (`pr.pushFixups` da uno a todo ítem que le pasaron).
   */
  rejected: z
    .array(z.object({ id: ThreadId, reason: z.string() }))
    .nullish()
    .transform((rejected) => rejected ?? []),
  /** Después de responder, vuelve a pedirle review al bot del pack. */
  rerequestBot: z.boolean().default(false),
});

/**
 * `pr.reply`: responde cada ítem del triage en su thread, con el sha del fixup que lo arregló o con la
 * razón (`reply`, o la de `rejected`, que gana) y con el prefijo de comentarios del pack. Después resuelve
 * el thread si es de un autor resoluble del pack; los de council se responden y no se resuelven, y uno ya
 * respondido (otra vuelta del flujo, tras un CI rojo) no se vuelve a responder. Un thread humano solo se
 * responde con el PR en draft. Cada respuesta lleva `<!-- clanker:clave -->` y se busca antes de publicar: un
 * reintento retoma sin duplicar. Un ítem que no es un thread del PR (un check de CI) o sin qué decir se
 * salta.
 *
 * Output: `{ replied, resolved, skipped: [{ id, reason }], requestedAt? }`; con `rerequestBot` y un bot
 * en el pack, `requestedAt` es cuándo se le volvió a pedir la review (lo que espera `pr.botReview`).
 */
export function prReplyAction(deps: PrFeedbackDeps): ActionDef<typeof ReplyArgs> {
  return {
    name: "pr.reply",
    args: ReplyArgs,
    outcomes: ["ok"],
    effects: "remote",
    run: (args, ctx) =>
      onPr(deps, args.pr, async (target) => {
        const { client, owner, name, number, pack } = target;
        const node = await fetchPr(client, { owner, name }, number);
        const write = spaced(deps, ctx.signal);
        const out = { replied: [] as string[], resolved: [] as string[], skipped: [] as { id: string; reason: string }[] };

        const reasons = new Map(args.rejected.map(({ id, reason }) => [id, reason]));

        for (const { id, reply } of args.triage.items) {
          const skip = (reason: string) => void out.skipped.push({ id, reason });
          const found = findThread(node, pack, id);
          if (!found) {
            skip("no es un thread del PR");
            continue;
          }
          if (found.owner === "human" && !node.isDraft) {
            skip("el thread es de un humano y el PR ya no está en draft");
            continue;
          }
          const sha = args.shas[id];
          const reason = reasons.get(id);
          const text = reason ?? (sha === undefined ? reply : `aplicado en ${sha.slice(0, 7)}`);
          if (!text || cleanMessage(text) === "") {
            skip("sin sha del fixup ni razón que decir");
            continue;
          }

          const marker = markerOf(`${ctx.key}:${id}`);
          const comments = found.thread.comments.nodes;
          const replied = comments.some((c) => c.body.includes(marker));
          if (!replied && found.owner === "council" && answered(found.thread, pack.conventions.commentPrefix)) {
            skip("el thread de council ya tiene una respuesta");
            continue;
          }
          if (!replied) {
            const body = `${withPrefix(pack, text)}\n\n${marker}`;
            await write(() =>
              client.request("POST /repos/{owner}/{repo}/pulls/{pull_number}/comments/{comment_id}/replies", {
                owner,
                repo: name,
                pull_number: number,
                comment_id: Number(id),
                body,
              }),
            );
          }
          out.replied.push(id);
          if (found.owner === "resolvable" && !found.thread.isResolved) {
            await resolveThread(client, found.thread, write);
            out.resolved.push(id);
          }
        }

        const requested = args.rerequestBot ? await requestBot(target, ctx, write) : undefined;
        return { outcome: "ok", output: { ...out, ...requested } };
      }),
  };
}

const CouncilThreadsArgs = z.object({ pr: PrRef });

/**
 * `council.threads` (`docs/design.html#d-flows`, plantilla council): los threads de council abiertos del PR,
 * los mismos que cuenta `PrState.threads.councilOpen` (con el prefijo del council del pack, sin resolver y
 * sin una respuesta con el prefijo de comentarios). Output del `ok`: `items`, uno por thread, con la forma
 * de `DevWorkBrief.instructions` (`id` es el del primer comentario, `change` su texto sin el prefijo) y
 * `path` y `line` para que `pr.pushFixups` ate cada ítem a su commit. `none` si no hay ninguno, o si el PR ya
 * no está abierto: no hay nada que atender.
 */
export function councilThreadsAction(deps: PrFeedbackDeps): ActionDef<typeof CouncilThreadsArgs> {
  return {
    name: "council.threads",
    args: CouncilThreadsArgs,
    outcomes: ["ok", "none"],
    effects: "local",
    run: (args) =>
      onPr(deps, args.pr, async ({ client, owner, name, number, pack }): Promise<ActionResult> => {
        const prefix = pack.conventions.councilPrefix;
        if (!prefix) return { outcome: "none" };
        const node = await fetchPr(client, { owner, name }, number);
        const items = (node.state === "OPEN" ? node.reviewThreads : []).flatMap((thread) => {
          const first = thread.comments.nodes[0];
          if (!first?.body.startsWith(prefix) || thread.isResolved || answered(thread, pack.conventions.commentPrefix)) return [];
          const line = first.line == null ? {} : { line: first.line };
          return [{ id: first.fullDatabaseId, path: first.path ?? "", ...line, change: first.body.slice(prefix.length).trim() }];
        });
        return items.length === 0 ? { outcome: "none" } : { outcome: "ok", output: { items } };
      }),
  };
}

const RequestBotArgs = z.object({ pr: PrRef });

/**
 * `review.requestBot`: le pide review al bot del pack con su comentario (`reviewBot.request`, tal cual,
 * sin prefijo). Sin bot en el pack, o sin pack, el outcome es `none`. Output del `ok`: `{ requestedAt }`,
 * en ms desde epoch según el reloj de GitHub, que es el de las reviews que `pr.botReview` compara.
 */
export function reviewRequestBotAction(deps: PrFeedbackDeps): ActionDef<typeof RequestBotArgs> {
  return {
    name: "review.requestBot",
    args: RequestBotArgs,
    outcomes: ["ok", "none"],
    effects: "remote",
    run: async (args, ctx: ActionCtx): Promise<ActionResult> => {
      const requested = await onPr(deps, args.pr, (target) => requestBot(target, ctx, spaced(deps, ctx.signal)));
      return requested ? { outcome: "ok", output: requested } : { outcome: "none" };
    },
  };
}

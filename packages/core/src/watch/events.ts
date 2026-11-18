import type { PrRef, PrState, RepoId } from "@clanker/api";
import { isAncestor, tryGit } from "../git/git";
import type { PrRow } from "../github/pr-cache";
import type { Store } from "../store/store";
import type { Repos } from "../repos/repos";
import type { Workspaces } from "../workspaces/workspaces";
import { approvalEpoch, emitOnce, lastEvaluatedHead, markHead, recordMarks, type PrEventInput } from "../github/marks";
import type { ErrorReporter } from "../errors/reporter";
import { closedPrsWithLiveChildren, openPrsWithDetail, prRefOf } from "../github/pr-rows";
import { and, eq, inArray } from "drizzle-orm";
import { combinedBases, pullRequests, workspaces as workspacesTable } from "../store/schema";
import { landedCommit } from "../github/landed";

// Los eventos de Watch (`docs/design.html#d-ops`, "Watch: eventos y qué disparan"): de lo que cambió en un
// PR salen los hechos nuevos, cada uno una sola vez por su clave en `watch_marks`.

/** Varios pushes seguidos (fixups de council, restack de una cadena) dan un solo evento por sha final. */
export const DEBOUNCE_MS = 20_000;

/**
 * Cuánto se sigue buscando en la base el commit de una cola de merge tras cerrarse un PR: la cola pushea a la base y
 * cierra el PR casi a la vez, y Watch puede leer el cierre antes que el push.
 */
export const LANDED_GRACE_MS = 10 * 60_000;
/** La marca de `watch_marks` de un PR cerrado cuya base ya se revisó (por su punta): no se vuelve a buscar. */
const LANDED_CHECKED = "landed.checked";

export interface PrEvents {
  /**
   * El estado de `ref` cambió (`PrCache.onChange`). Evalúa en segundo plano y nunca lanza: lo que falla se
   * anota con un evento `error`.
   */
  observe(ref: PrRef, state: PrState, row: PrRow): void;
  /**
   * Termina lo que está en vuelo y evalúa los PRs cuya punta nueva ya esperó su debounce sin que nadie
   * volviera a leerlos (`observe` solo se entera de lo que cambia). Watch lo llama en cada despertar.
   */
  flush(at?: number): Promise<void>;
}

export interface PrEventsDeps {
  store: Store;
  repos: Pick<Repos, "get" | "config">;
  /** Trae el remoto antes de mirar si una punta nueva desciende de la vieja. */
  workspaces: Pick<Workspaces, "fetch">;
  errors: ErrorReporter;
  now?: () => number;
}

export function createPrEvents({ store, repos, workspaces, errors, now = Date.now }: PrEventsDeps): PrEvents {
  // Una evaluación a la vez: dos del mismo PR no se pisan y los tests pueden esperar a que termine todo.
  let queue: Promise<void> = Promise.resolve();
  const enqueue = (scope: string, work: () => Promise<void>) => {
    queue = queue.then(work).then(
      () => errors.clear(scope),
      (error: unknown) => errors.report(scope, error),
    );
  };

  /**
   * `false` si no se puede saber: sin la punta vieja en el repo local no hay cómo ver si la nueva la
   * contiene, y confundir un push normal con un force push dispararía un restack de más.
   */
  async function wasRewritten(repoId: RepoId, from: string, to: string): Promise<boolean> {
    if ((await workspaces.fetch(repoId)) === "unauthorized") return false;
    const { path } = repos.config(repoId);
    if ((await tryGit(path, ["cat-file", "-e", `${from}^{commit}`])) === undefined) return false;
    return !(await isAncestor(path, from, to));
  }

  async function evaluate(row: PrRow, ref: PrRef, state: PrState, at: number): Promise<void> {
    const known = lastEvaluatedHead(store.db, row.id);
    const live = state.state === "open" || state.state === "draft";
    // La punta de la que viene el PR, si cambió desde la última vez.
    const from = known === state.headSha ? undefined : known;
    // Un PR que ya se cerró no espera: su punta no va a cambiar más y `flush` solo mira los abiertos.
    if (live && from !== undefined && row.headChangedAt !== null && at - row.headChangedAt < DEBOUNCE_MS) return; // `flush` vuelve a mirarlo.

    const facts = factsOf(state);
    // Una cola de merge (bors) cierra el PR sin mergearlo: si su contenido ya está en la base, para el stack es un merge.
    // Solo en un repo que el pack mergea con un comando a su cola (`merge.via: "comment"`): sin cola, un PR cerrado es eso.
    let landedChecked = false;
    if (state.state === "closed" && row.owned && state.merge.via === "comment") {
      const landed = await landedOf(row, state);
      if (landed) facts.push({ type: "pr.merged", keys: [state.key], payload: () => ({ sha: landed, headRef: state.headRef, baseRef: state.baseRef, queue: true }) });
      landedChecked = landed !== undefined || at - Date.parse(state.updatedAt) > LANDED_GRACE_MS;
    }
    if (live && from !== undefined && (await wasRewritten(row.repoId, from, state.headSha))) {
      facts.push({ type: "pr.base_rewritten", keys: [`${from}>${state.headSha}`], payload: () => ({ from, to: state.headSha }) });
    }
    store.tx((tx) => {
      if (state.state === "open") facts.push(...approvalFacts(state, approvalEpoch(tx, row.id, isApproved(state), at)));
      for (const fact of facts) {
        const input = { ...fact, payload: (fresh: string[]) => ({ repo: ref.repo, number: ref.number, ...fact.payload(fresh) }) };
        // Un humano que habla en un draft no avisa, ni siquiera en la primera lectura: sus marcas esperan a que salga de draft y entonces se suelta todo lo dicho.
        if (state.state === "draft" && fact.type === "pr.human") continue;
        // La primera vez que se ve un PR se siembra callado lo que ya pasó (los hechos sin `emitOnFirstRead`); lo que sigue pendiente se emite.
        if (known === undefined && !fact.emitOnFirstRead) recordMarks(tx, row.id, fact.type, fact.keys, at);
        else emitOnce(tx, row, input, at);
      }
      markHead(tx, row.id, state.headSha, at);
      if (landedChecked) recordMarks(tx, row.id, LANDED_CHECKED, [state.headSha], at);
    });
  }

  /**
   * Una base combinada en `conflict` (sus padres chocan) con un PR hijo vivo del sistema pide resolverla
   * (`pr.baseConflict`, que toma `base-combinada-conflicto`), una vez por punta del hijo y de los padres: así se
   * resuelven también las que quedaron en conflicto al publicar o antes de que el core supiera hacerlo.
   */
  function requestBaseResolutions(at: number): void {
    for (const base of store.db.select().from(combinedBases).where(eq(combinedBases.status, "conflict")).all()) {
      if (base.issueId === null) continue;
      const children = store.db
        .select()
        .from(pullRequests)
        .where(and(eq(pullRequests.repoId, base.repoId), eq(pullRequests.issueId, base.issueId), eq(pullRequests.owned, true), inArray(pullRequests.state, ["open", "local"])))
        .all();
      const cfg = repos.config(base.repoId);
      for (const child of children) {
        // Solo el hijo que sale de esta base: una fila vieja (la issue se relanzó sobre otra) no pide nada.
        const ws = store.db.select({ baseRef: workspacesTable.baseRef }).from(workspacesTable).where(and(eq(workspacesTable.repoId, child.repoId), eq(workspacesTable.branch, child.headRef))).get();
        if (ws?.baseRef !== base.branch) continue;
        const local = child.state === "local";
        store.tx((tx) =>
          emitOnce(
            tx,
            child,
            {
              type: "pr.baseConflict",
              keys: [`${child.headSha}:${base.parents.map((p) => p.sha).join(",")}`],
              payload: () => ({
                repo: cfg.remote?.repo,
                ...(local ? { prId: child.id, local: true } : { number: child.number }),
                sha: child.headSha,
                base: base.branch,
                resolveBranch: base.branch.replace(/^clanker\/base\//, "clanker/resolve/"),
                defaultBranch: cfg.defaultBranch,
              }),
            },
            at,
          ),
        );
      }
    }
  }

  /** El commit de la base por defecto que trae lo del PR cerrado, si ya llegó. */
  async function landedOf(row: PrRow, state: PrState): Promise<string | undefined> {
    if ((await workspaces.fetch(row.repoId)) === "unauthorized") return undefined;
    const { path, defaultBranch } = repos.config(row.repoId);
    return landedCommit(path, { headSha: state.headSha, defaultBranch });
  }

  return {
    observe(ref, state, row) {
      enqueue(`events ${ref.repo}#${ref.number}`, () => evaluate(row, ref, state, now()));
    },

    async flush(at = now()) {
      await queue;
      const rows = openPrsWithDetail(store.db);
      for (const row of rows) {
        const { detail } = row;
        const ref = prRefOf(repos, row);
        if (!detail || !ref || lastEvaluatedHead(store.db, row.id) === detail.headSha) continue;
        enqueue(`events ${ref.repo}#${ref.number}`, () => evaluate(row, ref, detail, at));
      }
      // Los PRs del sistema que se cerraron con hijos vivos y nadie revisó si una cola los mergeó (por ejemplo, cerrados
      // antes de que Watch supiera hacerlo): se revisan una vez.
      for (const row of closedPrsWithLiveChildren(store.db, LANDED_CHECKED)) {
        const ref = prRefOf(repos, row);
        if (!row.detail || !ref || row.detail.merge.via !== "comment") continue;
        const detail = row.detail;
        enqueue(`events ${ref.repo}#${ref.number}`, () => evaluate(row, ref, detail, at));
      }
      await queue;
      requestBaseResolutions(at);
    },
  };
}

/** Lo que un PR abierto dice hoy; uno mergeado solo dice que se mergeó. */
function factsOf(state: PrState): PrEventInput[] {
  if (state.state === "merged") {
    return [{ type: "pr.merged", keys: [state.key], payload: () => ({ sha: state.mergeCommitSha, headRef: state.headRef, baseRef: state.baseRef }) }];
  }
  if (state.state === "closed") return [];

  const facts: PrEventInput[] = [];
  const { bot, ci, threads, talk } = state;
  if (bot.state !== "none" && bot.reviewId !== undefined) {
    facts.push({
      type: "pr.botReview",
      keys: [`${bot.sha ?? "-"}:${bot.reviewId}`],
      payload: () => ({ state: bot.state, sha: bot.sha, reviewId: bot.reviewId }),
    });
  }
  if (ci.state === "green" || ci.state === "red") {
    facts.push({ type: "pr.ci", keys: [`${ci.sha}:${ci.state}`], payload: () => ({ state: ci.state, sha: ci.sha, failing: ci.failing }) });
  }
  if (state.mergeable === "conflict") {
    facts.push({ type: "pr.conflict", keys: [state.headSha], emitOnFirstRead: true, payload: () => ({ sha: state.headSha, base: state.baseRef }) });
  }
  if (threads.councilOpen.length > 0) {
    facts.push({ type: "pr.comment", keys: threads.councilOpen.map(String), emitOnFirstRead: true, payload: (fresh) => ({ threadIds: fresh.map(Number), base: state.baseRef }) });
  }
  const talkKey = ({ author, at }: PrState["talk"][number]) => `${author}@${at}`;
  if (talk.length > 0) {
    facts.push({
      type: "pr.human",
      keys: talk.map(talkKey),
      payload: (fresh) => ({ talk: talk.filter((t) => fresh.includes(talkKey(t))) }),
    });
  }
  facts.push(...mergeFactsOf(state));
  return facts;
}

/**
 * Los hechos de la estrategia de merge, una vez por head (el `sha` de la marca: un "todavía no" no se vuelve
 * a preguntar hasta que haya un sha nuevo).
 * `pr.mergeReady` lleva el nivel que se cumple (`auto` o `offer`) y `pr.mergeFailed` avisa que la cola
 * (merge-queue) falló después del comando de merge, en un PR fuera de draft. Los dos salen también en la primera
 * lectura: un PR que ya estaba listo se ofrece igual.
 */
export function mergeFactsOf({ merge, headSha, state }: PrState): PrEventInput[] {
  const facts: PrEventInput[] = [];
  if (merge.offer) {
    facts.push({ type: "pr.mergeReady", keys: [headSha], emitOnFirstRead: true, payload: () => ({ sha: headSha, level: merge.auto ? "auto" : "offer" }) });
  }
  if (merge.queue === "failed" && state === "open") {
    facts.push({ type: "pr.mergeFailed", keys: [headSha], emitOnFirstRead: true, payload: () => ({ sha: headSha }) });
  }
  return facts;
}

/** Aprobado: la decisión de GitHub y al menos un aprobador humano (la aprobación de un bot no cuenta). */
const isApproved = ({ reviewDecision, approvers }: PrState) => reviewDecision === "approved" && approvers.length > 0;

/**
 * Un PR que se aprueba con humanos que hablaron (reviews con texto, comentarios, threads sin resolver) lo
 * anuncia una vez por aprobación (`epoch`, ver `approvalEpoch`), también en la primera lectura: lo dicho
 * sigue sin atender. Solo para PRs abiertos: en draft no hay aprobación que contar.
 */
function approvalFacts(state: PrState, epoch: number): PrEventInput[] {
  if (!isApproved(state) || state.talk.length === 0) return [];
  const authors = [...new Set(state.talk.map((t) => t.author))].sort();
  return [
    {
      type: "pr.approvedWithComments",
      keys: [String(epoch)],
      emitOnFirstRead: true,
      payload: () => ({ approvers: state.approvers, authors, comments: state.talk.length }),
    },
  ];
}

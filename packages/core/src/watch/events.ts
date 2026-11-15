import type { PrRef, PrState } from "@clanker/api";
import { and, eq, isNotNull } from "drizzle-orm";
import { isAncestor, tryGit } from "../git/git";
import type { PrRow } from "../github/pr-cache";
import { pullRequests } from "../store/schema";
import type { Store } from "../store/store";
import type { Repos } from "../workspaces/repos";
import type { Workspaces } from "../workspaces/workspaces";
import { emitOnce, lastEvaluatedHead, markHead, recordMarks, type PrEventInput } from "./marks";
import type { ErrorReporter } from "./report";

// Los eventos de Watch (`docs/design.html#d-ops`, "Watch: eventos y qué disparan"): de lo que cambió en un
// PR salen los hechos nuevos, cada uno una sola vez por su clave en `watch_marks`.

/** Varios pushes seguidos (fixups de council, restack de una cadena) dan un solo evento por sha final. */
export const DEBOUNCE_MS = 20_000;

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
  async function wasRewritten(repoId: string, from: string, to: string): Promise<boolean> {
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
    if (live && from !== undefined && (await wasRewritten(row.repoId, from, state.headSha))) {
      facts.push({ type: "pr.base_rewritten", keys: [`${from}>${state.headSha}`], payload: () => ({ from, to: state.headSha }) });
    }
    store.tx((tx) => {
      for (const fact of facts) {
        const input = { ...fact, payload: (fresh: string[]) => ({ repo: ref.repo, number: ref.number, ...fact.payload(fresh) }) };
        // La primera vez que se ve un PR solo se siembra: lo que ya estaba ahí no es un cambio.
        if (known === undefined && !fact.emitOnFirstRead) recordMarks(tx, row.id, fact.type, fact.keys, at);
        else emitOnce(tx, row, input, at);
      }
      markHead(tx, row.id, state.headSha, at);
    });
  }

  return {
    observe(ref, state, row) {
      enqueue(`events ${ref.repo}#${ref.number}`, () => evaluate(row, ref, state, now()));
    },

    async flush(at = now()) {
      await queue;
      const rows = store.db
        .select()
        .from(pullRequests)
        .where(and(eq(pullRequests.state, "open"), isNotNull(pullRequests.detail)))
        .all();
      for (const row of rows) {
        const { detail } = row;
        const remote = repos.get(row.repoId) && repos.config(row.repoId).remote;
        if (!detail || !remote || lastEvaluatedHead(store.db, row.id) === detail.headSha) continue;
        const ref = { account: remote.account, repo: remote.repo, number: row.number };
        enqueue(`events ${ref.repo}#${ref.number}`, () => evaluate(row, ref, detail, at));
      }
      await queue;
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
    facts.push({ type: "pr.conflict", keys: [state.headSha], payload: () => ({ sha: state.headSha, base: state.baseRef }) });
  }
  if (threads.councilOpen.length > 0) {
    facts.push({ type: "pr.comment", keys: threads.councilOpen.map(String), payload: (fresh) => ({ threadIds: fresh.map(Number), base: state.baseRef }) });
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
 * Los hechos de la estrategia de merge, una vez por head (el `sha` de la marca, como el `offered` y el
 * `queuefail` del vigilante: un "todavía no" no se vuelve a preguntar hasta que haya un sha nuevo).
 * `pr.mergeReady` lleva el nivel que se cumple (`auto` o `offer`) y `pr.mergeFailed` avisa que la cola
 * (merge-queue) falló después del comando de merge, en un PR fuera de draft. Los dos salen también en la primera
 * lectura: el `$first` del vigilante solo calla los comentarios, y un PR que ya estaba listo se ofrece.
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

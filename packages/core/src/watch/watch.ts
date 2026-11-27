import type { PrRef, RepoId } from "@clanker/api";
import { RequestError } from "@octokit/request-error";
import { eq } from "drizzle-orm";
import type { Connections } from "../connections/connections";
import { expireMergedReviewNotes } from "../decisions/decisions";
import type { GitRemote } from "../git/remote";
import { isUnauthorized } from "../github/client";
import { RestPull, type PrCache, type PrRow } from "../github/pr-cache";
import { prOfWaitKey } from "../github/pr-waits";
import { syncCursors } from "../store/schema";
import type { Store } from "../store/store";
import type { Repos } from "../repos/repos";
import type { PrEvents } from "./events";
import { throttleOf, type Throttle } from "./quota";
import type { ErrorReporter } from "../errors/reporter";
import type { TrackerChanges } from "./tracker-changes";

// Watch: detecta qué PRs cambiaron sin gastar cuota (`docs/design.html#d-ops`, "CodeHost: polling con ETags").
// REST condicional (un 304 no cuenta) dice que algo cambió; solo entonces se lee el detalle por GraphQL
// (`prs.refresh`), que deja el estado en `pull_requests` y avisa a los waits. Es código puro: sin slot, sin
// agente, siempre encendido, y todo sale en serie por el cliente de GitHub de la cuenta. De lo que
// cambia sale lo demás: `prs.refresh` avisa al caché, y de ahí a los eventos (`events.ts`) y los triggers.

/** Cada cuánto despierta; lo que toca hacer en cada despertar lo deciden los intervalos de abajo. */
export const WATCH_TICK_MS = 2000;
/** Un `git ls-remote` por repo: baratos (no gastan cuota de API) y dicen si un head se movió antes del próximo sondeo. */
const LS_REMOTE_EVERY_MS = 60_000;
const SEARCH_EVERY_MS = 5 * 60_000;
/** Un PR es caliente si un flujo espera algo de él o se pusheó hace menos de esto. */
const HOT_MS = 15 * 60_000;
/** Caliente, en review (fuera de draft) y frío (draft sin nada esperando). */
const POLL_EVERY_MS = { hot: 30_000, review: 120_000, cold: 300_000 };
/** Mientras hay checks pendientes. */
const CI_EVERY_MS = 30_000;
/** `mergeable` en UNKNOWN: GitHub lo calcula aparte, se relee a los 10 s hasta 3 veces. */
const UNKNOWN_REREAD_MS = 10_000;
const UNKNOWN_REREADS = 3;
/** Bajo 25% de cuota los intervalos se duplican. */
const SLOW_FACTOR = 2;

export interface Watch {
  /** Un despertar: mira lo que ya toca, en serie. Nunca lanza; lo que falla de un PR se anota y el siguiente sigue. */
  tick(): Promise<void>;
  /** Despierta cada `WATCH_TICK_MS`. */
  start(): void;
  /**
   * Deja de despertar y espera a que termine lo que está en vuelo: la visita en curso y los eventos que ya
   * salieron de ella, no el resto de las visitas del despertar (con muchos PRs vencidos serían minutos).
   */
  stop(): Promise<void>;
}

export interface WatchDeps {
  store: Store;
  connections: Pick<Connections, "githubClient" | "list">;
  repos: Pick<Repos, "get" | "list" | "byRemote" | "config">;
  cache: PrCache;
  remote: Pick<GitRemote, "lsRemote">;
  /** `Engine.waitKeys`: los PRs con un wait esperando son los que Watch no suelta. */
  waitKeys: () => string[];
  /** Los eventos de los PRs: Watch les da el tiempo (el debounce de las puntas nuevas). */
  events: Pick<PrEvents, "flush">;
  errors: ErrorReporter;
  /** Los cambios de los trackers (Linear) que despiertan al Scheduler. Sin él Watch solo mira PRs. */
  trackers?: TrackerChanges;
  syncInbox?: (account: string) => Promise<void>;
  incoming?: (account: string, at: number, attempt: (scope: string, work: () => Promise<void>) => Promise<void>, stopping: () => boolean) => Promise<void>;
  now?: () => number;
}

/** Un PR que Watch mira: de qué cuenta, en qué repo del core y si algún flujo lo espera. */
interface Target {
  ref: PrRef;
  repoId: RepoId;
  waited: boolean;
  /** `undefined` si el caché aún no lo conoce (un wait sobre un PR que Watch no vio todavía). */
  row: PrRow | undefined;
}

const keyOf = ({ repo, number }: { repo: string; number: number }) => `${repo}#${number}`;

export function createWatch({ store, connections, repos, cache, remote, waitKeys, events, errors, trackers, incoming, syncInbox, now = Date.now }: WatchDeps): Watch {
  // El calendario vive en memoria: tras un reinicio todo toca ya, y los ETags guardados hacen que sea casi gratis.
  const lastVisit = new Map<string, number>();
  const lastLsRemote = new Map<string, number>();
  const lastSearch = new Map<string, number>();
  /** PRs cuyo head se movió según `git ls-remote`: se miran en el próximo despertar sin esperar su intervalo. */
  const headMoved = new Set<string>();
  /** Cuántas relecturas por `mergeable: unknown` le quedan a cada PR; sin entrada, no hay ninguna pendiente. */
  const rereadsLeft = new Map<string, number>();
  let timer: NodeJS.Timeout | undefined;
  let running: Promise<void> | undefined;
  let stopping = false;
  const lastInbox = new Map<string, number>();

  // --- qué mirar ---

  function targets(): Target[] {
    const waited = new Set(waitKeys().flatMap((key) => prOfWaitKey(key) ?? []).map(keyOf));
    const found = new Map<string, Target>();
    const add = (repoId: RepoId, number: number, row: PrRow | undefined) => {
      const remoteOf = repos.get(repoId) && repos.config(repoId).remote;
      if (!remoteOf) return;
      const ref = { account: remoteOf.account, repo: remoteOf.repo, number };
      found.set(keyOf(ref), { ref, repoId, waited: waited.has(keyOf(ref)), row });
    };
    for (const row of cache.open()) add(row.repoId, row.number, row);
    for (const key of waited) {
      if (found.has(key)) continue;
      const [repo, number] = key.split("#") as [string, string];
      const registered = repos.byRemote(repo);
      if (registered) add(registered.id, Number(number), cache.row(registered.id, Number(number)));
    }
    return [...found.values()];
  }

  const isHot = (t: Target, at: number) => t.waited || (t.row?.headChangedAt != null && at - t.row.headChangedAt < HOT_MS);

  /**
   * Checks pendientes, un merge en cola (merge-queue cambia su status sin mover el PR) o todavía sin registrarse en
   * un PR caliente: se piden check-runs y status con ETag.
   */
  function watchesCi(t: Target, at: number): boolean {
    const detail = t.row?.detail;
    return detail?.ci.state === "pending" || detail?.merge.queue === "queued" || (detail?.ci.state === "none" && isHot(t, at));
  }

  function pollEveryMs(t: Target, at: number): number {
    const temperature = isHot(t, at) ? "hot" : t.row?.isDraft === false ? "review" : "cold";
    return watchesCi(t, at) ? Math.min(CI_EVERY_MS, POLL_EVERY_MS[temperature]) : POLL_EVERY_MS[temperature];
  }

  const rereadPending = (key: string) => (rereadsLeft.get(key) ?? 0) > 0;

  function isDue(t: Target, at: number, throttle: Throttle): boolean {
    const key = keyOf(t.ref);
    if (headMoved.has(key)) return true;
    const every = rereadPending(key) ? UNKNOWN_REREAD_MS : pollEveryMs(t, at) * (throttle.level === "normal" ? 1 : SLOW_FACTOR);
    return at - (lastVisit.get(key) ?? Number.NEGATIVE_INFINITY) >= every;
  }

  // --- requests condicionales ---

  const etagKey = (account: string, path: string) => `etag:github:${account}:${path}`;

  /**
   * GET con el ETag que guardamos. `undefined` si GitHub respondió 304 (no gasta cuota); si no, el body y
   * un `commit` que guarda el ETag nuevo. Quien llama lo ejecuta solo cuando ya actuó sobre el cambio:
   * un ETag guardado antes de leer el detalle perdería el cambio si esa lectura falla.
   */
  async function conditionalGet(
    account: string,
    path: string,
    params: Record<string, unknown> = {},
  ): Promise<{ data: unknown; commit: () => void } | undefined> {
    const key = etagKey(account, path);
    const etag = store.db.select({ etag: syncCursors.etag }).from(syncCursors).where(eq(syncCursors.key, key)).get()?.etag;
    try {
      const response = await connections.githubClient(account).request({
        method: "GET",
        url: path,
        ...params,
        headers: etag ? { "if-none-match": etag } : {},
      });
      const fresh = response.headers.etag;
      return { data: response.data, commit: () => fresh && saveEtag(key, fresh) };
    } catch (error) {
      if (error instanceof RequestError && error.status === 304) return undefined;
      throw error;
    }
  }

  function saveEtag(key: string, etag: string) {
    const values = { etag, checkedAt: now() };
    store.tx((tx) => tx.db.insert(syncCursors).values({ key, ...values }).onConflictDoUpdate({ target: syncCursors.key, set: values }).run());
  }

  function forgetEtags(account: string, paths: string[]) {
    store.tx((tx) => {
      for (const path of paths) tx.db.delete(syncCursors).where(eq(syncCursors.key, etagKey(account, path))).run();
    });
  }

  const pullPath = ({ repo, number }: PrRef) => `/repos/${repo}/pulls/${number}`;
  const ciPaths = ({ repo }: PrRef, sha: string) => [`/repos/${repo}/commits/${sha}/check-runs`, `/repos/${repo}/commits/${sha}/status`];

  // --- una visita a un PR ---

  /**
   * Mira un PR: su detector REST y, mientras haya checks pendientes, los de CI. El detalle de GraphQL se
   * pide solo si algo cambió (o nunca se leyó, o `mergeable` sigue en UNKNOWN).
   */
  async function visit(t: Target, at: number): Promise<void> {
    const { ref } = t;
    const key = keyOf(ref);
    lastVisit.set(key, at);
    headMoved.delete(key);
    const commits: (() => void)[] = [];
    let row = t.row;
    let needDetail = row?.detail == null || rereadPending(key);

    const pull = await conditionalGet(ref.account, pullPath(ref));
    if (pull) {
      const previousSha = row?.headSha;
      row = cache.saveRest(t.repoId, RestPull.parse(pull.data), at);
      if (previousSha !== undefined && previousSha !== row.headSha) {
        forgetEtags(ref.account, ciPaths(ref, previousSha));
        rereadsLeft.delete(key);
      }
      commits.push(pull.commit);
      needDetail = true;
    }
    if (row && (needDetail || watchesCi({ ...t, row }, at))) {
      for (const path of ciPaths(ref, row.headSha)) {
        const checks = await conditionalGet(ref.account, path);
        if (!checks) continue;
        commits.push(checks.commit);
        needDetail = true;
      }
    }
    if (!needDetail) return;

    const state = await cache.refresh(ref);
    for (const commit of commits) commit();
    if (state.mergeable === "unknown" && (state.state === "open" || state.state === "draft")) {
      const left = rereadsLeft.get(key);
      rereadsLeft.set(key, left === undefined ? UNKNOWN_REREADS : left - 1);
    } else {
      rereadsLeft.delete(key);
    }
    if (state.state === "merged" || state.state === "closed") {
      forgetEtags(ref.account, [pullPath(ref), ...ciPaths(ref, state.headSha)]);
      lastVisit.delete(key);
    }
  }

  // --- el despertar ---

  /** `git ls-remote` de cada repo con PRs vigilados: un head que se movió se mira ya, sin esperar su intervalo. */
  async function listRemotes(all: Target[], at: number): Promise<void> {
    for (const repoId of new Set(all.map((t) => t.repoId))) {
      if (at - (lastLsRemote.get(repoId) ?? Number.NEGATIVE_INFINITY) < LS_REMOTE_EVERY_MS) continue;
      lastLsRemote.set(repoId, at);
      const config = repos.config(repoId);
      if (!config.remote) continue;
      const { url, repo, account } = config.remote;
      try {
        const heads = await remote.lsRemote({ cwd: config.path, url, account });
        if (heads === "unauthorized") continue;
        const cursor = JSON.stringify(heads);
        const values = { cursor, checkedAt: at };
        store.tx((tx) => tx.db.insert(syncCursors).values({ key: `refs:${repo}`, ...values }).onConflictDoUpdate({ target: syncCursors.key, set: values }).run());
        for (const t of all) {
          const tip = t.row && t.repoId === repoId ? heads[t.row.headRef] : undefined;
          if (tip !== undefined && tip !== t.row?.headSha) headMoved.add(keyOf(t.ref));
        }
      } catch (error) {
        errors.report(`ls-remote ${repo}`, error);
      }
    }
  }

  /**
   * Tus PRs abiertos que el core no vigila: los que no conoce entran al caché con su primera visita, y uno que el caché
   * tiene cerrado pero GitHub devuelve abierto (se reabrió) se relee por REST y vuelve a `open`, que es lo único que Watch mira.
   */
  async function discover(account: string, at: number): Promise<Target[]> {
    lastSearch.set(account, at);
    const found = await conditionalGet(account, "/search/issues", { q: "is:pr author:@me is:open", per_page: 100 });
    if (!found) return [];
    found.commit();
    const items = (found.data as { items?: { number: number; repository_url: string }[] }).items ?? [];
    return items.flatMap(({ number, repository_url }) => {
      const repo = repository_url.split("/repos/")[1];
      const registered = repo ? repos.byRemote(repo) : undefined;
      if (!repo || !registered) return [];
      const row = cache.row(registered.id, number);
      if (row && row.state !== "closed") return [];
      return [{ ref: { account, repo, number }, repoId: registered.id, waited: false, row }];
    });
  }

  /** Un trabajo que falla no tumba el despertar: un 401 ya dejó la conexión revocada (el cliente) y lo demás se anota una vez. */
  async function attempt(scope: string, work: () => Promise<void>) {
    try {
      await work();
      errors.clear(scope);
    } catch (error) {
      if (!isUnauthorized(error)) errors.report(scope, error);
    }
  }

  async function wake(): Promise<void> {
    const at = now();
    const active = new Set(
      connections
        .list()
        .filter((c) => c.provider === "github" && c.status === "active")
        .map((c) => c.account),
    );
    const all = targets().filter((t) => active.has(t.ref.account));
    await listRemotes(all, at);

    const throttles = new Map<string, Throttle>();
    const throttle = (account: string) => {
      let found = throttles.get(account);
      if (!found) throttles.set(account, (found = throttleOf(store, account, at)));
      return found;
    };
    // Los que un flujo espera van primero; entre iguales, el que lleva más sin mirarse.
    const due = all
      .filter((t) => {
        const brake = throttle(t.ref.account);
        return brake.level !== "exhausted" && (brake.level !== "waits-only" || t.waited) && isDue(t, at, brake);
      })
      .sort((a, b) => Number(b.waited) - Number(a.waited) || (lastVisit.get(keyOf(a.ref)) ?? 0) - (lastVisit.get(keyOf(b.ref)) ?? 0));
    for (const t of due) {
      if (stopping) break;
      await attempt(keyOf(t.ref), () => visit(t, at));
    }

    // Descubrir PRs no depende de que ya haya alguno vigilado: la búsqueda corre por cada cuenta con repos registrados.
    const accounts = repos.list().flatMap(({ id }) => repos.config(id).remote?.account ?? []);
    for (const account of new Set(accounts.filter((a) => active.has(a)))) {
      const { level } = throttle(account);
      const every = level === "normal" ? SEARCH_EVERY_MS : SEARCH_EVERY_MS * SLOW_FACTOR;
      if (stopping || level === "waits-only" || level === "exhausted" || at - (lastSearch.get(account) ?? Number.NEGATIVE_INFINITY) < every) continue;
      await attempt(`${account} search`, async () => {
        for (const t of await discover(account, at)) {
          if (stopping) break;
          await attempt(keyOf(t.ref), () => visit(t, at));
        }
      });
      if (!stopping && incoming) await attempt(`${account} review requests`, () => incoming(account, at, attempt, () => stopping));
    }

    // Después de las visitas, que son las que se enteran de un merge; también cae lo que ya llegó mergeado (la importación del loop).
    for (const account of active) {
      const { level } = throttle(account);
      if (stopping || !syncInbox || level === "exhausted" || level === "waits-only") continue;
      const interval = SEARCH_EVERY_MS * (level === "slow" ? SLOW_FACTOR : 1);
      if (at - (lastInbox.get(account) ?? -Infinity) < interval) continue;
      lastInbox.set(account, at);
      await attempt(`${account} review inbox`, () => syncInbox(account));
    }
    expireMergedReviewNotes(store);
    await events.flush(at);
    if (!stopping) await trackers?.poll(at);
  }

  /** Un despertar a la vez: si el anterior sigue en vuelo, este no hace nada. */
  function tick(): Promise<void> {
    running ??= wake()
      .catch((error: unknown) => errors.report("tick", error))
      .finally(() => {
        running = undefined;
      });
    return running;
  }

  return {
    tick,

    start() {
      stopping = false;
      timer ??= setInterval(() => void tick(), WATCH_TICK_MS).unref();
    },

    async stop() {
      stopping = true;
      clearInterval(timer);
      timer = undefined;
      await running;
    },
  };
}

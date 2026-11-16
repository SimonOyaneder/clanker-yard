import type { CachedPr, PrFilter, PrRef, PrState } from "@clanker/api";
import { and, asc, eq } from "drizzle-orm";
import * as z from "zod";
import { newId } from "../store/conventions";
import type { Packs } from "../packs/packs";
import { prParents, pullRequests } from "../store/schema";
import type { Store } from "../store/store";
import type { Repos } from "../repos/repos";
import type { Prs } from "./prs";

/** Lo que Watch lee de un PR de la API REST (`GET /repos/{owner}/{repo}/pulls/{n}`). */
export const RestPull = z.object({
  number: z.int().positive(),
  node_id: z.string(),
  state: z.enum(["open", "closed"]),
  draft: z.boolean(),
  merged: z.boolean(),
  head: z.object({ ref: z.string(), sha: z.string() }),
  base: z.object({ ref: z.string() }),
});
export type RestPull = z.infer<typeof RestPull>;

export type PrRow = typeof pullRequests.$inferSelect;

/**
 * El caché de `pull_requests`: lo último que se vio de cada PR. Lo escriben `pr.publish`, Watch (al ver
 * el PR por REST) y `refresh` (al leer su detalle); lo leen Watch, para decidir qué toca mirar, y
 * `prs.list`.
 */
export interface PrCache {
  /**
   * Los PRs del caché, sin ir a GitHub: los que abrió el sistema y los que descubrió Watch. Omite los
   * de repos sin remoto de GitHub con una cuenta conectada (`RepoConfig.remote`): sin cuenta no hay `PrRef`.
   */
  list(filter?: PrFilter): CachedPr[];
  /**
   * `prs.get` y además deja el estado en el caché. Si cambió respecto de lo que había, llama a
   * `onChange`. Un PR que el caché no conoce (el repo no está registrado, o Watch aún no lo vio por
   * REST) se lee igual pero no entra al caché.
   */
  refresh(ref: PrRef): Promise<PrState>;
  row(repoId: string, number: number): PrRow | undefined;
  /**
   * Marca o desmarca "no mergear nunca" (`pull_requests.hold`) y relee el PR con `refresh`, así su `merge`
   * (y el evento `pr.mergeReady` si vuelve a estar listo) ya cuenta con el cambio. Lanza si el core no
   * conoce el PR: solo se puede poner hold a los que Watch o `pr.publish` ya registraron.
   */
  setHold(ref: PrRef, hold: boolean): Promise<PrState>;
  /** Los que siguen abiertos (o en draft): lo que Watch vigila. */
  open(): PrRow[];
  /**
   * Deja lo que dice la REST: crea la fila si no estaba (un PR que el sistema no abrió) y, si el head se
   * movió, anota cuándo. Devuelve la fila ya al día.
   */
  saveRest(repoId: string, pull: RestPull, at?: number): PrRow;
}

export interface PrCacheDeps {
  store: Store;
  repos: Pick<Repos, "get" | "byRemote" | "config">;
  /** De ahí salen las señales de cada PR (`CachedPr.signals`): las del pack de la org de su repo. */
  packs: Pick<Packs, "packFor">;
  prs: Pick<Prs, "get">;
  /** Con el estado nuevo de un PR, y su fila ya al día, cuando lo leído difiere de lo guardado (a los waits: `signalPr`; a los eventos de Watch). */
  onChange?: (ref: PrRef, state: PrState, row: PrRow) => void;
  now?: () => number;
}

/** `state` de la fila para un PR leído por REST: GitHub no distingue mergeado de cerrado, `merged` sí. */
const restState = ({ state, merged }: RestPull): PrRow["state"] => (merged ? "merged" : state);

export function createPrCache({ store, repos, packs, prs, onChange, now = Date.now }: PrCacheDeps): PrCache {
  const find = (repoId: string, number: number) =>
    store.db
      .select()
      .from(pullRequests)
      .where(and(eq(pullRequests.repoId, repoId), eq(pullRequests.number, number)))
      .get();

  /** Guarda el `PrState` leído de GraphQL. Devuelve el anterior (`null` si nunca se había leído) y la fila ya al día, o `undefined` si el PR no está. */
  function saveDetail(repoId: string, number: number, state: PrState): { previous: PrState | null; row: PrRow } | undefined {
    return store.tx(({ db, emit }) => {
      const current = find(repoId, number);
      if (!current) return undefined;
      // Lo que la UI sigue en vivo: cualquier cambio de lo que `prs.list` sirve.
      if (JSON.stringify(current.detail) !== JSON.stringify(state)) {
        emit({ type: "pr.changed", origin: "core", subject: { type: "pr", id: current.id }, payload: { key: state.key } });
      }
      db.update(pullRequests)
        .set({
          detail: state,
          detailAt: now(),
          headRef: state.headRef,
          baseRef: state.baseRef,
          headSha: state.headSha,
          state: state.state === "draft" ? "open" : state.state,
          isDraft: state.state === "draft",
          ...(current.headSha !== state.headSha && { headChangedAt: now() }),
        })
        .where(eq(pullRequests.id, current.id))
        .run();
      return { previous: current.detail, row: find(repoId, number)! };
    });
  }

  async function refresh(ref: PrRef): Promise<PrState> {
    const state = await prs.get(ref);
    const repo = repos.byRemote(ref.repo);
    const saved = repo && saveDetail(repo.id, ref.number, state);
    if (saved && JSON.stringify(saved.previous) !== JSON.stringify(state)) onChange?.(ref, state, saved.row);
    return state;
  }

  return {
    refresh,

    list({ repo, owned, state } = {}) {
      const rows = store.db
        .select()
        .from(pullRequests)
        .where(and(owned === undefined ? undefined : eq(pullRequests.owned, owned), state === undefined ? undefined : eq(pullRequests.state, state)))
        .orderBy(asc(pullRequests.repoId), asc(pullRequests.number))
        .all();
      const parents = new Map<string, string[]>();
      for (const { childId, parentId } of store.db.select().from(prParents).orderBy(asc(prParents.parentId)).all()) {
        parents.set(childId, [...(parents.get(childId) ?? []), parentId]);
      }
      return rows.flatMap((row) => {
        const found = repos.get(row.repoId);
        const remote = found && repos.config(row.repoId).remote;
        if (!remote || (repo !== undefined && remote.repo !== repo)) return [];
        const pack = packs.packFor({ githubOrg: remote.repo.split("/")[0]! });
        return [
          {
            id: row.id,
            ref: { account: remote.account, repo: remote.repo, number: row.number },
            owned: row.owned,
            issueId: row.issueId,
            runId: row.runId,
            parents: parents.get(row.id) ?? [],
            signals: pack.signals.map(({ id, match, flags, empty, levels }) => ({ id, match, ...(flags !== undefined && { flags }), ...(empty !== undefined && { empty }), levels })),
            reviewBot: pack.reviewBot !== undefined,
            state: row.detail,
            readAt: row.detailAt,
          },
        ];
      });
    },

    row: find,

    async setHold(ref, hold) {
      const repo = repos.byRemote(ref.repo);
      const row = repo && find(repo.id, ref.number);
      if (!row) throw new Error(`El core no conoce el PR ${ref.repo}#${ref.number}: registra el repo y espera a que Watch lo vea.`);
      store.tx((tx) => tx.db.update(pullRequests).set({ hold }).where(eq(pullRequests.id, row.id)).run());
      return refresh(ref);
    },

    open: () => store.db.select().from(pullRequests).where(eq(pullRequests.state, "open")).all(),

    saveRest(repoId, pull, at = now()) {
      return store.tx(({ db }) => {
        const current = find(repoId, pull.number);
        const fields = {
          headRef: pull.head.ref,
          baseRef: pull.base.ref,
          headSha: pull.head.sha,
          state: restState(pull),
          isDraft: pull.draft,
        };
        if (!current) {
          db.insert(pullRequests)
            .values({ id: newId("pr"), repoId, number: pull.number, nodeId: pull.node_id, ...fields, headChangedAt: at })
            .run();
        } else {
          db.update(pullRequests)
            .set({ ...fields, ...(current.headSha !== pull.head.sha && { headChangedAt: at }) })
            .where(eq(pullRequests.id, current.id))
            .run();
        }
        return find(repoId, pull.number)!;
      });
    },
  };
}

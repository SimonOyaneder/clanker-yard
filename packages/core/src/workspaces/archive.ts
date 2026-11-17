import type { RepoId } from "@clanker/api";
import { existsSync } from "node:fs";
import { and, eq, isNotNull, isNull, lte } from "drizzle-orm";
import { git, isAncestor, tryGit } from "../git/git";
import { workspaces } from "../store/schema";
import type { Store } from "../store/store";
import { rebaseInProgress } from "./rebase";
import type { RepoConfig } from "../repos/repos";
import { prsOfBranch } from "../github/pr-rows";

/** Cuánto vive un worktree archivado antes de borrarse (`docs/design.html#d-ops`, estados del worktree). */
export const ARCHIVE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

const REMOTE = "origin";
const WORKTREE_LOCK_REASON = "clanker-yard";

type Row = typeof workspaces.$inferSelect;

export interface CleanupResult {
  /** `idle` que pasaron a `archived` porque su PR se mergeó o cerró. */
  archived: number;
  /** `archived` que volvieron a `idle` porque su PR se reabrió. */
  reopened: number;
  /** Archivados vencidos que se borraron: worktree, branch local y fila. */
  removed: number;
  /** Archivados vencidos que se conservan porque les queda algo sin pushear. */
  kept: number;
}

export interface ArchiveDeps {
  store: Store;
  repoConfig: (repoId: RepoId) => RepoConfig;
  now: () => number;
  /** El mutex del repo: `worktree remove` toca refs compartidas. */
  withRepoLock: <T>(repoId: RepoId, fn: () => Promise<T>) => Promise<T>;
}

/**
 * El ciclo de vida de un worktree cuyo PR terminó. Solo toca filas `idle` y `archived` sin dueña: lo que
 * una corrida tiene (también estacionada) nunca se archiva ni se borra; cuando lo suelte, la próxima
 * pasada lo archiva.
 */
export function createArchive({ store, repoConfig, now, withRepoLock }: ArchiveDeps) {
  const pullsOf = (db: Store["db"], { repoId, branch }: Row) => prsOfBranch(db, repoId, branch);

  /** Un PR abierto (o local, que aún no se publica) manda: si hay uno, el worktree sigue vivo aunque otro PR de la misma branch se haya cerrado. */
  const hasOpenPull = (pulls: { state: string }[]) => pulls.some((p) => p.state === "open" || p.state === "local");

  /** `idle` <-> `archived` según el estado de los PRs de su branch. Una sola transacción: nadie lo toma a la mitad. */
  function reconcile(): Pick<CleanupResult, "archived" | "reopened"> {
    return store.tx(({ db }) => {
      let archived = 0;
      let reopened = 0;
      const free = isNull(workspaces.holderRunId);
      for (const row of db.select().from(workspaces).where(and(eq(workspaces.state, "idle"), free)).all()) {
        const pulls = pullsOf(db, row);
        if (pulls.length === 0 || hasOpenPull(pulls)) continue;
        db.update(workspaces).set({ state: "archived", archivedAt: now() }).where(eq(workspaces.id, row.id)).run();
        archived++;
      }
      for (const row of db.select().from(workspaces).where(and(eq(workspaces.state, "archived"), free)).all()) {
        if (!hasOpenPull(pullsOf(db, row))) continue;
        db.update(workspaces).set({ state: "idle", archivedAt: null }).where(eq(workspaces.id, row.id)).run();
        reopened++;
      }
      return { archived, reopened };
    });
  }

  /**
   * Por qué no se puede borrar el worktree sin perder trabajo; `undefined` si todo está en el remoto. Sin la
   * carpeta (la borraron a mano) lo que queda es la branch local, que `branch -D` se llevaría: se revisa su punta.
   */
  async function unpushedWork(row: Row, cfg: RepoConfig, present: boolean): Promise<string | undefined> {
    const tip = await tryGit(cfg.path, ["rev-parse", "--verify", "--quiet", `refs/heads/${row.branch}`]);
    let head = tip;
    if (present) {
      const inWorktree = (...args: string[]) => git(row.path, args);
      if (await rebaseInProgress(inWorktree)) return "tiene un rebase en curso";
      if ((await inWorktree("status", "--porcelain")) !== "") return "tiene cambios sin commitear";
      head = await inWorktree("rev-parse", "HEAD");
      if (tip !== undefined && tip !== head) return "su HEAD no es la punta de la branch";
    }
    if (head === undefined) return undefined;
    // Lo que GitHub ya tiene: lo último que pusheó el core, la punta de su PR (con squash la branch remota puede
    // haberse borrado) y `origin/<branch>`. Que HEAD sea ancestro de cualquiera basta; un commit de más, no.
    const remoteTip = await tryGit(cfg.path, ["rev-parse", "--verify", "--quiet", `refs/remotes/${REMOTE}/${row.branch}`]);
    const pushed = [row.remoteSha, remoteTip, ...pullsOf(store.db, row).map((p) => p.headSha)];
    for (const sha of pushed) if (sha && (await isAncestor(cfg.path, head, sha))) return undefined;
    return "tiene commits sin pushear";
  }

  /**
   * Borra un archivado vencido. La fila se saca primero, en una transacción que exige que siga archivado y sin
   * dueña con el mismo token: un `acquire` que lo reviva en medio gana, y aquí no se toca nada. Si git falla,
   * la fila vuelve.
   */
  async function remove(row: Row): Promise<"removed" | "kept"> {
    const cfg = repoConfig(row.repoId);
    return withRepoLock(row.repoId, async () => {
      const present = existsSync(row.path);
      if ((await unpushedWork(row, cfg, present)) !== undefined) return "kept";
      const claimed = store.tx(({ db }) => {
        if (hasOpenPull(pullsOf(db, row))) return undefined;
        const mine = and(
          eq(workspaces.id, row.id),
          eq(workspaces.state, "archived"),
          eq(workspaces.fencingToken, row.fencingToken),
          isNull(workspaces.holderRunId),
        );
        return db.delete(workspaces).where(mine).returning().get();
      });
      if (!claimed) return "kept";
      try {
        await tryGit(cfg.path, ["worktree", "unlock", row.path]);
        // Si borraron la carpeta a mano, git sigue teniéndola registrada y `remove` pide `--force`.
        await git(cfg.path, ["worktree", "remove", ...(present ? [] : ["--force"]), row.path]);
      } catch (error) {
        store.tx(({ db }) => db.insert(workspaces).values(claimed).onConflictDoNothing().run());
        await tryGit(cfg.path, ["worktree", "lock", "--reason", WORKTREE_LOCK_REASON, row.path]);
        throw error;
      }
      // La branch la creó el sistema (un `acquire` nuevo rechaza una que ya existía) y ya está en el remoto: dejarla
      // haría que el próximo `acquire` de ese nombre la tomara por una del usuario.
      await tryGit(cfg.path, ["branch", "-D", row.branch]);
      return "removed";
    });
  }

  async function cleanup(): Promise<CleanupResult> {
    const { archived, reopened } = reconcile();
    const expired = store.db
      .select()
      .from(workspaces)
      .where(and(eq(workspaces.state, "archived"), isNull(workspaces.holderRunId), isNotNull(workspaces.archivedAt), lte(workspaces.archivedAt, now() - ARCHIVE_TTL_MS)))
      .all();
    const result: CleanupResult = { archived, reopened, removed: 0, kept: 0 };
    const failures: Error[] = [];
    for (const row of expired) {
      try {
        if ((await remove(row)) === "removed") result.removed++;
        else result.kept++;
      } catch (error) {
        failures.push(error instanceof Error ? error : new Error(String(error)));
      }
    }
    if (failures.length > 0) {
      throw new AggregateError(failures, `No se pudo borrar ${failures.length} worktree(s) archivados: ${failures.map((e) => e.message).join("; ")}`);
    }
    return result;
  }

  return { cleanup };
}

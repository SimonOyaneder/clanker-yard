import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { IssueId, RepoId, type RunId } from "@clanker/api";
import { and, eq, inArray, isNotNull, isNull, lt, ne, or, sql } from "drizzle-orm";
import * as z from "zod";
import { githubUnauthorized } from "../breakers/breakers";
import { type ActionCtx, type ActionDef, PermanentActionError } from "../flows/catalog";
import type { GitIdentity, GitIdentityOf } from "../git/identity";
import { git, GitError, isAncestor, tryGit, USER_REMOTE_ENV } from "../git/git";
import { pickEnv } from "../procs/env";
import type { FetchOutcome, GitRemote, PushOutcome } from "../git/remote";
import { diffBetween, snapshotTree } from "../git/tree";
import { defaultLogDir, excerpt, execLogged, stepLogPath, type ExecResult } from "./exec";
import { createArchive, type CleanupResult } from "./archive";
import { continueRebase, rebaseInProgress, rebaseOnto, startRebase, type RebaseStep } from "./rebase";
import { planCombinedBase, type CombinedParent } from "./combine";
import { planRestack, type Git } from "./restack";
import { newId } from "../store/conventions";
import type { Procs } from "../procs/procs";
import { combinedBases, runs, workspaces } from "../store/schema";
import type { Store, Tx } from "../store/store";
import type { RepoConfig } from "../repos/repos";

const REMOTE = "origin";
const WORKTREE_LOCK_REASON = "clanker-yard";

/** 2 min; el core renueva cada ttl/3. */
export const LEASE_TTL_MS = 120_000;

export interface WorkspacesOptions {
  store: Store;
  /** Directorio de datos de la app (D3): ahí viven `worktrees/<repo>/<branch>`. */
  dataDir: string;
  /** Carpeta de los logs de comandos (`<logDir>/runs/<runId>/<stepId>.log`); por defecto `<dataDir>/logs`. */
  logDir?: string;
  repoConfig: (repoId: RepoId) => RepoConfig;
  /** Autor y committer de todo lo que corre `git` en un worktree: la identidad de git del usuario en ese repo. */
  identityOf: GitIdentityOf;
  /** Quien pushea y fetchea; sin él `push` y `fetch` lanzan. */
  remote?: GitRemote;
  /** Donde se registran los comandos de `exec`, para matar los que deje un crash. */
  procs?: Procs;
  /**
   * Los comandos de `setup.worktree` de la receta que hay en `dir` (el worktree recién creado). Sin
   * esto no se corre ninguno. Un error al leer la receta falla el `acquire`.
   */
  worktreeSetup?: (dir: string) => readonly string[];
  leaseTtlMs?: number;
  now?: () => number;
}

export interface AcquireRequest {
  repo: RepoId;
  /** La branch del workspace; `refs/heads/x` se acepta como `x`. */
  branch: string;
  /** `main`, `origin/main` y `refs/heads/main` son la misma base. */
  base: string;
  runId: RunId;
}

/** Lo que una corrida recibe al tomar el worktree. Toda operación con efecto devuelve el token. */
export interface WorkspaceLease {
  workspaceId: string;
  runId: RunId;
  path: string;
  branch: string;
  baseRef: string;
  baseSha: string;
  fencingToken: number;
  /** Se aborta si el lease se perdió: quien corre en el worktree debe detenerse. */
  lost: AbortSignal;
}

/**
 * Lo mínimo para operar sobre un worktree ya tomado: un `WorkspaceLease`, o lo que de él viaja en el
 * output de `workspace.acquire` (que no lleva `lost`).
 */
export type WorkspaceRef = Pick<WorkspaceLease, "workspaceId" | "path" | "branch" | "fencingToken">;

export interface ExecOptions {
  /** La salida completa va a `logs/runs/<runId>/<stepId>.log`. */
  runId: RunId;
  stepId: string;
  /** Se suma al entorno mínimo del comando (`PATH`, `HOME`, `USER`, `LANG`, `TMPDIR`, `SHELL`). */
  env?: Record<string, string>;
  /** Abortarla mata el grupo de procesos del comando y lanza su razón. */
  signal?: AbortSignal;
}

export interface Workspaces {
  /**
   * Toma el lease del worktree de `branch`, creándolo si no existe. Si otra corrida lo tiene
   * vigente lanza `WorkspaceBusyError`. Renueva el lease cada ttl/3 hasta `release` o hasta perderlo.
   * Un worktree que ya existe se reusa tal cual: `base` solo cuenta al crearlo.
   */
  acquire(request: AcquireRequest): Promise<WorkspaceLease>;
  /**
   * Retoma el PR ya publicado de `branch`: trae el remoto, toma el lease (creando el worktree desde la
   * branch remota si no existe) y avanza la branch local a la punta de `origin/<branch>` con un
   * fast-forward, que pasa a ser el `remote_sha`. Un rebase detenido que dejó otra corrida se aborta antes.
   * Lanza `AttachError` si la branch no está en el remoto o
   * la local tiene commits que el remoto no (adelantada o divergida): sin lease en ese caso.
   */
  attach(request: AcquireRequest): Promise<WorkspaceLease & { fastForwarded: boolean }>;
  /**
   * Al bootear, antes de que Flows reabra los pasos: los worktrees de corridas vivas siguen suyos
   * (lease renovado, mismo token, latido de nuevo), los de corridas ya terminadas se sueltan y los que
   * se quedaron a medio crear pierden su lease para que el paso `workspace.acquire` los tome de nuevo.
   * Devuelve cuántos leases tocó.
   */
  recover(): number;
  /**
   * Renueva ya todos los leases que este core mantiene. Se llama al despertar de un sleep (el reloj
   * saltó), antes de que otra corrida pida una branch cuyo lease venció solo por dormir.
   */
  extendLeases(): void;
  /** Suelta el lease y deja el worktree `idle`. No hace nada si el token ya no es el vigente. */
  release(lease: Pick<WorkspaceLease, "workspaceId" | "runId" | "fencingToken">): void;
  /**
   * Suelta el lease y, si la branch nunca llegó al remoto (sin `remote_sha` ni `origin/<branch>`), borra también el
   * worktree, la branch local y la fila: una corrida que falló antes de publicar no deja nada que bloquee el reintento.
   * Con la branch en el remoto solo suelta el lease. No hace nada si el token ya no es el vigente.
   */
  discard(lease: Pick<WorkspaceLease, "workspaceId" | "runId" | "fencingToken">): Promise<"discarded" | "released">;
  /** El worktree que `runId` tiene tomado: dónde corren sus agentes, su base y lo que hace falta para operar sobre él. */
  held(runId: RunId): (WorkspaceRef & { base: string; repoId: RepoId }) | undefined;
  /**
   * Suelta los worktrees que `runId` aún tiene tomados: lo que queda al terminar una corrida cuyo flujo
   * no los soltó (`@done`, `@failed` o cancelada). Sin worktrees tomados no hace nada (la hija de un
   * subflujo usa el del padre, que es quien lo tiene).
   */
  releaseHeldBy(runId: RunId): void;
  /**
   * Pasa a `to` los worktrees que tiene `from`, dentro de la tx de quien cambia de dueño: el préstamo del
   * sujeto de una corrida de dev estacionada al carril de mantenimiento y su devolución
   * (`docs/design.html#d-flows`). Cada uno sube su `fencing_token` en 1, así que lo que `from` tenía en
   * vuelo ya no valida, y emite `lease.released` y `lease.acquired`. El latido sigue con `to`; si la tx se
   * deshace, esa renovación falla y el latido se apaga solo.
   */
  handOver(tx: Tx, from: RunId, to: RunId): void;
  /**
   * Relee `head_sha` de los worktrees que tiene `runId` desde git: tras una devolución la branch pudo
   * moverse (un rebase). `remote_sha` no se relee: es lo que el core pusheó por última vez, la punta que
   * `--force-with-lease` espera, y adoptar la del remoto dejaría pisar el commit de otra persona. El
   * préstamo ya lo dejó al día con cada `push` de quien lo tuvo. Un rebase que quien lo tuvo dejó detenido
   * (terminó con el conflicto a medias) se aborta antes: la dueña sigue sobre su branch como la prestó.
   */
  reread(runId: RunId): Promise<void>;
  /**
   * Archiva y borra los worktrees de PRs que terminaron (`docs/design.html#d-ops`, estados del worktree).
   * Un `idle` cuyos PRs se mergearon o cerraron (y ninguno sigue abierto) pasa a `archived`; uno `archived`
   * cuyo PR se reabrió vuelve a `idle`. A los 7 días (`ARCHIVE_TTL_MS`) del archivado, `git worktree unlock` y
   * `remove`, borra la branch local y la fila, salvo que quede algo sin pushear (cambios sin commitear, un
   * rebase a medias o commits que GitHub no tiene): ese se conserva. Nunca toca un worktree que una corrida
   * tiene tomado, también estacionada: se archiva en la pasada que sigue a su `release`. Idempotente; si un
   * worktree falla, sigue con los demás y lanza un `AggregateError` al final.
   */
  cleanup(): Promise<CleanupResult>;
  /** Lanza `StaleLeaseError` si `lease` ya no es el lease vigente del worktree. */
  validate(lease: WorkspaceRef): void;
  /**
   * Pushea `HEAD` a `refs/heads/<branch>` con `--force-with-lease` contra el `remote_sha` guardado, tras
   * validar el lease. Con `ok` el nuevo `remote_sha` queda guardado (también si el remoto ya tenía
   * ese commit). `lease-rejected` (otro pusheó) no se reintenta; `unauthorized` (401) deja la conexión
   * revocada. Con `council` (el PR tuvo threads `[clanker-council]`) el push nunca fuerza: si el
   * `remote_sha` no es ancestro de `HEAD` lanza sin pushear.
   */
  push(lease: WorkspaceRef, opts?: { council?: boolean }): Promise<PushOutcome>;
  /** Trae las branches del remoto a `refs/remotes/origin/*` con el mismo mecanismo que `push`. */
  fetch(repo: RepoId): Promise<FetchOutcome>;
  /**
   * La base vigente del worktree: la de `acquire`, o la que dejó el último `syncBase`. Lo que las
   * acciones sobre el worktree deben usar para el diff de la issue, no el `baseSha` de `$ws`, que no se
   * actualiza.
   */
  baseSha(lease: WorkspaceRef): string;
  /**
   * Trae el remoto y lleva el worktree a la punta nueva de su base. Sin movimiento, `same`. Si se movió,
   * solo se rebasea una branch que no está en el remoto y sin commits propios (si no, lanza
   * `SyncBaseError`: eso es `rebasePr`): el árbol completo, con cambios sin commit y archivos nuevos,
   * queda respaldado en `refs/clanker/backup/<branch>` (un commit sobre la base vieja; el último respaldo
   * pisa al anterior), el worktree pasa a la base nueva y los cambios se vuelven a aplicar con
   * `apply --3way`. Con `conflict` las marcas quedan en los archivos. Sin `repoConfig().remote` no hay fetch:
   * la base nueva es la que ya haya en el checkout. Reintentar tras un corte a medias retoma desde el respaldo.
   */
  syncBase(lease: WorkspaceRef): Promise<SyncBaseResult>;
  /**
   * Rebasea el PR sobre la punta de `base` (por defecto la que tiene el worktree; `origin/main` y `main`
   * son la misma) con `--onto`, y guarda la base nueva. Precondiciones, o lanza `RebaseError`: `HEAD` es el
   * `remote_sha`, el árbol está limpio, no hay un rebase en curso y el PR no tiene council (que nunca se
   * fuerza). Si `base` no es la que el worktree tenía (el PR de abajo se mergeó y GitHub lo movió),
   * `from` es la última punta que pusheamos de la base vieja: el `remote_sha` de su workspace o, sin él,
   * `origin/<base vieja>`; así no hay que calcularlo a mano aunque se mergeara con squash. Outcomes: `clean`;
   * `conflict` (rebase detenido con HEAD detached, `conflicts` con los archivos); `error` (falló sin
   * conflicto: `--abort` y la branch queda igual). Con `continue` sigue un rebase detenido, ver `continueRebase`.
   */
  rebase(lease: WorkspaceRef, opts: RebaseOptions): Promise<RebaseResult>;
  /**
   * Restack de un PR (`docs/design.html#d-ops`, restack): sus commits propios (los de `from..HEAD` por
   * el primer padre, sin los merges de la base) se vuelven a aplicar uno a uno sobre `onto` con el mismo
   * patch-id, y el resultado se pushea con lease antes de mover la branch local: un conflicto, un lease
   * rechazado o un corte antes del push dejan la branch y el remoto como estaban. Con la branch ya sobre
   * `onto` y sin `from` en su historia no hay nada que hacer (`uptodate`). Precondiciones, o lanza
   * `RebaseError`: sin council, `HEAD` es el `remote_sha` (o la branch no se ha publicado: entonces no
   * se pushea nada, solo se mueve la local), árbol limpio, sin un rebase en curso y `onto` y `from`
   * existen. Guarda `base` como `baseRef` y `onto` como `baseSha`.
   */
  restack(lease: WorkspaceRef, opts: RestackOptions): Promise<RestackResult>;
  /**
   * Arma la base combinada de una issue con varios padres (`docs/design.html#d-ops`, `workspace.combineBase`):
   * trae el remoto y deja en la branch local `branch` (`combinedBaseBranch`) la punta de la branch por defecto con un
   * merge --no-ff de cada padre encima, en orden, sin tocar ningún worktree. La registra en `combined_bases`
   * con la punta de cada padre. No se pushea: sus merges viajan en la branch de la issue, que sale de aquí. Si
   * los padres chocan (entre sí o con la branch por defecto) no mueve la branch y deja la base en `conflict`;
   * `changed` es `false` si ya estaba así con los mismos padres (no hay nada nuevo que avisar). Rehacerla con
   * los mismos padres da el mismo sha. Lanza si falta la branch de un padre o `branch` no es un nombre válido.
   */
  combineBase(request: CombineRequest): Promise<CombineResult>;
  /**
   * Deja de usar la base combinada `branch` del repo: la marca `dissolved` y borra la branch sintética. No hace
   * nada si no existe o ya estaba disuelta. Es lo que queda cuando se mergean todos los padres y cuando la
   * issue sale a otra base.
   */
  dissolveBase(repo: RepoId, branch: string): Promise<void>;
  /**
   * `restack` de un PR cuya base es la combinada `branch`: la recalcula con los padres que quedan (`parents`,
   * abiertos y en orden: la branch por defecto actual con un merge de cada uno, o solo la branch por defecto si ya
   * no queda ninguno), y deja los commits propios (los que siguen a la última punta registrada de la base
   * combinada) sobre la base nueva, como `restack`. Con `restacked` o `uptodate` la base nueva queda registrada
   * (y disuelta si no quedan padres) y el worktree guarda `branch` (o la branch por defecto) como base. Si los
   * padres que quedan ya no se pueden juntar es `base-conflict`: nada se mueve y la base queda en `conflict`.
   * Mismas precondiciones que `restack`; lanza `RebaseError` si la base combinada no está vigente y
   * `StaleCombinedBaseError` (un `RebaseError`) si el PR no salió de ella: su última punta (o nunca hubo) no está en su historia.
   */
  restackCombined(lease: WorkspaceRef, opts: RestackCombinedOptions): Promise<RestackResult | BaseConflict>;
  /** Corre `git` en el worktree con autor y committer en el entorno, después de validar el token. */
  git(lease: WorkspaceRef, ...args: string[]): Promise<string>;
  /**
   * Corre `command` con `sh -c` en el worktree, después de validar el token. La salida completa se
   * agrega al log del paso y `extract` trae las últimas 60 líneas. Un exit distinto de 0 es un
   * resultado, no una excepción; solo falla si el comando no se pudo lanzar o se abortó.
   */
  exec(lease: WorkspaceRef, command: string, opts: ExecOptions): Promise<ExecResult>;
}

/** Otra corrida tiene el lease vigente de esa branch. */
export class WorkspaceBusyError extends Error {}

/** El lease se perdió (venció y otra corrida lo tomó): la operación no se ejecutó. */
export class StaleLeaseError extends Error {}

/** `setup.worktree` falló: el worktree se borró, el próximo `acquire` lo crea de nuevo. */
export class WorktreeSetupError extends Error {}

/** La branch no se puede usar como workspace; el mensaje dice por qué. */
export class BranchNotAllowedError extends Error {}

/** `syncBase` no puede seguir y reintentar no lo arregla (commits propios, branch ya publicada, conexión revocada). */
export class SyncBaseError extends Error {}

/** `attach` no puede retomar la branch y reintentar no lo arregla (no está en el remoto, adelantada o divergida, conexión revocada). */
export class AttachError extends Error {}

/** `rebase` no se puede hacer y reintentar no lo arregla (precondiciones, council, `from` que no calza). */
export class RebaseError extends Error {}

/**
 * `restackCombined` de un PR que no salió de la base combinada registrada (una fila vieja: la issue se relanzó a
 * mano sobre otra base): quien llama la retira y restackea como un PR apilado común.
 */
export class StaleCombinedBaseError extends RebaseError {}

export interface RebaseOptions {
  /** El PR tuvo threads `[clanker-council]`: no se rebasea nunca. */
  council: boolean;
  /** La base que el PR tiene ahora; sin ella, la del worktree. */
  base?: string;
  /** Sigue el rebase detenido por conflicto en lugar de empezar uno. */
  continue?: boolean;
}

export type RebaseResult =
  | { outcome: "clean"; baseSha: string; head: string }
  | { outcome: "conflict"; applying?: string; conflicts: string[]; failures: string }
  | { outcome: "error"; failures: string };

export interface RestackOptions {
  /** El PR tuvo threads `[clanker-council]`: nunca se fuerza. */
  council: boolean;
  /** La punta de la base nueva. */
  onto: string;
  /** La última punta de la base vieja: lo que el PR trae de ella no es suyo. */
  from: string;
  /** El nombre de la base nueva, que pasa a ser la del worktree. */
  base: string;
}

export type RestackResult =
  | { outcome: "restacked"; previousHead: string; head: string; commits: number }
  | { outcome: "uptodate" }
  | { outcome: "conflict"; applying: string; conflicts: string[]; failures: string }
  | { outcome: "foreign-merge"; merge: string; failures: string }
  | { outcome: "empty" }
  | { outcome: Exclude<PushOutcome, "ok"> };

export interface CombineRequest {
  repo: RepoId;
  issueId: IssueId;
  /** La branch sintética de la issue: `combinedBaseBranch`. */
  branch: string;
  /** Los PRs padre en orden: el primero es la base del PR en GitHub. */
  parents: readonly Pick<CombinedParent, "key" | "branch">[];
}

/** Los padres no se pueden juntar: `parent` choca con la branch por defecto y los padres anteriores (`merged`), en `files`. */
export interface BaseConflict {
  outcome: "base-conflict";
  parent: string;
  merged: string[];
  files: string[];
  failures: string;
}

export type CombineResult = { outcome: "combined"; branch: string; head: string; parents: CombinedParent[] } | (BaseConflict & { changed: boolean });

export interface RestackCombinedOptions {
  /** El PR tuvo threads `[clanker-council]`: nunca se fuerza. */
  council: boolean;
  /** La branch sintética de la issue. */
  branch: string;
  /** Los padres que quedan, abiertos y en orden. */
  parents: readonly Pick<CombinedParent, "key" | "branch">[];
}

/** La branch sintética de la base combinada de una issue (`clanker/base/<issue>`). */
export const combinedBaseBranch = (issueKey: string): string => `clanker/base/${issueKey}`;

export type SyncBaseResult =
  | { outcome: "same"; baseSha: string }
  | { outcome: "rebased"; baseSha: string; from: string; backup: string }
  | {
      outcome: "conflict";
      baseSha: string;
      from: string;
      backup: string;
      /** Archivos que el dev debe resolver: con marcas, o sin ellas si git no pudo aplicar su cambio (ahí su versión está en `backup`). */
      conflicts: string[];
      failures: string;
    };

export function createWorkspaces(opts: WorkspacesOptions): Workspaces {
  const { store, dataDir, repoConfig, identityOf, remote, procs, worktreeSetup, leaseTtlMs = LEASE_TTL_MS, now = Date.now } = opts;
  const logDir = opts.logDir ?? defaultLogDir(dataDir);
  const heartbeats = new Map<string, { timer: NodeJS.Timeout; workspaceId: string; runId: RunId; token: number }>();
  const repoLocks = new Map<string, Promise<unknown>>();

  /** Un solo fetch o worktree add/remove a la vez por repo: tocan refs compartidas. */
  async function withRepoLock<T>(repoId: RepoId, fn: () => Promise<T>): Promise<T> {
    const result = (repoLocks.get(repoId) ?? Promise.resolve()).then(fn);
    const tail = result.catch(() => undefined);
    repoLocks.set(repoId, tail);
    try {
      return await result;
    } finally {
      if (repoLocks.get(repoId) === tail) repoLocks.delete(repoId);
    }
  }

  const { cleanup } = createArchive({ store, repoConfig, now, withRepoLock });

  function takeLease(db: Store["db"], id: string, runId: RunId) {
    const t = now();
    return db
      .update(workspaces)
      .set({
        holderRunId: runId,
        leaseUntil: t + leaseTtlMs,
        fencingToken: sql`${workspaces.fencingToken} + 1`,
        // Tomar un archivado (su PR se reabrió, o se vuelve a usar la branch) lo revive.
        state: sql`CASE WHEN ${workspaces.state} = 'archived' THEN 'idle' ELSE ${workspaces.state} END`,
        archivedAt: null,
      })
      .where(
        and(
          eq(workspaces.id, id),
          // Una corrida que ya lo tiene lo vuelve a tomar (su `workspace.acquire` se re-ejecuta tras un corte).
          or(isNull(workspaces.holderRunId), lt(workspaces.leaseUntil, t), eq(workspaces.holderRunId, runId)),
        ),
      )
      .returning()
      .get();
  }

  function renew(workspaceId: string, runId: RunId, token: number): boolean {
    return (
      store.tx(({ db }) =>
        db
          .update(workspaces)
          .set({ leaseUntil: now() + leaseTtlMs })
          .where(
            and(
              eq(workspaces.id, workspaceId),
              eq(workspaces.fencingToken, token),
              eq(workspaces.holderRunId, runId),
            ),
          )
          .returning({ id: workspaces.id })
          .get(),
      ) !== undefined
    );
  }

  /** Por token, no por workspace: el latido de un lease perdido no debe detener el del vigente. */
  const beatKey = (workspaceId: string, token: number) => `${workspaceId}:${token}`;

  function startHeartbeat(workspaceId: string, runId: RunId, token: number): AbortSignal {
    const lost = new AbortController();
    const timer = setInterval(() => {
      try {
        if (renew(workspaceId, runId, token)) return;
        lost.abort();
      } catch (error) {
        // Un throw desde el timer tumbaría el proceso (la base ya cerrada al apagar): sin renovar, el lease se perdió.
        lost.abort(error);
      }
      stopHeartbeat(workspaceId, token);
    }, leaseTtlMs / 3);
    timer.unref();
    heartbeats.set(beatKey(workspaceId, token), { timer, workspaceId, runId, token });
    return lost.signal;
  }

  function stopHeartbeat(workspaceId: string, token: number): void {
    const key = beatKey(workspaceId, token);
    clearInterval(heartbeats.get(key)?.timer);
    heartbeats.delete(key);
  }

  function validate(lease: WorkspaceRef): void {
    const row = store.db
      .select({ id: workspaces.id })
      .from(workspaces)
      .where(
        and(eq(workspaces.id, lease.workspaceId), eq(workspaces.fencingToken, lease.fencingToken)),
      )
      .get();
    if (!row) {
      throw new StaleLeaseError(
        `El lease del workspace ${lease.branch} (token ${lease.fencingToken}) ya no es el vigente: ` +
          "otra corrida lo tomó. No se ejecutó nada.",
      );
    }
  }

  function workspacePath(repoId: RepoId, cfg: RepoConfig, branch: string): string {
    const root = cfg.worktreeDir ? resolve(dataDir, cfg.worktreeDir) : join(dataDir, "worktrees");
    return join(root, repoId, branch);
  }

  async function acquire({ repo, branch: rawBranch, base, runId }: AcquireRequest) {
    const cfg = repoConfig(repo);
    const branch = rawBranch.replace(/^refs\/heads\//, "");
    await assertBranchAllowed(cfg, branch);
    const baseRef = normalizeBase(base);

    const claim = store.tx(({ db, emit }) => {
      // El vivo si lo hay; si no, el archivado de esa branch (todavía tiene su carpeta y sale de `archived` al tomarlo).
      const rows = db.select().from(workspaces).where(and(eq(workspaces.repoId, repo), eq(workspaces.branch, branch))).all();
      const existing = rows.find((r) => r.state !== "archived") ?? rows[0];

      let row: typeof workspaces.$inferSelect;
      if (existing) {
        const taken = takeLease(db, existing.id, runId);
        if (!taken) {
          throw new WorkspaceBusyError(
            `La branch ${branch} de ${repo} la tiene la corrida ${existing.holderRunId} ` +
              `hasta ${new Date(existing.leaseUntil ?? 0).toISOString()}.`,
          );
        }
        if (existing.holderRunId && existing.holderRunId !== runId) {
          emit({
            type: "lease.expired",
            origin: "core",
            runId: existing.holderRunId,
            payload: {
              resource: "workspace",
              id: existing.id,
              runId: existing.holderRunId,
              token: existing.fencingToken,
            },
          });
        }
        row = taken;
      } else {
        row = db
          .insert(workspaces)
          .values({
            id: newId("ws"),
            repoId: repo,
            path: workspacePath(repo, cfg, branch),
            branch,
            baseRef,
            state: "creating",
            holderRunId: runId,
            leaseUntil: now() + leaseTtlMs,
            fencingToken: 1,
          })
          .returning()
          .get();
      }
      emit({
        type: "lease.acquired",
        origin: "core",
        runId,
        payload: { resource: "workspace", id: row.id, runId, token: row.fencingToken },
      });
      return { row, isNew: !existing };
    });
    const { row } = claim;

    // El lease se renueva desde ya: el fetch y el worktree add pueden tardar más que el ttl.
    const lost = startHeartbeat(row.id, runId, row.fencingToken);
    let baseSha: string;
    let remoteSha: string | undefined;
    let head: string;
    try {
      if (!claim.isNew && existsSync(row.path)) {
        baseSha = row.baseSha ?? (await resolveBase(cfg, row.baseRef));
        // Un corte durante `setup.worktree` deja la fila en `creating` con la carpeta ya creada.
        if (row.state === "creating") await setupWorktree(cfg, row, false, runId, lost);
      } else {
        ({ baseSha, remoteSha } = await withRepoLock(repo, () => createWorktree(cfg, row, claim.isNew)));
        // Fuera del lock del repo: un `bundle install` largo no debe frenar el fetch ni los worktrees de otras corridas.
        await setupWorktree(cfg, row, claim.isNew, runId, lost);
      }
      head = await git(row.path, ["rev-parse", "HEAD"]);
    } catch (error) {
      stopHeartbeat(row.id, row.fencingToken);
      abandon(row, runId, claim.isNew);
      throw error;
    }
    store.tx(({ db }) => {
      const updated = db
        .update(workspaces)
        .set({ state: "leased", baseSha, headSha: head, ...(remoteSha && { remoteSha }) })
        .where(
          and(eq(workspaces.id, row.id), eq(workspaces.fencingToken, row.fencingToken)),
        )
        .returning({ id: workspaces.id })
        .get();
      if (!updated) {
        throw new StaleLeaseError(
          `El lease de ${branch} venció mientras se preparaba el worktree y otra corrida lo tomó.`,
        );
      }
    });

    return {
      workspaceId: row.id,
      runId,
      path: row.path,
      branch,
      baseRef: row.baseRef,
      baseSha,
      fencingToken: row.fencingToken,
      lost,
    };
  }

  /**
   * Fetch, resuelve la base y agrega el worktree. Va bajo el lock del repo. Si la branch ya existe en el
   * remoto, su punta es el `remoteSha` inicial: sin él, el primer push con lease sería rechazado.
   */
  async function createWorktree(
    cfg: RepoConfig,
    row: typeof workspaces.$inferSelect,
    isNew: boolean,
  ): Promise<{ baseSha: string; remoteSha?: string }> {
    // Una fila nueva cuya carpeta ya existe apunta al worktree de otra branch: en macOS `CLA-1` y
    // `cla-1` son la misma carpeta, y reusarla dejaría dos corridas escribiendo en el mismo worktree.
    if (isNew && existsSync(row.path)) {
      throw new BranchNotAllowedError(
        `La carpeta ${row.path} ya existe y no es de la branch ${row.branch} ` +
          "(¿otra branch con el mismo nombre en otras mayúsculas?). Elige otro nombre.",
      );
    }
    const hasRemote = await hasOrigin(cfg);
    if (hasRemote) await git(cfg.path, ["fetch", REMOTE], pickEnv(USER_REMOTE_ENV));
    const baseSha = await resolveBase(cfg, row.baseRef);
    const localExists = await refExists(cfg, `refs/heads/${row.branch}`);
    const remoteExists = hasRemote && (await refExists(cfg, `refs/remotes/${REMOTE}/${row.branch}`));

    // Una branch local sin fila en la base es del usuario: no se la quitamos con un worktree.
    if (localExists && isNew) {
      throw new BranchNotAllowedError(
        `La branch ${row.branch} ya existe en ${cfg.path} y no la creó Clanker Yard. ` +
          "Elige otro nombre o borra esa branch si no la necesitas.",
      );
    }

    const add = ["worktree", "add", "--lock", "--reason", WORKTREE_LOCK_REASON];
    if (localExists) {
      await forgetDeletedWorktree(cfg, row.branch);
      await git(cfg.path, [...add, row.path, row.branch]);
    } else {
      const start = remoteExists ? `refs/remotes/${REMOTE}/${row.branch}` : baseSha;
      // `--no-track` (solo vale con `-b`): el tracking escribiría `branch.<b>.*` en .git/config, que los worktrees comparten.
      await git(cfg.path, [...add, "--no-track", "-b", row.branch, row.path, start]);
    }
    return {
      baseSha,
      ...(remoteExists && { remoteSha: await git(cfg.path, ["rev-parse", `refs/remotes/${REMOTE}/${row.branch}`]) }),
    };
  }

  /**
   * Corre `setup.worktree` en el worktree recién creado. Si falla, lo borra (y la branch, si la creó este
   * `acquire`): uno a medio preparar se reusaría tal cual en el próximo `acquire`.
   */
  async function setupWorktree(
    cfg: RepoConfig,
    row: typeof workspaces.$inferSelect,
    isNew: boolean,
    runId: RunId,
    signal: AbortSignal,
  ): Promise<void> {
    if (!worktreeSetup) return;
    try {
      for (const command of worktreeSetup(row.path)) {
        const { exitCode, extract } = await execLogged({
          cwd: row.path,
          command,
          env: {},
          logPath: join(logDir, "runs", runId, "setup.worktree.log"),
          signal,
          onSpawn: procs && ((child) => procs.track(child, { kind: "recipe" })),
        });
        if (exitCode !== 0) {
          throw new WorktreeSetupError(`setup.worktree falló en ${row.path}: ${command} (exit ${exitCode})\n${extract}`);
        }
      }
    } catch (error) {
      await withRepoLock(row.repoId, async () => {
        await tryGit(cfg.path, ["worktree", "remove", "--force", "--force", row.path]);
        if (isNew) await tryGit(cfg.path, ["branch", "-D", row.branch]);
      });
      throw error;
    }
  }

  /**
   * Si borraron a mano la carpeta del worktree de `branch`, git lo sigue teniendo registrado y
   * bloqueado, y `worktree add` de esa branch fallaría para siempre: se olvida ese registro.
   */
  async function forgetDeletedWorktree(cfg: RepoConfig, branch: string): Promise<void> {
    const list = await git(cfg.path, ["worktree", "list", "--porcelain", "-z"]);
    for (const entry of list.split("\0\0")) {
      const fields = entry.split("\0");
      const path = fields.find((f) => f.startsWith("worktree "))?.slice("worktree ".length);
      if (path !== undefined && fields.includes(`branch refs/heads/${branch}`) && !existsSync(path)) {
        await git(cfg.path, ["worktree", "remove", "--force", "--force", path]);
      }
    }
  }

  /**
   * El worktree no se pudo preparar: una fila nueva se borra; una existente suelta su lease. Emite
   * `lease.released`, porque el `lease.acquired` del claim ya quedó en la línea de tiempo.
   */
  function abandon(row: typeof workspaces.$inferSelect, runId: RunId, isNew: boolean): void {
    store.tx(({ db, emit }) => {
      const mine = and(eq(workspaces.id, row.id), eq(workspaces.fencingToken, row.fencingToken));
      const dropped = isNew
        ? db.delete(workspaces).where(mine).returning({ id: workspaces.id }).get()
        : db
            .update(workspaces)
            .set({ holderRunId: null, leaseUntil: null })
            .where(mine)
            .returning({ id: workspaces.id })
            .get();
      if (dropped) {
        emit({
          type: "lease.released",
          origin: "core",
          runId,
          payload: { resource: "workspace", id: row.id, token: row.fencingToken },
        });
      }
    });
  }

  async function assertBranchAllowed(cfg: RepoConfig, branch: string): Promise<void> {
    if (branch === cfg.defaultBranch || cfg.protectedBranches?.includes(branch)) {
      throw new BranchNotAllowedError(
        `${branch} es la branch por defecto o está protegida: un workspace no puede trabajar sobre ella.`,
      );
    }
    try {
      // Fuera del repo: el nombre no depende de él, y si su carpeta no está, ese es el error (y se
      // reintenta), no un nombre inválido.
      await git(tmpdir(), ["check-ref-format", "--branch", branch]);
    } catch (error) {
      throw new BranchNotAllowedError(`"${branch}" no es un nombre de branch válido.`, { cause: error });
    }
  }

  async function hasOrigin(cfg: RepoConfig): Promise<boolean> {
    return (await git(cfg.path, ["remote"])).split("\n").includes(REMOTE);
  }

  async function refExists(cfg: RepoConfig, ref: string): Promise<boolean> {
    return (await tryGit(cfg.path, ["rev-parse", "--verify", "--quiet", ref])) !== undefined;
  }

  /** La punta fresca de `origin/<base>` si hay remoto; si no, la local. */
  async function resolveBase(cfg: RepoConfig, baseRef: string): Promise<string> {
    for (const ref of [`refs/remotes/${REMOTE}/${baseRef}`, `refs/heads/${baseRef}`]) {
      const sha = await tryGit(cfg.path, ["rev-parse", "--verify", "--quiet", ref]);
      if (sha) return sha.trim();
    }
    throw new BranchNotAllowedError(
      `La base ${baseRef} no existe en ${cfg.path}, ni como ${REMOTE}/${baseRef} ni como branch local.`,
    );
  }

  function remoteOf(repoId: RepoId) {
    const target = repoConfig(repoId).remote;
    if (!remote || !target) {
      throw new Error(`El repo ${repoId} no tiene remoto configurado (repoConfig().remote y la opción remote): no se puede pushear ni fetchear.`);
    }
    return { remote, ...target };
  }

  async function push(lease: WorkspaceRef, { council = false } = {}): Promise<PushOutcome> {
    validate(lease);
    const row = store.db.select().from(workspaces).where(eq(workspaces.id, lease.workspaceId)).get()!;
    const sha = await git(lease.path, ["rev-parse", "HEAD"]);
    if (council && row.remoteSha && !(await isAncestor(lease.path, row.remoteSha, sha))) {
      throw new Error(
        `${lease.branch} tiene council y su HEAD ${sha.slice(0, 9)} no desciende de lo que hay en el remoto ` +
          `(${row.remoteSha.slice(0, 9)}): pushearlo sería un force push, que un PR con council no admite.`,
      );
    }
    return pushSha(lease, row, sha);
  }

  /** Pushea `sha` a la branch del workspace con lease contra su `remote_sha` y guarda el nuevo (más `extra`). */
  async function pushSha(
    lease: WorkspaceRef,
    row: typeof workspaces.$inferSelect,
    sha: string,
    extra: Partial<typeof workspaces.$inferInsert> = {},
  ): Promise<PushOutcome> {
    const { remote, url, account } = remoteOf(row.repoId);
    const outcome = await remote.push({
      cwd: lease.path,
      url,
      account,
      branch: lease.branch,
      sha,
      expectedRemoteSha: row.remoteSha,
    });
    if (outcome !== "ok") return outcome;
    const saved = store.tx(({ db }) =>
      db
        .update(workspaces)
        .set({ headSha: sha, remoteSha: sha, ...extra })
        .where(and(eq(workspaces.id, lease.workspaceId), eq(workspaces.fencingToken, lease.fencingToken)))
        .returning({ id: workspaces.id })
        .get(),
    );
    if (!saved) {
      throw new StaleLeaseError(
        `El lease de ${lease.branch} se perdió durante el push: el remoto ya tiene ${sha} pero otra corrida tomó el workspace.`,
      );
    }
    return "ok";
  }

  /** Corre `git` en el worktree con autor y committer en el entorno, después de validar el token. */
  async function gitIn(lease: WorkspaceRef, ...args: string[]): Promise<string> {
    const { repoId } = rowOf(lease);
    const identity = await identityOf(repoId);
    return git(lease.path, args, {
      GIT_AUTHOR_NAME: identity.name,
      GIT_AUTHOR_EMAIL: identity.email,
      ...committerEnv(identity),
    });
  }

  function committerEnv(identity: GitIdentity): Record<string, string> {
    return { GIT_COMMITTER_NAME: identity.name, GIT_COMMITTER_EMAIL: identity.email };
  }

  function rowOf(lease: WorkspaceRef): typeof workspaces.$inferSelect {
    validate(lease);
    return store.db.select().from(workspaces).where(eq(workspaces.id, lease.workspaceId)).get()!;
  }

  function baseSha(lease: WorkspaceRef): string {
    const sha = rowOf(lease).baseSha;
    if (sha === null) throw new Error(`El workspace ${lease.branch} todavía no tiene base: sigue creándose.`);
    return sha;
  }

  async function fetchRepo(repo: RepoId): Promise<FetchOutcome> {
    const { remote, url, account } = remoteOf(repo);
    return withRepoLock(repo, () => remote.fetch({ cwd: repoConfig(repo).path, url, account }));
  }

  async function syncBase(lease: WorkspaceRef): Promise<SyncBaseResult> {
    const row = rowOf(lease);
    const cfg = repoConfig(row.repoId);
    if (cfg.remote && (await fetchRepo(row.repoId)) === "unauthorized") {
      throw githubUnauthorized(cfg.remote.account, `traer ${row.repoId}`);
    }
    const from = baseSha(lease);
    const target = await resolveBase(cfg, row.baseRef);
    if (target === from) return { outcome: "same", baseSha: target };

    const backupRef = `refs/clanker/backup/${row.branch}`;
    const head = await gitIn(lease, "rev-parse", "HEAD");
    if (head === from) {
      if (row.remoteSha !== null || (await refExists(cfg, `refs/remotes/${REMOTE}/${row.branch}`))) {
        throw new SyncBaseError(
          `${row.branch} ya está en el remoto: la base nueva se integra con un rebase del PR, no con syncBase.`,
        );
      }
      const tree = await snapshotTree(lease.path);
      const backup = await gitIn(lease, "commit-tree", tree, "-p", "HEAD", "-m", `clanker: respaldo de ${row.branch} antes de rebasear`);
      await gitIn(lease, "update-ref", backupRef, backup);
    } else if (!(head === target && (await isResumable(lease, backupRef, from)))) {
      throw new SyncBaseError(
        `${row.branch} tiene commits propios (HEAD ${head.slice(0, 9)}, base ${from.slice(0, 9)}): ` +
          "con commits, la base nueva se integra con un rebase del PR, no con syncBase.",
      );
    }

    // Todo sale del respaldo, así que un corte entre el reset y el apply se retoma desde aquí.
    const patch = await diffBetween(lease.path, `${backupRef}^`, backupRef);
    await gitIn(lease, "reset", "--quiet", "--hard", target);
    // El reset no toca los archivos nuevos sin seguimiento, que el patch vuelve a crear.
    await gitIn(lease, "clean", "--quiet", "--force", "-d");
    const applied = patch === "" ? undefined : await applyThreeWay(lease, patch);
    const unmerged = (await gitIn(lease, "-c", "core.quotePath=false", "diff", "--name-only", "--diff-filter=U"))
      .split("\n")
      .filter(Boolean);
    // `apply --3way` deja el index con entradas sin mergear: el dev solo ve archivos modificados, como antes.
    await gitIn(lease, "reset", "--quiet");
    const unapplied = applied && !applied.ok ? applied.unapplied.filter((path) => !unmerged.includes(path)) : [];
    // Un fallo sin archivos que nombrar no es un conflicto: antes de guardar la base nueva, para que el reintento retome.
    if (applied && !applied.ok && unmerged.length + unapplied.length === 0) throw applied.error;

    const saved = store.tx(({ db }) =>
      db
        .update(workspaces)
        .set({ baseSha: target, headSha: target })
        .where(and(eq(workspaces.id, lease.workspaceId), eq(workspaces.fencingToken, lease.fencingToken)))
        .returning({ id: workspaces.id })
        .get(),
    );
    if (!saved) {
      throw new StaleLeaseError(`El lease de ${row.branch} se perdió mientras se rebaseaba: otra corrida tomó el workspace.`);
    }

    if (applied === undefined || applied.ok) return { outcome: "rebased", baseSha: target, from, backup: backupRef };
    const conflicts = [...unmerged, ...unapplied];
    const failures = [
      `Rebase sobre ${target.slice(0, 9)} (la base era ${from.slice(0, 9)}): conflicto en ${conflicts.join(", ")}.`,
      unmerged.length > 0 ? "Las marcas <<<<<<< están en los archivos del worktree." : "",
      unapplied.length > 0
        ? `Sin marcas, git no pudo aplicar el cambio de ${unapplied.join(", ")}: su versión anterior está en ${backupRef}.`
        : "",
      excerpt(applied.error.output),
    ];
    return {
      outcome: "conflict",
      baseSha: target,
      from,
      backup: backupRef,
      conflicts,
      failures: failures.filter(Boolean).join("\n"),
    };
  }

  /** El respaldo de un `syncBase` cortado tras el reset: un commit sobre la base vieja. */
  async function isResumable(lease: WorkspaceRef, backupRef: string, from: string): Promise<boolean> {
    const parent = await tryGit(lease.path, ["rev-parse", "--verify", "--quiet", `${backupRef}^`]);
    return parent === from;
  }

  /** `apply --3way`: git sale con 1 si deja conflictos, y eso es un resultado. */
  async function applyThreeWay(
    lease: WorkspaceRef,
    patch: string,
  ): Promise<{ ok: true } | { ok: false; error: GitError; unapplied: string[] }> {
    const dir = mkdtempSync(join(tmpdir(), "clanker-sync-"));
    try {
      const file = join(dir, "changes.patch");
      writeFileSync(file, patch);
      await gitIn(lease, "apply", "--3way", file);
      return { ok: true };
    } catch (error) {
      if (!(error instanceof GitError)) throw error;
      // Un archivo que git no puede ni mezclar (el cambio toca un archivo que la base nueva borró) no deja marcas.
      const unapplied = [...error.output.matchAll(/^error: (.+): (?:does not exist in index|patch does not apply)$/gm)].map((m) => m[1]!);
      return { ok: false, error, unapplied };
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  async function attach(request: AcquireRequest): Promise<WorkspaceLease & { fastForwarded: boolean }> {
    const cfg = repoConfig(request.repo);
    const branch = request.branch.replace(/^refs\/heads\//, "");
    if (cfg.remote && (await fetchRepo(request.repo)) === "unauthorized") {
      throw githubUnauthorized(cfg.remote.account, `traer ${request.repo}`);
    }
    const remoteTip = await tryGit(cfg.path, ["rev-parse", "--verify", "--quiet", `refs/remotes/${REMOTE}/${branch}`]);
    if (remoteTip === undefined) {
      throw new AttachError(`${branch} no está en el remoto de ${request.repo}: no hay un PR que retomar.`);
    }

    const lease = await acquire(request);
    try {
      await abortLeftoverRebase(lease.path);
      const head = await gitIn(lease, "rev-parse", "HEAD");
      const fastForwarded = head !== remoteTip;
      if (fastForwarded) {
        if (!(await isAncestor(lease.path, head, remoteTip))) {
          const ahead = await isAncestor(lease.path, remoteTip, head);
          throw new AttachError(
            `${branch} local (${head.slice(0, 9)}) ${ahead ? "tiene commits que el remoto no" : "y el remoto"} ` +
              `(${remoteTip.slice(0, 9)}) ${ahead ? "tiene" : "divergieron"}: no se puede avanzar con un fast-forward.`,
          );
        }
        await gitIn(lease, "merge", "--ff-only", "--no-autostash", remoteTip);
      }
      const saved = store.tx(({ db }) =>
        db
          .update(workspaces)
          .set({ headSha: remoteTip, remoteSha: remoteTip })
          .where(and(eq(workspaces.id, lease.workspaceId), eq(workspaces.fencingToken, lease.fencingToken)))
          .returning({ id: workspaces.id })
          .get(),
      );
      if (!saved) throw new StaleLeaseError(`El lease de ${branch} se perdió mientras se retomaba: otra corrida tomó el workspace.`);
      return { ...lease, fastForwarded };
    } catch (error) {
      release(lease);
      throw error;
    }
  }

  async function rebase(lease: WorkspaceRef, { council, base, continue: resume = false }: RebaseOptions): Promise<RebaseResult> {
    const row = rowOf(lease);
    const cfg = repoConfig(row.repoId);
    const inWorktree = (...args: string[]) => gitIn(lease, ...args);
    if (council) {
      throw new RebaseError(`${row.branch} tiene threads [clanker-council]: un rebase reescribiría su historia y un PR con council nunca se fuerza.`);
    }
    const target = normalizeBase(base ?? row.baseRef);
    const inProgress = await rebaseInProgress(inWorktree);

    let step: RebaseStep;
    let onto: string;
    if (resume) {
      // Un rebase que el agente ya terminó por su cuenta solo falta registrarlo.
      onto = inProgress ? await rebaseOnto(inWorktree) : await resolveBase(cfg, target);
      if (!inProgress && !(await isAncestor(lease.path, onto, "HEAD"))) {
        throw new RebaseError(`No hay un rebase en curso en ${row.branch} y su HEAD no está sobre ${target}: no hay nada que continuar.`);
      }
      step = inProgress ? await continueRebase(inWorktree) : { status: "done" };
    } else {
      onto = await resolveBase(cfg, target);
      const head = await inWorktree("rev-parse", "HEAD");
      if (inProgress) throw new RebaseError(`${row.branch} ya tiene un rebase en curso: sigue con \`continue\` o abórtalo.`);
      if (row.remoteSha === null || head !== row.remoteSha) {
        throw new RebaseError(
          `HEAD de ${row.branch} (${head.slice(0, 9)}) no es lo último que se pusheó (${row.remoteSha?.slice(0, 9) ?? "nada"}): ` +
            "rebasearlo pisaría o perdería commits. Retoma la branch con attach.",
        );
      }
      if ((await inWorktree("status", "--porcelain")) !== "") {
        throw new RebaseError(`${row.branch} tiene cambios sin commitear: un rebase con el árbol sucio perdería trabajo.`);
      }
      const from = await rebaseFrom(row, cfg, target, lease.path);
      step = await startRebase(inWorktree, { onto, ...(from !== undefined && { from }) });
    }

    if (step.status !== "done") {
      const { status, ...rest } = step;
      return { outcome: status, ...rest } as RebaseResult;
    }
    const head = await inWorktree("rev-parse", "HEAD");
    const saved = store.tx(({ db }) =>
      db
        .update(workspaces)
        .set({ baseRef: target, baseSha: onto, headSha: head })
        .where(and(eq(workspaces.id, lease.workspaceId), eq(workspaces.fencingToken, lease.fencingToken)))
        .returning({ id: workspaces.id })
        .get(),
    );
    if (!saved) throw new StaleLeaseError(`El lease de ${row.branch} se perdió mientras se rebaseaba: otra corrida tomó el workspace.`);
    return { outcome: "clean", baseSha: onto, head };
  }

  async function restack(lease: WorkspaceRef, { council, onto, from, base }: RestackOptions): Promise<RestackResult> {
    const row = rowOf(lease);
    if (council) {
      throw new RebaseError(`${row.branch} tiene threads [clanker-council]: un restack reescribiría su historia y un PR con council nunca se fuerza.`);
    }
    const inWorktree = (...args: string[]) => gitIn(lease, ...args);
    if (await rebaseInProgress(inWorktree)) throw new RebaseError(`${row.branch} tiene un rebase en curso: termínalo o abórtalo antes de un restack.`);
    const head = await inWorktree("rev-parse", "HEAD");
    // Sin `remote_sha` la branch aún no se publicó (el PR de `pr.publish` con su base ya mergeada): no hay nada que pisar ni que pushear.
    const published = row.remoteSha !== null;
    if (published ? head !== row.remoteSha : await refExists(repoConfig(row.repoId), `refs/remotes/${REMOTE}/${row.branch}`)) {
      throw new RebaseError(
        `HEAD de ${row.branch} (${head.slice(0, 9)}) no es lo último que se pusheó (${row.remoteSha?.slice(0, 9) ?? "nada"}): ` +
          "rehacerlo pisaría o perdería commits. Retoma la branch con attach.",
      );
    }
    if ((await inWorktree("status", "--porcelain")) !== "") {
      throw new RebaseError(`${row.branch} tiene cambios sin commitear: un restack con el árbol sucio perdería trabajo.`);
    }
    for (const [name, sha] of [["onto", onto], ["from", from]] as const) {
      if ((await tryGit(lease.path, ["rev-parse", "--verify", "--quiet", `${sha}^{commit}`])) === undefined) {
        throw new RebaseError(`El commit ${name} ${sha.slice(0, 9)} no existe en el repo de ${row.branch}: falta un fetch.`);
      }
    }

    const moved = { baseRef: normalizeBase(base), baseSha: onto };
    if ((await isAncestor(lease.path, onto, head)) && !(await isAncestor(lease.path, from, head))) {
      store.tx(({ db }) => db.update(workspaces).set(moved).where(and(eq(workspaces.id, row.id), eq(workspaces.fencingToken, lease.fencingToken))).run());
      return { outcome: "uptodate" };
    }

    const plan = await planRestack((args, env, input) => git(lease.path, args, env, input), { onto, from, committer: committerEnv(await identityOf(row.repoId)) });
    switch (plan.status) {
      case "empty":
        return { outcome: "empty" };
      case "conflict":
        return { outcome: "conflict", applying: plan.applying, conflicts: plan.conflicts, failures: plan.failures };
      case "foreign-merge":
        return { outcome: "foreign-merge", merge: plan.merge, failures: plan.failures };
      case "ok":
        break;
    }
    if (published) {
      const pushed = await pushSha(lease, row, plan.head, moved);
      if (pushed !== "ok") return { outcome: pushed };
      await inWorktree("reset", "--hard", plan.head);
    } else {
      // Primero la branch y luego la fila: un corte entre los dos se reintenta como `uptodate` y la completa.
      await inWorktree("reset", "--hard", plan.head);
      store.tx(({ db }) =>
        db.update(workspaces).set({ ...moved, headSha: plan.head }).where(and(eq(workspaces.id, row.id), eq(workspaces.fencingToken, lease.fencingToken))).run(),
      );
    }
    return { outcome: "restacked", previousHead: head, head: plan.head, commits: plan.commits };
  }

  /**
   * El `from` de `rebase --onto`: solo si el PR cambió de base (el de abajo se mergeó), la última punta
   * que pusheamos de la base vieja. Sin cambio de base, `undefined`: un `rebase` común ya deja afuera los
   * commits que son de la base.
   */
  async function rebaseFrom(row: typeof workspaces.$inferSelect, cfg: RepoConfig, target: string, path: string): Promise<string | undefined> {
    if (target === row.baseRef) return undefined;
    const parents = store.db
      .select()
      .from(workspaces)
      .where(and(eq(workspaces.repoId, row.repoId), eq(workspaces.branch, row.baseRef), isNotNull(workspaces.remoteSha)))
      .all();
    const parent = parents.find((p) => p.state !== "archived") ?? parents.at(-1);
    const from =
      parent?.remoteSha ?? (await tryGit(cfg.path, ["rev-parse", "--verify", "--quiet", `refs/remotes/${REMOTE}/${row.baseRef}`]));
    if (!from) {
      throw new RebaseError(
        `${row.branch} cambió de base (${row.baseRef} -> ${target}) y no se sabe cuál fue la última punta de ${row.baseRef}: ` +
          "no hay un workspace suyo con push ni queda origin/" + row.baseRef + ".",
      );
    }
    if (!(await isAncestor(path, from, "HEAD"))) {
      throw new RebaseError(
        `La última punta de ${row.baseRef} (${from.slice(0, 9)}) no es ancestro de ${row.branch}: ya no está apilada sobre ella.`,
      );
    }
    return from;
  }

  function release(lease: Pick<WorkspaceLease, "workspaceId" | "runId" | "fencingToken">): void {
    stopHeartbeat(lease.workspaceId, lease.fencingToken);
    store.tx(({ db, emit }) => {
      const released = db
        .update(workspaces)
        .set({ state: "idle", holderRunId: null, leaseUntil: null })
        .where(
          and(
            eq(workspaces.id, lease.workspaceId),
            eq(workspaces.fencingToken, lease.fencingToken),
          ),
        )
        .returning({ id: workspaces.id })
        .get();
      if (released) {
        emit({
          type: "lease.released",
          origin: "core",
          runId: lease.runId,
          payload: {
            resource: "workspace",
            id: lease.workspaceId,
            token: lease.fencingToken,
          },
        });
      }
    });
  }

  async function discard(lease: Pick<WorkspaceLease, "workspaceId" | "runId" | "fencingToken">): Promise<"discarded" | "released"> {
    const row = store.db
      .select()
      .from(workspaces)
      .where(and(eq(workspaces.id, lease.workspaceId), eq(workspaces.fencingToken, lease.fencingToken)))
      .get();
    release(lease);
    if (!row) return "released";
    const cfg = repoConfig(row.repoId);
    return withRepoLock(row.repoId, async () => {
      if (row.remoteSha !== null || (await refExists(cfg, `refs/remotes/${REMOTE}/${row.branch}`))) return "released";
      const claimed = store.tx(({ db }) =>
        db.delete(workspaces).where(and(eq(workspaces.id, row.id), eq(workspaces.state, "idle"), isNull(workspaces.holderRunId))).returning({ id: workspaces.id }).get(),
      );
      if (!claimed) return "released";
      await tryGit(cfg.path, ["worktree", "unlock", row.path]);
      await tryGit(cfg.path, ["worktree", "remove", "--force", "--force", row.path]);
      await tryGit(cfg.path, ["branch", "-D", row.branch]);
      return "discarded";
    });
  }

  function recover(): number {
    const live = new Set(
      store.db
        .select({ id: runs.id })
        .from(runs)
        .where(inArray(runs.status, ["queued", "running", "waiting", "parked", "paused"]))
        .all()
        .map((r) => r.id),
    );
    const held = store.db
      .select()
      .from(workspaces)
      .where(and(isNotNull(workspaces.holderRunId), ne(workspaces.state, "archived")))
      .all();
    for (const row of held) {
      const runId = row.holderRunId!;
      if (!live.has(runId)) {
        // La corrida terminó sin soltar el worktree.
        release({ workspaceId: row.id, runId, fencingToken: row.fencingToken });
      } else if (row.state === "creating") {
        store.tx(({ db, emit }) => {
          db.update(workspaces).set({ holderRunId: null, leaseUntil: null }).where(eq(workspaces.id, row.id)).run();
          emit({
            type: "lease.expired",
            origin: "core",
            runId,
            payload: { resource: "workspace", id: row.id, runId, token: row.fencingToken },
          });
        });
      } else {
        renew(row.id, runId, row.fencingToken);
        startHeartbeat(row.id, runId, row.fencingToken);
      }
    }
    return held.length;
  }

  function extendLeases(): void {
    for (const { workspaceId, runId, token } of heartbeats.values()) renew(workspaceId, runId, token);
  }

  function handOver({ db, emit }: Tx, from: RunId, to: RunId): void {
    const held = db
      .select()
      .from(workspaces)
      .where(and(eq(workspaces.holderRunId, from), ne(workspaces.state, "archived")))
      .all();
    for (const row of held) {
      const token = row.fencingToken + 1;
      db.update(workspaces)
        .set({ holderRunId: to, leaseUntil: now() + leaseTtlMs, fencingToken: token })
        .where(eq(workspaces.id, row.id))
        .run();
      emit({ type: "lease.released", origin: "core", runId: from, payload: { resource: "workspace", id: row.id, token: row.fencingToken } });
      emit({ type: "lease.acquired", origin: "core", runId: to, payload: { resource: "workspace", id: row.id, runId: to, token } });
      startHeartbeat(row.id, to, token);
    }
  }

  /**
   * Un rebase detenido que dejó la corrida que tuvo el worktree antes (cancelada o fallida con el conflicto a
   * medias): nadie lo va a seguir, y con HEAD detached a mitad de camino la próxima corrida trabajaría (y
   * pushearía con lease) sobre una branch a medio rebasear. `--abort` la deja como estaba antes del rebase.
   */
  async function abortLeftoverRebase(path: string): Promise<void> {
    const inWorktree = (...args: string[]) => git(path, args);
    if (await rebaseInProgress(inWorktree)) await inWorktree("rebase", "--abort");
  }

  const gitAt = (cfg: RepoConfig): Git => (args, env, input) => git(cfg.path, args, env, input);

  /** La punta de cada padre (la de `origin` si hay, si no la local). */
  async function tipsOf(cfg: RepoConfig, parents: RestackCombinedOptions["parents"]): Promise<CombinedParent[]> {
    return Promise.all(parents.map(async ({ key, branch }) => ({ key, branch, sha: await resolveBase(cfg, branch) })));
  }

  function combinedRow(repoId: RepoId, branch: string) {
    return store.db.select().from(combinedBases).where(and(eq(combinedBases.repoId, repoId), eq(combinedBases.branch, branch))).get();
  }

  async function combineBase({ repo, issueId, branch, parents }: CombineRequest): Promise<CombineResult> {
    const cfg = repoConfig(repo);
    await assertBranchAllowed(cfg, branch);
    if (cfg.remote && (await fetchRepo(repo)) === "unauthorized") {
      throw githubUnauthorized(cfg.remote.account, `traer ${repo}`);
    }
    return withRepoLock(repo, async () => {
      const defaultSha = await resolveBase(cfg, cfg.defaultBranch);
      const tips = await tipsOf(cfg, parents);
      const plan = await planCombinedBase(gitAt(cfg), { onto: defaultSha, parents: tips, into: branch, identity: await identityOf(repo) });
      const previous = combinedRow(repo, branch);
      const values = { repoId: repo, branch, issueId, defaultSha, parents: tips };
      const save = (row: { headSha: string | null; status: "active" | "conflict" }) =>
        store.tx(({ db }) => db.insert(combinedBases).values({ ...values, ...row }).onConflictDoUpdate({ target: [combinedBases.repoId, combinedBases.branch], set: { ...values, ...row } }).run());
      if (plan.status === "conflict") {
        const known = previous?.status === "conflict" && JSON.stringify(previous.parents) === JSON.stringify(tips);
        save({ headSha: previous?.headSha ?? null, status: "conflict" });
        return { outcome: "base-conflict", parent: plan.parent.key, merged: plan.merged, files: plan.conflicts, failures: plan.failures, changed: !known };
      }
      await git(cfg.path, ["update-ref", `refs/heads/${branch}`, plan.head]);
      save({ headSha: plan.head, status: "active" });
      return { outcome: "combined", branch, head: plan.head, parents: tips };
    });
  }

  async function dissolveBase(repo: RepoId, branch: string): Promise<void> {
    const dissolved = store.tx(({ db }) =>
      db
        .update(combinedBases)
        .set({ status: "dissolved" })
        .where(and(eq(combinedBases.repoId, repo), eq(combinedBases.branch, branch), ne(combinedBases.status, "dissolved")))
        .returning({ branch: combinedBases.branch })
        .get(),
    );
    if (dissolved) await withRepoLock(repo, () => tryGit(repoConfig(repo).path, ["update-ref", "-d", `refs/heads/${branch}`]));
  }

  async function restackCombined(lease: WorkspaceRef, { council, branch, parents }: RestackCombinedOptions): Promise<RestackResult | BaseConflict> {
    const row = rowOf(lease);
    const cfg = repoConfig(row.repoId);
    const combined = combinedRow(row.repoId, branch);
    if (combined === undefined || combined.status === "dissolved") {
      throw new RebaseError(`${row.branch} no tiene una base combinada vigente (${branch}): no se sabe cuál fue la última punta de su base.`);
    }
    if (combined.headSha === null) throw new StaleCombinedBaseError(`La base combinada ${branch} nunca se armó: ${row.branch} no salió de ella.`);
    const defaultSha = await resolveBase(cfg, cfg.defaultBranch);
    const tips = await tipsOf(cfg, parents);
    const plan = tips.length === 0 ? { status: "ok" as const, head: defaultSha } : await planCombinedBase(gitAt(cfg), { onto: defaultSha, parents: tips, into: branch, identity: await identityOf(row.repoId) });
    // El PR sale de esta base si su historia trae la última punta registrada o, si un corte llegó entre el push y el registro, la que ya se recalculó.
    const head = await gitIn(lease, "rev-parse", "HEAD");
    if (!(await isAncestor(lease.path, combined.headSha, head)) && (plan.status === "conflict" || !(await isAncestor(lease.path, plan.head, head)))) {
      throw new StaleCombinedBaseError(`La última punta de la base combinada ${branch} (${combined.headSha.slice(0, 9)}) no está en la historia de ${row.branch}: el PR no salió de ella.`);
    }
    if (plan.status === "conflict") {
      store.tx(({ db }) => db.update(combinedBases).set({ status: "conflict" }).where(and(eq(combinedBases.repoId, row.repoId), eq(combinedBases.branch, branch))).run());
      return { outcome: "base-conflict", parent: plan.parent.key, merged: plan.merged, files: plan.conflicts, failures: plan.failures };
    }

    const result = await restack(lease, { council, onto: plan.head, from: combined.headSha, base: tips.length === 0 ? cfg.defaultBranch : branch });
    if (result.outcome !== "restacked" && result.outcome !== "uptodate") return result;
    if (tips.length === 0) {
      await dissolveBase(row.repoId, branch);
    } else {
      await withRepoLock(row.repoId, () => git(cfg.path, ["update-ref", `refs/heads/${branch}`, plan.head]));
      store.tx(({ db }) =>
        db.update(combinedBases).set({ defaultSha, parents: tips, headSha: plan.head, status: "active" }).where(and(eq(combinedBases.repoId, row.repoId), eq(combinedBases.branch, branch))).run(),
      );
    }
    return result;
  }

  async function reread(runId: RunId): Promise<void> {
    const held = store.db
      .select()
      .from(workspaces)
      .where(and(eq(workspaces.holderRunId, runId), eq(workspaces.state, "leased")))
      .all();
    for (const row of held) {
      await abortLeftoverRebase(row.path);
      const headSha = await git(row.path, ["rev-parse", "HEAD"]);
      store.tx(({ db }) =>
        db
          .update(workspaces)
          .set({ headSha })
          .where(and(eq(workspaces.id, row.id), eq(workspaces.fencingToken, row.fencingToken)))
          .run(),
      );
    }
  }

  return {
    acquire,
    attach,
    rebase,
    restack,
    combineBase,
    dissolveBase,
    restackCombined,
    push,
    recover,
    extendLeases,
    fetch: fetchRepo,
    baseSha,
    syncBase,
    release,
    discard,
    cleanup,
    handOver,
    reread,
    releaseHeldBy(runId) {
      const rows = store.db
        .select({ workspaceId: workspaces.id, fencingToken: workspaces.fencingToken })
        .from(workspaces)
        .where(and(eq(workspaces.holderRunId, runId), ne(workspaces.state, "archived")))
        .all();
      for (const row of rows) release({ ...row, runId });
    },
    held: (runId) =>
      store.db
        .select({
          workspaceId: workspaces.id,
          path: workspaces.path,
          branch: workspaces.branch,
          fencingToken: workspaces.fencingToken,
          base: workspaces.baseRef,
          repoId: workspaces.repoId,
        })
        .from(workspaces)
        .where(and(eq(workspaces.holderRunId, runId), eq(workspaces.state, "leased")))
        .get(),
    validate,
    git: gitIn,
    async exec(lease, command, { runId, stepId, env = {}, signal = new AbortController().signal }) {
      validate(lease);
      return execLogged({
        cwd: lease.path,
        command,
        env,
        logPath: stepLogPath(logDir, runId, stepId),
        signal,
        onSpawn: procs && ((child) => procs.track(child, { kind: "recipe", stepRunId: stepId })),
      });
    },
  };
}

/** `origin/main`, `refs/remotes/origin/main` y `refs/heads/main` son `main`. */
function normalizeBase(base: string): string {
  return base.replace(/^refs\/(heads|remotes)\//, "").replace(new RegExp(`^${REMOTE}/`), "");
}

export const WorkspaceAcquireArgs = z.object({
  repo: RepoId,
  branch: z.string(),
  base: z.string(),
});

/** El output de `workspace.acquire` (`$ws`), tal como lo reciben las acciones que operan sobre el worktree. */
export const WorkspaceOutput = z.object({
  workspaceId: z.string(),
  path: z.string(),
  branch: z.string(),
  /** La base al tomar el worktree: tras `workspace.syncBase` la vigente es `workspaces.baseSha(ws)`. */
  baseSha: z.string(),
  fencingToken: z.int(),
});

/**
 * La acción `workspace.acquire` para el motor de flujos (`registerAction`). El motor le pasa el
 * `runId` de la corrida en `ctx`; la salida es lo que los demás nodos leen como `$ws`. Una branch que
 * no se puede usar (`BranchNotAllowedError`) es `PermanentActionError`: reintentar no la cambia.
 */
export function workspaceAcquireAction(workspaces: Workspaces) {
  return {
    name: "workspace.acquire",
    args: WorkspaceAcquireArgs,
    outcomes: ["ok"],
    effects: "local" as const,
    async run(args: z.infer<typeof WorkspaceAcquireArgs>, ctx: { runId: RunId }) {
      let lease: WorkspaceLease;
      try {
        lease = await workspaces.acquire({ ...args, runId: ctx.runId });
      } catch (error) {
        if (error instanceof BranchNotAllowedError) throw new PermanentActionError(error.message, { cause: error });
        throw error;
      }
      const { workspaceId, path, branch, baseRef, baseSha, fencingToken } = lease;
      return { outcome: "ok", output: { workspaceId, path, branch, baseRef, baseSha, fencingToken } };
    },
  };
}

/**
 * La acción `workspace.attach` (`docs/design.html#d-flows`, carril maintenance): retoma el PR ya publicado
 * de `branch` con `workspaces.attach`. El output es un `$ws` más `fastForwarded`. Lo que `attach` no puede
 * hacer (no está en el remoto, adelantada o divergida) es `PermanentActionError`.
 */
export function workspaceAttachAction(workspaces: Workspaces): ActionDef<typeof WorkspaceAcquireArgs> {
  return {
    name: "workspace.attach",
    args: WorkspaceAcquireArgs,
    outcomes: ["ok"],
    effects: "local",
    async run(args, ctx: ActionCtx) {
      try {
        const { workspaceId, path, branch, baseRef, baseSha, fencingToken, fastForwarded } = await workspaces.attach({
          ...args,
          runId: ctx.runId,
        });
        return { outcome: "ok", output: { workspaceId, path, branch, baseRef, baseSha, fencingToken, fastForwarded } };
      } catch (error) {
        if (error instanceof AttachError || error instanceof BranchNotAllowedError) {
          throw new PermanentActionError(error.message, { cause: error });
        }
        throw error;
      }
    },
  };
}

const WorkspaceReleaseArgs = z.object({
  workspaceId: z.string(),
  fencingToken: z.int().positive(),
});

/** La acción `workspace.release`: suelta el worktree que `workspace.acquire` tomó, con su `$ws.workspaceId` y `$ws.fencingToken`. */
export function workspaceReleaseAction(workspaces: Workspaces) {
  return {
    name: "workspace.release",
    args: WorkspaceReleaseArgs,
    outcomes: ["ok"],
    effects: "local" as const,
    async run(args: z.infer<typeof WorkspaceReleaseArgs>, ctx: { runId: RunId }) {
      workspaces.release({ ...args, runId: ctx.runId });
      return { outcome: "ok" };
    },
  };
}

/**
 * La acción `workspace.discard`: como `workspace.release`, y si la branch nunca llegó al remoto borra el worktree y la
 * branch local (ver `Workspaces.discard`). Es el cierre de un flujo que falló antes de publicar.
 */
export function workspaceDiscardAction(workspaces: Workspaces) {
  return {
    name: "workspace.discard",
    args: WorkspaceReleaseArgs,
    outcomes: ["ok"],
    effects: "local" as const,
    async run(args: z.infer<typeof WorkspaceReleaseArgs>, ctx: { runId: RunId }) {
      await workspaces.discard({ ...args, runId: ctx.runId });
      return { outcome: "ok" };
    },
  };
}

const SyncBaseArgs = z.object({ ws: WorkspaceOutput });

/**
 * La acción `workspace.syncBase` (`docs/design.html#d-flows`, nodo sync). Outcomes `same`, `rebased` (el
 * flujo vuelve a correr los checks) y `conflict` (output `conflicts` y `failures`, lo que va al dev).
 * Lo que `syncBase` no puede hacer (commits propios, branch publicada) es `PermanentActionError`.
 */
export function workspaceSyncBaseAction(workspaces: Workspaces): ActionDef<typeof SyncBaseArgs> {
  return {
    name: "workspace.syncBase",
    args: SyncBaseArgs,
    outcomes: ["same", "rebased", "conflict"],
    effects: "local",
    // Una vez por visita: si el corte llega después del rebase, el reintento no ve un `same` porque la base ya se movió.
    run: ({ ws }, ctx: ActionCtx) =>
      ctx.once("sync", async () => {
        try {
          const { outcome, ...output } = await workspaces.syncBase(ws);
          return { outcome, output };
        } catch (error) {
          if (error instanceof SyncBaseError) throw new PermanentActionError(error.message, { cause: error });
          throw error;
        }
      }),
  };
}

const CombineBaseArgs = z.object({
  repo: RepoId,
  issueId: IssueId,
  /** La clave de la issue en su tracker: nombra la branch sintética (`clanker/base/<clave>`). */
  issueKey: z.string().min(1),
  parents: z.array(z.object({ key: z.string(), branch: z.string() })).min(2),
});

/**
 * La acción `workspace.combineBase` (`docs/design.html#d-ops`): `workspaces.combineBase` para un flujo. Outcome
 * `combined` (output `base`, la branch sintética que pasa a ser la `base` del `workspace.acquire`, y `head`) o
 * `conflict` (los padres chocan: output `parent`, `merged`, `files` y `failures`). Una branch que no se puede
 * usar es `PermanentActionError`. El Scheduler no pasa por aquí: arma la base antes de lanzar la corrida.
 */
export function workspaceCombineBaseAction(workspaces: Workspaces): ActionDef<typeof CombineBaseArgs> {
  return {
    name: "workspace.combineBase",
    args: CombineBaseArgs,
    outcomes: ["combined", "conflict"],
    effects: "local",
    async run({ repo, issueId, issueKey, parents }) {
      try {
        const result = await workspaces.combineBase({ repo, issueId, branch: combinedBaseBranch(issueKey), parents });
        if (result.outcome === "combined") return { outcome: "combined", output: { base: result.branch, head: result.head } };
        const { parent, merged, files, failures } = result;
        return { outcome: "conflict", output: { parent, merged, files, failures } };
      } catch (error) {
        if (error instanceof BranchNotAllowedError) throw new PermanentActionError(error.message, { cause: error });
        throw error;
      }
    },
  };
}

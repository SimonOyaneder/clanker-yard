import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { RunId } from "@clanker/api";
import { and, eq, inArray, isNotNull, isNull, lt, ne, or, sql } from "drizzle-orm";
import * as z from "zod";
import { type ActionCtx, type ActionDef, PermanentActionError } from "../flows/catalog";
import { git, GitError, isAncestor, pickEnv, tryGit, USER_REMOTE_ENV } from "../git/git";
import type { FetchOutcome, GitRemote, PushOutcome } from "../git/remote";
import { diffBetween, snapshotTree } from "../git/tree";
import { defaultLogDir, excerpt, execLogged, stepLogPath, type ExecResult } from "./exec";
import { newId } from "../store/conventions";
import type { Procs } from "../procs/procs";
import { runs, workspaces } from "../store/schema";
import type { Store } from "../store/store";

const REMOTE = "origin";
const WORKTREE_LOCK_REASON = "clanker-yard";

/** 2 min; el core renueva cada ttl/3. */
export const LEASE_TTL_MS = 120_000;

export interface RepoConfig {
  /** El checkout del usuario: de ahí cuelgan los worktrees y ahí se hace el fetch. */
  path: string;
  /** La branch por defecto nunca es de un workspace. */
  defaultBranch: string;
  /** Otras branches que ningún workspace puede usar. */
  protectedBranches?: string[];
  /** Raíz de los worktrees en lugar de `<dataDir>/worktrees`; relativa se resuelve contra `dataDir`. */
  worktreeDir?: string;
  /** Adónde y como quién se pushea; sin esto el repo no tiene `push` ni `fetch`. */
  remote?: {
    /** `https://github.com/<owner>/<repo>.git`: explícita, aunque `origin` sea SSH. */
    url: string;
    /** `owner/repo` en GitHub: donde `pr.publish` abre el PR. */
    repo: string;
    /** La cuenta de GitHub conectada cuyo token autentica. */
    account: string;
  };
}

export interface WorkspacesOptions {
  store: Store;
  /** Directorio de datos de la app (D3): ahí viven `worktrees/<repo>/<branch>`. */
  dataDir: string;
  /** Carpeta de los logs de comandos (`<logDir>/runs/<runId>/<stepId>.log`); por defecto `<dataDir>/logs`. */
  logDir?: string;
  repos: (repoId: string) => RepoConfig;
  /** Autor y committer de todo lo que corre `git` en un worktree. */
  identity: { name: string; email: string };
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
  repo: string;
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
  /** El worktree que `runId` tiene tomado: dónde corren sus agentes, su base y lo que hace falta para operar sobre él. */
  held(runId: RunId): (WorkspaceRef & { base: string }) | undefined;
  /**
   * Suelta los worktrees que `runId` aún tiene tomados: lo que queda al terminar una corrida cuyo flujo
   * no los soltó (`@done`, `@failed` o cancelada). Sin worktrees tomados no hace nada (la hija de un
   * subflujo usa el del padre, que es quien lo tiene).
   */
  releaseHeldBy(runId: RunId): void;
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
  fetch(repo: string): Promise<FetchOutcome>;
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
   * `apply --3way`. Con `conflict` las marcas quedan en los archivos. Sin `repos().remote` no hay fetch:
   * la base nueva es la que ya haya en el checkout. Reintentar tras un corte a medias retoma desde el respaldo.
   */
  syncBase(lease: WorkspaceRef): Promise<SyncBaseResult>;
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
  const { store, dataDir, repos, identity, remote, procs, worktreeSetup, leaseTtlMs = LEASE_TTL_MS, now = Date.now } = opts;
  const logDir = opts.logDir ?? defaultLogDir(dataDir);
  const heartbeats = new Map<string, { timer: NodeJS.Timeout; workspaceId: string; runId: RunId; token: number }>();
  const repoLocks = new Map<string, Promise<unknown>>();

  /** Un solo fetch o worktree add/remove a la vez por repo: tocan refs compartidas. */
  async function withRepoLock<T>(repoId: string, fn: () => Promise<T>): Promise<T> {
    const result = (repoLocks.get(repoId) ?? Promise.resolve()).then(fn);
    const tail = result.catch(() => undefined);
    repoLocks.set(repoId, tail);
    try {
      return await result;
    } finally {
      if (repoLocks.get(repoId) === tail) repoLocks.delete(repoId);
    }
  }

  function takeLease(db: Store["db"], id: string, runId: RunId) {
    const t = now();
    return db
      .update(workspaces)
      .set({
        holderRunId: runId,
        leaseUntil: t + leaseTtlMs,
        fencingToken: sql`${workspaces.fencingToken} + 1`,
      })
      .where(
        and(
          eq(workspaces.id, id),
          ne(workspaces.state, "archived"),
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

  function workspacePath(repoId: string, cfg: RepoConfig, branch: string): string {
    const root = cfg.worktreeDir ? resolve(dataDir, cfg.worktreeDir) : join(dataDir, "worktrees");
    return join(root, repoId, branch);
  }

  async function acquire({ repo, branch: rawBranch, base, runId }: AcquireRequest) {
    const cfg = repos(repo);
    const branch = rawBranch.replace(/^refs\/heads\//, "");
    await assertBranchAllowed(cfg, branch);
    const baseRef = normalizeBase(base);

    const claim = store.tx(({ db, emit }) => {
      const existing = db
        .select()
        .from(workspaces)
        .where(
          and(
            eq(workspaces.repoId, repo),
            eq(workspaces.branch, branch),
            ne(workspaces.state, "archived"),
          ),
        )
        .get();

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

  function remoteOf(repoId: string) {
    const target = repos(repoId).remote;
    if (!remote || !target) {
      throw new Error(`El repo ${repoId} no tiene remoto configurado (repos().remote y la opción remote): no se puede pushear ni fetchear.`);
    }
    return { remote, ...target };
  }

  async function push(lease: WorkspaceRef, { council = false } = {}): Promise<PushOutcome> {
    validate(lease);
    const row = store.db.select().from(workspaces).where(eq(workspaces.id, lease.workspaceId)).get()!;
    const { remote, url, account } = remoteOf(row.repoId);
    const sha = await git(lease.path, ["rev-parse", "HEAD"]);
    if (council && row.remoteSha && !(await isAncestor(lease.path, row.remoteSha, sha))) {
      throw new Error(
        `${lease.branch} tiene council y su HEAD ${sha.slice(0, 9)} no desciende de lo que hay en el remoto ` +
          `(${row.remoteSha.slice(0, 9)}): pushearlo sería un force push, que un PR con council no admite.`,
      );
    }
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
        .set({ headSha: sha, remoteSha: sha })
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
    validate(lease);
    return git(lease.path, args, {
      GIT_AUTHOR_NAME: identity.name,
      GIT_AUTHOR_EMAIL: identity.email,
      GIT_COMMITTER_NAME: identity.name,
      GIT_COMMITTER_EMAIL: identity.email,
    });
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

  async function fetchRepo(repo: string): Promise<FetchOutcome> {
    const { remote, url, account } = remoteOf(repo);
    return withRepoLock(repo, () => remote.fetch({ cwd: repos(repo).path, url, account }));
  }

  async function syncBase(lease: WorkspaceRef): Promise<SyncBaseResult> {
    const row = rowOf(lease);
    const cfg = repos(row.repoId);
    if (cfg.remote && (await fetchRepo(row.repoId)) === "unauthorized") {
      throw new SyncBaseError(
        `GitHub rechazó las credenciales de ${cfg.remote.account} al traer ${row.repoId}: la conexión quedó revocada, reconéctala.`,
      );
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

  return {
    acquire,
    push,
    recover,
    extendLeases,
    fetch: fetchRepo,
    baseSha,
    syncBase,
    release,
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
  repo: z.string(),
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

const WorkspaceReleaseArgs = z.object({
  workspaceId: z.string(),
  fencingToken: z.number().int().positive(),
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

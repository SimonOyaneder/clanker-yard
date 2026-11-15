import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import type { RunId } from "@clanker/api";
import { and, eq, isNull, lt, ne, or, sql } from "drizzle-orm";
import * as z from "zod";
import type { FetchOutcome, GitRemote, PushOutcome } from "../git/remote";
import { execLogged, type ExecResult } from "./exec";
import { newId } from "../store/conventions";
import { workspaces } from "../store/schema";
import type { Store } from "../store/store";

const execFileAsync = promisify(execFile);

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
  /** Suelta el lease y deja el worktree `idle`. No hace nada si el token ya no es el vigente. */
  release(lease: Pick<WorkspaceLease, "workspaceId" | "runId" | "fencingToken">): void;
  /** El worktree que `runId` tiene tomado: dónde corren sus agentes y su base. */
  held(runId: RunId): { path: string; base: string } | undefined;
  /** Lanza `StaleLeaseError` si `lease` ya no es el lease vigente del worktree. */
  validate(lease: WorkspaceRef): void;
  /**
   * Pushea `HEAD` a `refs/heads/<branch>` con `--force-with-lease` contra el `remote_sha` guardado, tras
   * validar el lease. Con `ok` el nuevo `remote_sha` queda guardado (también si el remoto ya tenía
   * ese commit). `lease-rejected` (otro pusheó) no se reintenta; `unauthorized` (401) deja la conexión
   * revocada.
   */
  push(lease: WorkspaceLease): Promise<PushOutcome>;
  /** Trae las branches del remoto a `refs/remotes/origin/*` con el mismo mecanismo que `push`. */
  fetch(repo: string): Promise<FetchOutcome>;
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

/** La branch no se puede usar como workspace; el mensaje dice por qué. */
export class BranchNotAllowedError extends Error {}

export function createWorkspaces(opts: WorkspacesOptions): Workspaces {
  const { store, dataDir, repos, identity, remote, leaseTtlMs = LEASE_TTL_MS, now = Date.now } = opts;
  const logDir = opts.logDir ?? join(dataDir, "logs");
  const heartbeats = new Map<string, NodeJS.Timeout>();
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
          or(isNull(workspaces.holderRunId), lt(workspaces.leaseUntil, t)),
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
    heartbeats.set(beatKey(workspaceId, token), timer);
    return lost.signal;
  }

  function stopHeartbeat(workspaceId: string, token: number): void {
    const key = beatKey(workspaceId, token);
    clearInterval(heartbeats.get(key));
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
        if (existing.holderRunId) {
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
      } else {
        ({ baseSha, remoteSha } = await withRepoLock(repo, () => createWorktree(cfg, row, claim.isNew)));
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
    if (hasRemote) await git(cfg.path, ["fetch", REMOTE]);
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
      await git(cfg.path, ["check-ref-format", "--branch", branch]);
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

  async function push(lease: WorkspaceLease): Promise<PushOutcome> {
    validate(lease);
    const row = store.db.select().from(workspaces).where(eq(workspaces.id, lease.workspaceId)).get()!;
    const { remote, url, account } = remoteOf(row.repoId);
    const sha = await git(lease.path, ["rev-parse", "HEAD"]);
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

  return {
    acquire,
    push,
    async fetch(repo) {
      const { remote, url, account } = remoteOf(repo);
      return withRepoLock(repo, () => remote.fetch({ cwd: repos(repo).path, url, account }));
    },
    release(lease) {
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
    },
    held: (runId) =>
      store.db
        .select({ path: workspaces.path, base: workspaces.baseRef })
        .from(workspaces)
        .where(and(eq(workspaces.holderRunId, runId), eq(workspaces.state, "leased")))
        .get(),
    validate,
    async git(lease, ...args) {
      validate(lease);
      return git(lease.path, args, {
        GIT_AUTHOR_NAME: identity.name,
        GIT_AUTHOR_EMAIL: identity.email,
        GIT_COMMITTER_NAME: identity.name,
        GIT_COMMITTER_EMAIL: identity.email,
      });
    },
    async exec(lease, command, { runId, stepId, env = {}, signal = new AbortController().signal }) {
      validate(lease);
      return execLogged({
        cwd: lease.path,
        command,
        env,
        logPath: join(logDir, "runs", runId, `${stepId}.log`),
        signal,
      });
    },
  };
}

/** `origin/main`, `refs/remotes/origin/main` y `refs/heads/main` son `main`. */
function normalizeBase(base: string): string {
  return base.replace(/^refs\/(heads|remotes)\//, "").replace(new RegExp(`^${REMOTE}/`), "");
}

async function git(cwd: string, args: string[], env: Record<string, string> = {}): Promise<string> {
  try {
    const { stdout } = await execFileAsync("git", args, {
      cwd,
      env: { ...process.env, ...env },
      encoding: "utf8",
    });
    return stdout.trimEnd();
  } catch (error) {
    const { stderr } = error as { stderr?: string };
    throw new Error(`git ${args.join(" ")} falló en ${cwd}: ${stderr?.trim() ?? String(error)}`, {
      cause: error,
    });
  }
}

/** `undefined` si git sale con error: para preguntas de existencia, donde el error es la respuesta. */
async function tryGit(cwd: string, args: string[]): Promise<string | undefined> {
  try {
    return await git(cwd, args);
  } catch {
    return undefined;
  }
}

export const WorkspaceAcquireArgs = z.object({
  repo: z.string(),
  branch: z.string(),
  base: z.string(),
});

/**
 * La acción `workspace.acquire` para el motor de flujos (`registerAction`). El motor le pasa el
 * `runId` de la corrida en `ctx`; la salida es lo que los demás nodos leen como `$ws`.
 */
export function workspaceAcquireAction(workspaces: Workspaces) {
  return {
    name: "workspace.acquire",
    args: WorkspaceAcquireArgs,
    outcomes: ["ok"],
    effects: "local" as const,
    async run(args: z.infer<typeof WorkspaceAcquireArgs>, ctx: { runId: RunId }) {
      const { workspaceId, path, branch, baseRef, baseSha, fencingToken } = await workspaces.acquire({
        ...args,
        runId: ctx.runId,
      });
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

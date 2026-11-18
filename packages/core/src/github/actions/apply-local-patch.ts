import { existsSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LocalPrPatch, RepoId } from "@clanker/api";
import { and, eq } from "drizzle-orm";
import * as z from "zod";
import { PermanentActionError, type ActionCtx, type ActionDef } from "../../flows/catalog";
import { git, GitError, tryGit } from "../../git/git";
import { combinedBases, pullRequests, repos, runs, workspaces } from "../../store/schema";
import type { Store } from "../../store/store";
import { WorkspaceOutput } from "../../workspaces/workspaces";
import { prById } from "../pr-rows";

const Args = LocalPrPatch.omit({ id: true }).extend({
  ws: WorkspaceOutput,
  prId: z.string().min(1),
  repo: RepoId,
  branch: z.string().min(1),
  base: z.string().min(1),
});
type Args = z.infer<typeof Args>;
type Git = (args: string[], env?: Record<string, string>, input?: string) => Promise<string>;

/**
 * `pr.applyLocalPatch { ws, prId, repo, branch, base, head, patch }`: agrega un commit al PR local desde
 * un diff unificado contra su punta exacta. El commit se prepara con un index temporal; solo mueve el
 * worktree con fast-forward, sin ejecutar hooks ni pisar archivos ignorados. No hace push ni restack.
 * `once` guarda el SHA del commit antes de mover la branch: si el core cae entre Git y SQLite, la
 * repetición reconoce esa punta exacta, sin aplicar de nuevo el patch ni adoptar otro commit.
 * Outcome `ok`, output `{ prId, head }`.
 */
export function prApplyLocalPatchAction({ store }: { store: Store }): ActionDef<typeof Args> {
  return {
    name: "pr.applyLocalPatch",
    args: Args,
    outcomes: ["ok"],
    effects: "local",
    async run(args, ctx) {
      const { ws, prId, head, branch, patch } = args;
      const registered = store.db.select({ path: repos.path }).from(repos).where(eq(repos.id, args.repo)).get();
      const run = store.db.select().from(runs).where(eq(runs.id, ctx.runId)).get();
      if (!registered || run?.subjectType !== "pr" || run.subjectId !== prId) {
        throw new PermanentActionError("La corrida no corresponde al PR local y su repo.");
      }
      assertTarget(store.db, args, ctx);
      const localGit: Git = (command, env, input) => git(ws.path, [
        "-c", "core.hooksPath=/dev/null", "-c", "core.fsmonitor=false",
        "-c", "submodule.recurse=false", "-c", "maintenance.auto=false", "-c", "gc.auto=0",
        ...command,
      ], { ...env, GIT_NO_LAZY_FETCH: "1" }, input);
      await assertManagedWorktree(localGit, registered.path, ws.path);

      const prepared = await ctx.once("prepare", async () => {
        assertHead(assertTarget(store.db, args, ctx), head);
        assertHead(await cleanHead(localGit, branch), head);
        return prepareCommit(localGit, head, patch, ctx.stepId);
      });

      const current = await cleanHead(localGit, branch);
      const recorded = assertTarget(store.db, args, ctx);
      if (current !== prepared) {
        assertHead(current, head);
        assertHead(recorded, head);
        try {
          await localGit(["merge", "--ff-only", "--no-autostash", "--no-overwrite-ignore", "--no-gpg-sign", "--no-verify-signatures", prepared]);
        } catch (error) {
          if (!(error instanceof GitError)) throw error;
          throw new PermanentActionError(`No se pudo avanzar el PR local: ${error.output.trim()}`, { cause: error });
        }
        assertHead(await localGit(["rev-parse", "HEAD"]), prepared);
      }

      store.tx(({ db, emit }) => {
        const tip = assertTarget(db, args, ctx);
        if (tip === prepared) return; // La tx se guardó antes de un corte, pero el paso no llegó a cerrar.
        assertHead(tip, head);
        db.update(pullRequests).set({ headSha: prepared, headChangedAt: Date.now() }).where(eq(pullRequests.id, prId)).run();
        db.update(workspaces).set({ headSha: prepared }).where(eq(workspaces.id, ws.workspaceId)).run();
        emit({
          type: "pr.changed", origin: "core", runId: ctx.runId,
          ...(run.projectId && { projectId: run.projectId }),
          subject: { type: "pr", id: prId }, payload: {},
        });
      });
      return { outcome: "ok", output: { prId, head: prepared } };
    },
  };
}

/** Comprueba el lease y el vínculo, nunca usa la ruta de un `ws` fabricado por otro flujo. */
function assertTarget(db: Store["db"], { prId, repo, branch, base, ws }: Args, ctx: ActionCtx): string {
  ctx.signal.throwIfAborted();
  const pr = prById(db, prId);
  if (!pr || !pr.owned || pr.state !== "local" || pr.repoId !== repo || pr.headRef !== branch || pr.baseRef !== base) {
    throw new PermanentActionError(`El PR ${prId} ya no es el PR local esperado (${branch} sobre ${base}).`);
  }
  const workspace = db.select().from(workspaces).where(eq(workspaces.id, ws.workspaceId)).get();
  if (!workspace || workspace.holderRunId !== ctx.runId || workspace.fencingToken !== ws.fencingToken ||
      workspace.state !== "leased" || workspace.path !== ws.path || workspace.branch !== branch ||
      workspace.branch !== ws.branch || workspace.repoId !== repo) {
    throw new PermanentActionError(`La corrida no tiene el lease vigente del worktree de ${branch}.`);
  }
  // La base de una fila local con base combinada es el primer padre, no la branch sintética del worktree.
  if (workspace.baseRef !== base) {
    const combined = db.select().from(combinedBases).where(and(
      eq(combinedBases.repoId, repo), eq(combinedBases.branch, workspace.baseRef),
    )).get();
    if (!combined || combined.status === "dissolved" || combined.issueId !== pr.issueId || combined.parents[0]?.branch !== base) {
      throw new PermanentActionError(`La base del worktree de ${branch} ya no corresponde al PR local.`);
    }
  }
  return pr.headSha;
}

async function assertManagedWorktree(git: Git, repoPath: string, path: string): Promise<void> {
  const repoCommon = await tryGit(repoPath, ["rev-parse", "--path-format=absolute", "--git-common-dir"]);
  const [root, gitDir, common] = (await git(["rev-parse", "--path-format=absolute", "--show-toplevel", "--absolute-git-dir", "--git-common-dir"])).split("\n");
  if (!root || !gitDir || !common || !repoCommon || realpathSync(root) !== realpathSync(path) ||
      realpathSync(repoPath) === realpathSync(path) || realpathSync(gitDir) === realpathSync(common) ||
      realpathSync(common) !== realpathSync(repoCommon)) {
    throw new PermanentActionError("El workspace no es un worktree separado del checkout del usuario.");
  }
}

async function cleanHead(git: Git, branch: string): Promise<string> {
  if ((await git(["rev-parse", "--symbolic-full-name", "HEAD"])) !== `refs/heads/${branch}`) {
    throw new PermanentActionError(`El worktree del PR no tiene activa la branch ${branch}.`);
  }
  const gitDir = await git(["rev-parse", "--absolute-git-dir"]);
  const operations = ["rebase-merge", "rebase-apply", "MERGE_HEAD", "CHERRY_PICK_HEAD", "REVERT_HEAD", "sequencer"];
  if (operations.some((file) => existsSync(join(gitDir, file))) ||
      (await git(["status", "--porcelain", "--untracked-files=all", "--ignore-submodules=none"])) !== "") {
    throw new PermanentActionError(`El worktree de ${branch} tiene cambios u operaciones en curso: no se aplicó el patch.`);
  }
  return git(["rev-parse", "HEAD"]);
}

function assertHead(actual: string, expected: string): void {
  if (actual !== expected) {
    throw new PermanentActionError(`La punta del PR cambió (esperada ${expected}, actual ${actual}). Vuelve a leer el PR y genera el patch de nuevo.`);
  }
}

async function prepareCommit(git: Git, head: string, patch: string, stepId: string): Promise<string> {
  const dir = mkdtempSync(join(tmpdir(), "clanker-patch-"));
  try {
    const env = { GIT_INDEX_FILE: join(dir, "index") };
    await git(["read-tree", head], env);
    try {
      await git(["-c", "apply.ignoreWhitespace=no", "apply", "--cached", "--whitespace=nowarn", "-"], env, patch);
    } catch (error) {
      if (!(error instanceof GitError)) throw error;
      throw new PermanentActionError(`El patch no se pudo aplicar a ${head}: ${error.output.trim()}`, { cause: error });
    }
    const tree = await git(["write-tree"], env);
    if (tree === await git(["rev-parse", `${head}^{tree}`])) {
      throw new PermanentActionError("El patch no cambia el árbol del PR local.");
    }
    try {
      return await git([
        "-c", "user.useConfigOnly=true", "commit-tree", tree, "--no-gpg-sign", "-p", head,
        "-m", "chore: apply local PR patch", "-m", `Clanker-Patch: ${stepId}`,
      ]);
    } catch (error) {
      if (!(error instanceof GitError)) throw error;
      throw new PermanentActionError(`No se pudo crear el commit local: ${error.output.trim()}`, { cause: error });
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

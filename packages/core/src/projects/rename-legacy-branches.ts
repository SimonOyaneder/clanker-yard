import type { BranchRename, IssueId, ProjectId, RenameLegacyInput } from "@clanker/api";
import { RequestError } from "@octokit/request-error";
import { and, eq, inArray } from "drizzle-orm";
import { existsSync } from "node:fs";
import type { Connections } from "../connections/connections";
import { git, tryGit } from "../git/git";
import { pullRequests, runs, workspaces } from "../store/schema";
import type { Store } from "../store/store";
import type { Issues } from "../tracker/issues";
import type { Repos } from "../workspaces/repos";
import { issueBranch } from "./branch-name";

export interface LegacyBranchRenamerDeps {
  store: Store;
  repos: Pick<Repos, "config">;
  issues: Pick<Issues, "get">;
  connections: Pick<Connections, "githubClient" | "markRevoked">;
}

export interface LegacyBranchRenamer {
  /**
   * Los PRs abiertos con branch `iss_...` (el id interno de la issue, como las nombraban las corridas viejas) pasan
   * a llamarse como el resto (`issueBranch`). Por PR, en este orden: la branch remota por la API de GitHub (que mueve
   * el PR y la base de los PRs apilados sobre ella), la local del worktree y su remote-tracking, y lo que el core guarda
   * con el nombre (workspaces, `head_ref` y `base_ref` de los PRs del repo, el `branch` de los params de las corridas
   * de la issue, para que una corrida nueva siga en la branch nueva). Una issue con una corrida viva se salta.
   * Con `dryRun` solo calcula `from → to`. Un error de un PR no frena a los demás.
   */
  renameLegacy(input: RenameLegacyInput): Promise<BranchRename[]>;
}

/** Estados en que una corrida sigue usando su branch (`runs_active_flow_subject`). */
const LIVE = ["queued", "running", "waiting", "parked", "paused"] as const;

export function createLegacyBranchRenamer({ store, repos, issues, connections }: LegacyBranchRenamerDeps): LegacyBranchRenamer {
  return {
    async renameLegacy({ projectId, dryRun = false }) {
      const open = store.db.select().from(pullRequests).where(eq(pullRequests.state, "open")).all();
      const results: BranchRename[] = [];
      for (const pr of open.filter((p) => p.headRef.startsWith("iss_")).sort((a, b) => a.number - b.number)) {
        const base = { repo: pr.repoId, number: pr.number, from: pr.headRef };
        const issue = issues.get((pr.issueId ?? pr.headRef) as IssueId);
        if (!issue) {
          results.push({ ...base, status: "skipped", reason: "la issue no está en el caché" });
          continue;
        }
        if (projectId !== undefined && issue.projectId !== (projectId as ProjectId)) continue;
        const live = store.db
          .select({ id: runs.id })
          .from(runs)
          .where(and(eq(runs.subjectType, "issue"), eq(runs.subjectId, issue.id), inArray(runs.status, LIVE)))
          .get();
        if (live) {
          results.push({ ...base, status: "skipped", reason: `la corrida ${live.id} sigue viva` });
          continue;
        }
        const config = repos.config(pr.repoId);
        if (!config.remote) {
          results.push({ ...base, status: "skipped", reason: "el repo no tiene remoto de GitHub" });
          continue;
        }
        try {
          const to = await issueBranch(store, issue, config.path);
          if (dryRun) {
            results.push({ ...base, to, status: "planned" });
            continue;
          }
          const [owner = "", name = ""] = config.remote.repo.split("/");
          try {
            await connections
              .githubClient(config.remote.account)
              .request("POST /repos/{owner}/{repo}/branches/{branch}/rename", { owner, repo: name, branch: pr.headRef, new_name: to });
          } catch (error) {
            if (error instanceof RequestError && error.status === 401) connections.markRevoked("github", config.remote.account, "core");
            throw error;
          }
          // GitHub ya movió el PR y sus hijos: el core se pone al día aunque falle lo local.
          store.tx(({ db }) => {
            db.update(workspaces).set({ branch: to }).where(and(eq(workspaces.repoId, pr.repoId), eq(workspaces.branch, pr.headRef))).run();
            db.update(pullRequests).set({ headRef: to }).where(and(eq(pullRequests.repoId, pr.repoId), eq(pullRequests.headRef, pr.headRef))).run();
            db.update(pullRequests).set({ baseRef: to }).where(and(eq(pullRequests.repoId, pr.repoId), eq(pullRequests.baseRef, pr.headRef))).run();
            for (const run of db.select({ id: runs.id, params: runs.params }).from(runs).where(and(eq(runs.subjectType, "issue"), eq(runs.subjectId, issue.id))).all()) {
              db.update(runs).set({ params: { ...run.params, branch: to } }).where(eq(runs.id, run.id)).run();
            }
          });
          try {
            await renameLocal(store, config.path, pr.repoId, pr.headRef, to);
          } catch (error) {
            results.push({ ...base, to, status: "failed", reason: `la branch remota y el core ya se llaman ${to}, pero la local no se renombró: ${(error as Error).message}` });
            continue;
          }
          results.push({ ...base, to, status: "renamed" });
        } catch (error) {
          results.push({ ...base, status: "failed", reason: (error as Error).message });
        }
      }
      return results;
    },
  };
}

/** `git branch -m` en el worktree que la tiene (o en el checkout), su upstream y su remote-tracking. Sin branch local no hace nada. */
async function renameLocal(store: Store, repoPath: string, repoId: string, from: string, to: string): Promise<void> {
  const worktree = store.db
    .select({ path: workspaces.path })
    .from(workspaces)
    .where(and(eq(workspaces.repoId, repoId), eq(workspaces.branch, to)))
    .all()
    .find((w) => existsSync(w.path));
  const cwd = worktree?.path ?? repoPath;
  if ((await tryGit(cwd, ["rev-parse", "--verify", "--quiet", `refs/heads/${from}`])) !== undefined) {
    await git(cwd, ["branch", "-m", from, to]);
    // `branch -m` mueve `branch.<from>.*` pero deja el upstream apuntando a la branch vieja.
    if ((await tryGit(cwd, ["config", "--get", `branch.${to}.merge`])) !== undefined) {
      await git(cwd, ["config", `branch.${to}.merge`, `refs/heads/${to}`]);
    }
  }
  const tracking = await tryGit(repoPath, ["rev-parse", "--verify", "--quiet", `refs/remotes/origin/${from}`]);
  if (tracking !== undefined) {
    await git(repoPath, ["update-ref", `refs/remotes/origin/${to}`, tracking]);
    await git(repoPath, ["update-ref", "-d", `refs/remotes/origin/${from}`]);
  }
}

import type { ProjectId, QueueEntry } from "@clanker/api";
import { and, eq, inArray, isNull } from "drizzle-orm";
import type { Prs } from "../github/prs";
import { ProjectNotFoundError, type Projects } from "../projects/projects";
import { pullRequests, runs } from "../store/schema";
import type { Store } from "../store/store";
import type { Issues } from "../tracker/issues";
import type { Tracker } from "../tracker/tracker";
import type { Repos } from "../workspaces/repos";
import { type QueuePrFact, tickDev } from "./queue";

/** El core no puede calcular la cola de este proyecto (no tiene el adapter de su tracker): el mensaje dice qué falta. */
export class QueueUnavailableError extends Error {}

export interface ProjectQueueDeps {
  store: Store;
  projects: Projects;
  issues: Issues;
  repos: Repos;
  /** Los adapters que este core conoce, por id de tracker. */
  trackers: Readonly<Record<string, Tracker>>;
  /** Solo se lee con `stackOn: "ci_green"`, para saber si el PR sigue abierto y si su CI está verde. */
  prs: Pick<Prs, "get">;
}

export interface ProjectQueue {
  /**
   * La cola del proyecto (`tickDev`) sobre el caché de issues, sus corridas dev y los PRs abiertos del
   * sistema de las issues bloqueantes. Lanza `ProjectNotFoundError` o `QueueUnavailableError`. No
   * escribe nada, así que la cola del caché es tan fresca como el último sync.
   */
  of(projectId: ProjectId): Promise<QueueEntry[]>;
}

export function createProjectQueue({ store, projects, issues, repos, trackers, prs }: ProjectQueueDeps): ProjectQueue {
  /** Los PRs abiertos del sistema de estas issues, con el CI de cada uno si el proyecto apila sobre CI verde. */
  async function prFacts(issueIds: readonly string[], readCi: boolean): Promise<QueuePrFact[]> {
    if (issueIds.length === 0) return [];
    const rows = store.db
      .select()
      .from(pullRequests)
      .where(and(eq(pullRequests.owned, true), eq(pullRequests.state, "open"), inArray(pullRequests.issueId, [...issueIds])))
      .all();
    const facts = await Promise.all(
      rows.map(async (row): Promise<QueuePrFact | undefined> => {
        const repo = repos.get(row.repoId);
        const fact = {
          issueId: row.issueId!,
          repoId: row.repoId,
          key: `${repo?.name ?? row.repoId}#${row.number}`,
          headRef: row.headRef,
          baseRef: row.baseRef,
        };
        if (!readCi) return { ...fact, ci: "not_green" };
        const remote = repo && repos.config(repo.id).remote;
        if (!remote) return { ...fact, ci: "unread", ciError: "el repo no tiene remoto de GitHub o no hay una cuenta conectada" };
        try {
          const pr = await prs.get({ account: remote.account, repo: remote.repo, number: row.number });
          if (pr.state === "merged" || pr.state === "closed") return undefined;
          return { ...fact, ci: pr.ci.state === "green" ? "green" : "not_green" };
        } catch (error) {
          return { ...fact, ci: "unread", ciError: (error as Error).message };
        }
      }),
    );
    return facts.filter((fact) => fact !== undefined);
  }

  return {
    async of(projectId) {
      const project = projects.get(projectId);
      if (!project) throw new ProjectNotFoundError(projectId);
      const tracker = trackers[project.tracker];
      if (!tracker) {
        throw new QueueUnavailableError(`Este core todavía no tiene un adapter de ${project.tracker}: no puede calcular la cola de ${project.slug}.`);
      }
      const all = issues.list();
      const byRef = new Map(all.map((issue) => [`${issue.ref.tracker}:${issue.ref.id}`, issue.id]));
      const blockerIds = new Set(
        all
          .filter((issue) => issue.projectId === project.id)
          .flatMap((issue) => issue.relations.blockedBy.flatMap((ref) => byRef.get(`${ref.tracker}:${ref.id}`) ?? [])),
      );
      const devRuns = store.db
        .select({ issueId: runs.subjectId, status: runs.status, outcome: runs.outcome })
        .from(runs)
        .where(and(eq(runs.projectId, project.id), eq(runs.subjectType, "issue"), eq(runs.lane, "dev"), isNull(runs.parentRunId)))
        .all();
      const [me, prs] = await Promise.all([tracker.viewer(), prFacts([...blockerIds], project.stackOn === "ci_green")]);
      return tickDev({ project, me, capabilities: tracker.capabilities, issues: all, runs: devRuns, prs });
    },
  };
}

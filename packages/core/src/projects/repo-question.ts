import type { ClankerProject, IssueId } from "@clanker/api";
import { and, desc, eq, isNull } from "drizzle-orm";
import { openDecision } from "../decisions/decisions";
import { decisions, runs } from "../store/schema";
import type { Store } from "../store/store";
import type { Repos } from "../workspaces/repos";
import { planIssue, repoOfRun, type IssuePlan } from "./issue-repos";

type ProjectRepos = Pick<ClankerProject, "id" | "repos">;

/** El título de la decisión que pregunta de qué repo es una issue ambigua; su sujeto es la issue. */
const QUESTION = "¿De qué repo es ";

/**
 * Los repos que el usuario eligió para sus issues ambiguas: la última respuesta de cada issue a la decisión
 * de `askWhichRepo`. La opción es el nombre del repo (o su id). Si la última respuesta ya no es de un repo
 * del proyecto, la issue sigue ambigua en vez de usar una respuesta anterior.
 */
export function chosenRepos(store: Store, repos: Repos, project: ProjectRepos): Map<IssueId, string> {
  const rows = store.db
    .select()
    .from(decisions)
    .where(and(eq(decisions.projectId, project.id), eq(decisions.kind, "question"), eq(decisions.status, "answered")))
    .orderBy(desc(decisions.id))
    .all();
  const chosen = new Map<IssueId, string>();
  const seen = new Set<string>();
  for (const row of rows) {
    if (row.subject?.type !== "issue" || !row.title.startsWith(QUESTION) || seen.has(row.subject.id)) continue;
    seen.add(row.subject.id);
    const option = (row.resolution as { option?: unknown } | null)?.option;
    const bound = project.repos.find(({ repoId }) => repoId === option || repos.get(repoId)?.name === option);
    if (bound) chosen.set(row.subject.id as IssueId, bound.repoId);
  }
  return chosen;
}

/**
 * Deja en la bandeja la pregunta de qué repo del proyecto es la issue (una `question` con los nombres de
 * los repos como opciones) si no hay una pendiente. Responderla la saca de `ambiguous` en el próximo tick.
 */
export function askWhichRepo(store: Store, repos: Repos, project: ProjectRepos & { slug: string }, issue: { id: IssueId; ref: { key: string } }): void {
  const subject = { type: "issue", id: issue.id } as const;
  store.tx((tx) => {
    const pending = tx.db
      .select({ id: decisions.id, subject: decisions.subject, title: decisions.title })
      .from(decisions)
      .where(and(eq(decisions.projectId, project.id), eq(decisions.kind, "question"), eq(decisions.status, "pending")))
      .all()
      .some((row) => row.subject?.id === issue.id && row.title.startsWith(QUESTION));
    if (pending) return;
    openDecision(tx, {
      kind: "question",
      projectId: project.id,
      subject,
      title: `${QUESTION}${issue.ref.key}?`,
      body: `Ningún label de ${issue.ref.key} calza con un repo del proyecto ${project.slug}. Elige el repo donde corre; si toca varios, agrega sus labels a \`repos\` con projects.update.`,
      options: project.repos.map(({ repoId }) => repos.get(repoId)?.name ?? repoId),
    });
  });
}

/** El plan de una issue con sus corridas dev y su elección, leídos del store. */
export function issuePlan(store: Store, repos: Repos, project: ProjectRepos, issue: { id: IssueId; labels: readonly string[] }): IssuePlan {
  const rows = store.db
    .select({ params: runs.params })
    .from(runs)
    .where(and(eq(runs.subjectType, "issue"), eq(runs.subjectId, issue.id), eq(runs.lane, "dev"), isNull(runs.parentRunId)))
    .all();
  const chosen = chosenRepos(store, repos, project).get(issue.id);
  return planIssue(project, issue.labels, chosen, rows.map((row) => ({ repoId: repoOfRun(row.params) })));
}

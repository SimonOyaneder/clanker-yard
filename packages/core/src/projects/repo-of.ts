import type { ClankerProject } from "@clanker/api";

/**
 * El repo de una issue: el primero de `project.repos` con algún label de la issue; si ninguno calza,
 * el primero. `undefined` si el proyecto no tiene repos.
 */
export function repoOf(project: Pick<ClankerProject, "repos">, labels: readonly string[]): string | undefined {
  const byLabel = project.repos.find((bound) => bound.labels.some((label) => labels.includes(label)));
  return (byLabel ?? project.repos[0])?.repoId;
}

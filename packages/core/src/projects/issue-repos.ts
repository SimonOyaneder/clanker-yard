import { type ClankerProject, RepoId } from "@clanker/api";

/**
 * Lo que una issue ya hizo en cada repo: el `repo` de los params de cada corrida dev raíz sobre ella
 * (`undefined` si su flujo no lo declara).
 */
export interface RepoRun {
  repoId?: RepoId;
}

/**
 * En qué repos corre una issue y cuál toca ahora (`docs/design.html#d-ops`, "Repo de la issue", decisión #6).
 *
 * - `ambiguous`: el proyecto tiene varios repos y ningún label de la issue calza con uno. Alguien debe elegir.
 * - `repos`: `repoIds` son los repos de la issue en el orden del proyecto. Un repo con label calzado entra
 *   siempre; si ninguno calza, el único del proyecto o el que se eligió. Con más de uno, la issue corre una
 *   vez por repo, encadenadas: `next` es el primero que aún no tiene corrida y `after` el repo de la corrida
 *   que debe terminar antes. Con uno o ninguno, cualquier corrida la cubre. `next` es `undefined` cuando ya
 *   no queda nada por lanzar.
 */
export type IssuePlan =
  | { kind: "ambiguous"; candidates: RepoId[] }
  | { kind: "repos"; repoIds: RepoId[]; next: { repoId: RepoId | undefined; after: string | undefined } | undefined };

export function planIssue(
  project: Pick<ClankerProject, "repos">,
  labels: readonly string[],
  /** El repo que se eligió en la decisión, si el proyecto no tiene uno para sus labels. */
  chosen: RepoId | undefined,
  runs: readonly RepoRun[],
): IssuePlan {
  const all: RepoId[] = project.repos.map((bound) => bound.repoId);
  let repoIds: RepoId[] = project.repos.filter((bound) => bound.labels.some((label) => labels.includes(label))).map((bound) => bound.repoId);
  if (repoIds.length === 0) {
    if (chosen !== undefined && all.includes(chosen)) repoIds = [chosen];
    else if (all.length > 1) return { kind: "ambiguous", candidates: all };
    else repoIds = all;
  }

  if (repoIds.length <= 1) {
    return { kind: "repos", repoIds, next: runs.length === 0 ? { repoId: repoIds[0], after: undefined } : undefined };
  }
  const index = repoIds.findIndex((repoId) => !runs.some((run) => run.repoId === repoId));
  return { kind: "repos", repoIds, next: index < 0 ? undefined : { repoId: repoIds[index], after: repoIds[index - 1] } };
}

/** El repo en que corrió una corrida: el `repo` de sus params, que `runs.start` fija desde el plan de la issue. */
/** El repo de una corrida, de sus params (`repo`), si es un id de repo válido. */
export const repoOfRun = (params: Record<string, unknown>): RepoId | undefined => {
  const parsed = RepoId.safeParse(params.repo);
  return parsed.success ? parsed.data : undefined;
};

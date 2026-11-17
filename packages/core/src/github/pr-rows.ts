import type { IssueId, PrRef, RepoId } from "@clanker/api";
import { and, asc, eq, inArray, isNotNull, ne, type SQL } from "drizzle-orm";
import { pullRequests } from "../store/schema";
import type { Repos } from "../repos/repos";
import type { Store } from "../store/store";
import type { PrRow } from "./pr-cache";

// Las lecturas de `pull_requests` que hacen los demás módulos (Watch, el Scheduler, la limpieza, las acciones):
// la forma de la fila es de `PrCache`, y lo que se pregunta de ella vive aquí, junto a él. Las escrituras siguen
// en las acciones que las hacen (`pr.publish`, el restack, `republish`), cada una dentro de su transacción.

type Db = Store["db"];

/** Una fila de un PR que ya está en GitHub: todas menos las `local`, que no tienen número (lo exige un CHECK de la tabla). */
export type GithubPrRow = PrRow & { number: number; nodeId: string };

/** Los PRs ya publicados en GitHub que cumplen `where`, en orden de número: la consulta deja fuera los `local`. */
export function githubPulls(db: Db, where?: SQL): GithubPrRow[] {
  return db
    .select()
    .from(pullRequests)
    .where(and(ne(pullRequests.state, "local"), where))
    .orderBy(asc(pullRequests.number))
    .all() as GithubPrRow[];
}

/**
 * El `PrRef` de GitHub de una fila: la cuenta y el `owner/name` salen del remoto de su repo. `undefined` si el PR es
 * `local` (sin número), o si el repo ya no está registrado o no tiene remoto (sin cuenta de GitHub conectada).
 */
export function prRefOf(repos: Pick<Repos, "get" | "config">, { repoId, number }: Pick<PrRow, "repoId" | "number">): PrRef | undefined {
  const remote = number !== null && repos.get(repoId) && repos.config(repoId).remote;
  return remote ? { account: remote.account, repo: remote.repo, number } : undefined;
}

/** El PR por su id interno (`pr_...`), sea del sistema o no. */
export function prById(db: Db, id: string): PrRow | undefined {
  return db.select().from(pullRequests).where(eq(pullRequests.id, id)).get();
}

/** El PR abierto de una branch del repo, si hay uno. */
export function openPrOfBranch(db: Db, repoId: RepoId, branch: string): GithubPrRow | undefined {
  return githubPulls(db, and(eq(pullRequests.repoId, repoId), eq(pullRequests.headRef, branch), eq(pullRequests.state, "open")))[0];
}

/** Todos los PRs de una branch del repo, abiertos o no (con squash una branch puede haber tenido varios). */
export function prsOfBranch(db: Db, repoId: RepoId, branch: string): Pick<PrRow, "state" | "headSha">[] {
  return db
    .select({ state: pullRequests.state, headSha: pullRequests.headSha })
    .from(pullRequests)
    .where(and(eq(pullRequests.repoId, repoId), eq(pullRequests.headRef, branch)))
    .all();
}

/** Los PRs abiertos que abrió el sistema para esas issues. */
export function openOwnedPrsOfIssues(db: Db, issueIds: readonly IssueId[]): PrRow[] {
  if (issueIds.length === 0) return [];
  return db
    .select()
    .from(pullRequests)
    .where(and(eq(pullRequests.owned, true), inArray(pullRequests.state, ["open", "local"]), inArray(pullRequests.issueId, [...issueIds])))
    .all();
}

/** Los PRs abiertos cuyo detalle ya se leyó alguna vez. */
export function openPrsWithDetail(db: Db): PrRow[] {
  return db
    .select()
    .from(pullRequests)
    .where(and(eq(pullRequests.state, "open"), isNotNull(pullRequests.detail)))
    .all();
}

/** Si el PR del repo tiene hold ("no mergear nunca"); un PR que el caché no conoce no lo tiene. */
export function prHold(db: Db, repoId: RepoId, number: number): boolean {
  return (
    db
      .select({ hold: pullRequests.hold })
      .from(pullRequests)
      .where(and(eq(pullRequests.repoId, repoId), eq(pullRequests.number, number)))
      .get()?.hold ?? false
  );
}

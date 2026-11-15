import { PrRef } from "@clanker/api";
import { RequestError } from "@octokit/request-error";
import { and, asc, eq } from "drizzle-orm";
import * as z from "zod";
import type { Connections } from "../connections/connections";
import { openDecision } from "../decisions/decisions";
import { PermanentActionError, type ActionDef } from "../flows/catalog";
import { git, GitError, isAncestor, tryGit } from "../git/git";
import { prParents, pullRequests } from "../store/schema";
import type { Store } from "../store/store";
import { AttachError, RebaseError, type RepoConfig, type Workspaces } from "../workspaces/workspaces";
import type { GitHubClient } from "./client";
import type { Prs } from "./prs";

// El restack de la cadena al mergear un padre (`docs/design.html#d-ops`, restack): `stack.restack`.

export interface StackRestackDeps {
  store: Store;
  workspaces: Workspaces;
  repos: (repoId: string) => RepoConfig;
  prs: Pick<Prs, "get">;
  connections: Pick<Connections, "githubClient" | "markRevoked">;
  /** Espera entre las relecturas de `mergeable` (10 s); los tests la reemplazan. */
  pause?: (ms: number) => Promise<void>;
}

const RestackArgs = z.object({ pr: PrRef });

/** Qué pasó con un hijo (o nieto) del PR mergeado. */
export type ChildReport = { pr: PrRef; branch: string } & (
  | { status: "restacked"; previousHead: string; head: string; commits: number; draft: boolean }
  | { status: "uptodate" }
  | { status: "conflict"; files: string[]; failures: string }
  | { status: "skipped"; reason: string }
);

type PrRow = typeof pullRequests.$inferSelect;

/** Lo que se parte de un padre para restackear a sus hijos: la última punta de su branch, la base nueva (o el sha de su punta) y su nombre. */
interface Start {
  from: string;
  onto?: string;
  base: string;
}

/** Lo que `stack.restack` lee de un PR de la API REST. */
const Pull = z.object({ number: z.int(), base: z.object({ ref: z.string() }), body: z.string().nullable(), mergeable: z.boolean().nullable() });

/** Cuántas veces se vuelve a preguntar por un `mergeable` que GitHub aún calcula (`null`). */
const MERGEABLE_RETRIES = 3;
const MERGEABLE_WAIT_MS = 10_000;

/**
 * `stack.restack { pr }` (`docs/design.html#d-ops`, restack): `pr` es un PR del sistema ya mergeado. Sus
 * hijos (`pr_parents`) quedan sobre la base donde se mergeó, uno por uno y recursivo por sus propios
 * hijos, cada etapa con `ctx.once` para que un reintento retome donde quedó:
 *
 * - El `merge_commit_sha` sale de la API (`prs.get`, no del log) y se verifica contra la branch con
 *   `merge-tree` (`merge.squash`: `same`, `differs` o `unknown`; un squash distinto no impide el restack
 *   porque lo que cuenta es lo que quedó en la base).
 * - Por hijo: `workspaces.attach` (crea el worktree desde la branch remota si no hay) y
 *   `workspaces.restack`: commits propios sin los merges de la base (los de release-bot[bot]), mismo
 *   patch-id, push con lease. Después, el cambio de base del PR si GitHub no lo hizo y, si su cuerpo
 *   nombra la base vieja, una nota no bloqueante ("descripción obsoleta"). Los nietos parten de la
 *   punta que el hijo tenía antes y de la nueva.
 * - Un hijo que no se puede restackear queda como estaba y no frena a los demás: `conflict` (la branch
 *   intacta, y un evento `pr.changed` con `kind: "restack_conflict"` para el flujo de rebase) o
 *   `skipped` con su razón (council, merge de otra branch, lease rechazado, branch adelantada, sin
 *   commits propios). Sus propios hijos no se tocan: su base no se movió.
 * - Al final relee `mergeable` de todos los PRs abiertos del repo: GitHub lo calcula aparte, y es lo
 *   que Watch verá.
 *
 * Outcomes: `ok` y `conflict` (algún hijo quedó para el flujo de rebase). Output: `merge`, `children`
 * (en orden de recorrido), `changedDrafts` (los PRs en draft que se pushearon: piden /review otra
 * vez) y `mergeable`. Un PR que no está en `pull_requests` o no tiene hijos da `ok` sin nada.
 */
export function stackRestackAction(deps: StackRestackDeps): ActionDef<typeof RestackArgs> {
  const { store, workspaces, prs } = deps;
  const pause = deps.pause ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));

  return {
    name: "stack.restack",
    args: RestackArgs,
    outcomes: ["ok", "conflict"],
    effects: "remote",
    async run({ pr }, ctx) {
      const found = rowOf(deps, pr);
      if (!found) return { outcome: "ok", output: { children: [], changedDrafts: [], mergeable: [] } };
      const { row: parentRow, repoId, remote } = found;
      const client = deps.connections.githubClient(remote.account);
      const github = <T>(call: () => Promise<T>) => withGitHub(deps, remote.account, call);
      const [owner = "", name = ""] = remote.repo.split("/");
      const pull = (number: number) => ({ owner, repo: name, pull_number: number });

      const merged = await ctx.once("merged", async () => {
        const state = await prs.get(pr);
        if (state.state !== "merged" || state.mergeCommitSha === undefined) {
          throw new PermanentActionError(`El PR #${pr.number} de ${pr.repo} no está mergeado (${state.state}): no hay nada que restackear.`);
        }
        return { headRef: state.headRef, headSha: state.headSha, baseRef: state.baseRef, sha: state.mergeCommitSha };
      });
      const squash = await ctx.once("verify", async () => {
        if ((await workspaces.fetch(repoId)) === "unauthorized") {
          throw new Error(`GitHub rechazó el token de ${remote.account}: reconecta la cuenta para restackear ${pr.repo}.`);
        }
        return verifyMerge(deps.repos(repoId).path, merged);
      });

      const children: ChildReport[] = [];

      async function restackChildren(parent: PrRow, start: Start, direct: boolean): Promise<void> {
        for (const child of childrenOf(store, parent.id)) {
          const stage = await ctx.once(`restack:${child.number}`, () => restackChild(child, start));
          const { report } = stage;
          if (report.status === "restacked" || report.status === "uptodate") {
            const head = report.status === "restacked" ? report.head : undefined;
            await ctx.once(`retarget:${child.number}`, () => retarget(child, parent, start.base, head, direct));
          }
          children.push(report);
          if (stage.next) await restackChildren(child, stage.next, false);
        }
      }

      async function restackChild(child: PrRow, start: Start): Promise<{ report: ChildReport; next?: Start }> {
        const childRef: PrRef = { account: remote.account, repo: remote.repo, number: child.number };
        const base = { pr: childRef, branch: child.headRef };
        const skipped = (reason: string) => ({ report: { ...base, status: "skipped" as const, reason } });

        const state = await prs.get(childRef);
        if (state.threads.councilEver) return skipped("tiene threads [clanker-council]: un restack reescribiría su historia y nunca se fuerza.");
        if (state.state === "merged" || state.state === "closed") return skipped(`el PR ya está ${state.state === "merged" ? "mergeado" : "cerrado"}.`);

        let lease;
        try {
          lease = await workspaces.attach({ repo: repoId, branch: child.headRef, base: start.base, runId: ctx.runId });
        } catch (error) {
          if (error instanceof AttachError) return skipped(error.message);
          throw error;
        }
        try {
          const onto = start.onto ?? (await workspaces.git(lease, "rev-parse", `refs/remotes/origin/${start.base}`));
          const result = await workspaces.restack(lease, { council: false, onto, from: start.from, base: start.base });
          switch (result.outcome) {
            case "restacked":
              return {
                report: { ...base, status: "restacked", previousHead: result.previousHead, head: result.head, commits: result.commits, draft: state.state === "draft" },
                next: { from: result.previousHead, onto: result.head, base: child.headRef },
              };
            case "uptodate":
              return { report: { ...base, status: "uptodate" } };
            case "conflict":
              store.tx(({ emit }) =>
                emit({
                  type: "pr.changed",
                  origin: "core",
                  runId: ctx.runId,
                  subject: { type: "pr", id: child.id },
                  payload: { kind: "restack_conflict", repo: remote.repo, number: child.number, base: start.base, from: start.from, onto, files: result.conflicts },
                }),
              );
              return { report: { ...base, status: "conflict", files: result.conflicts, failures: result.failures } };
            case "foreign-merge":
              return skipped(result.failures);
            case "empty":
              return skipped(`no le quedan commits propios sobre ${start.base}.`);
            case "lease-rejected":
              return skipped(`${child.headRef} ya no está donde el core la dejó en el remoto: alguien más pusheó.`);
            case "unauthorized":
              throw new Error(`GitHub rechazó el token de ${remote.account}: reconecta la cuenta para pushear ${child.headRef}.`);
          }
        } catch (error) {
          if (error instanceof RebaseError) return skipped(error.message);
          throw error;
        } finally {
          workspaces.release(lease);
        }
      }

      /**
       * Lo que queda tras el push de un hijo. Si colgaba del PR mergeado (`direct`): la base del PR en
       * GitHub, si GitHub no la movió, y el registro local, que ya no lo cuelga de él. Un hijo cuyo
       * cuerpo nombra la base vieja deja una nota.
       */
      async function retarget(child: PrRow, parent: PrRow, base: string, head: string | undefined, direct: boolean): Promise<null> {
        const stale = direct
          ? await github(async () => {
              const current = Pull.parse((await client.request("GET /repos/{owner}/{repo}/pulls/{pull_number}", pull(child.number))).data);
              if (current.base.ref !== base) await client.request("PATCH /repos/{owner}/{repo}/pulls/{pull_number}", { ...pull(child.number), base });
              return mentionsBase(current.body, merged.headRef, parent.number);
            })
          : false;
        store.tx((tx) => {
          tx.db
            .update(pullRequests)
            .set({ ...(direct && { baseRef: base }), ...(head !== undefined && { headSha: head }) })
            .where(eq(pullRequests.id, child.id))
            .run();
          if (direct) tx.db.delete(prParents).where(and(eq(prParents.childId, child.id), eq(prParents.parentId, parent.id))).run();
          if (stale) {
            openDecision(tx, {
              kind: "review_note",
              title: `Descripción obsoleta en ${remote.repo}#${child.number}`,
              body: `El cuerpo del PR nombra ${merged.headRef} (#${parent.number}), que ya se mergeó: ahora el PR va sobre ${base}. Actualiza la descripción.`,
              runId: ctx.runId,
              subject: { type: "pr", id: child.id },
            });
          }
        });
        return null;
      }

      await restackChildren(parentRow, { from: merged.headSha, base: merged.baseRef }, true);
      const mergeable = await ctx.once("mergeable", () => github(() => readMergeable(client, { owner, repo: name }, pause)));
      const changedDrafts = children.flatMap((child) => (child.status === "restacked" && child.draft ? [child.pr] : []));
      return {
        outcome: children.some((child) => child.status === "conflict") ? "conflict" : "ok",
        output: { merge: { sha: merged.sha, squash }, children, changedDrafts, mergeable },
      };
    },
  };
}

/** La fila de `pull_requests` de `pr` (el repo se reconoce por su `owner/repo` de GitHub) con su repo y remoto. */
function rowOf(deps: StackRestackDeps, pr: PrRef) {
  for (const row of deps.store.db.select().from(pullRequests).where(eq(pullRequests.number, pr.number)).all()) {
    const { remote } = deps.repos(row.repoId);
    if (remote?.repo === pr.repo) return { row, repoId: row.repoId, remote };
  }
  return undefined;
}

/** Los PRs abiertos que cuelgan de `parentId`, en orden de número. */
function childrenOf(store: Store, parentId: string): PrRow[] {
  return store.db
    .select({ child: pullRequests })
    .from(prParents)
    .innerJoin(pullRequests, eq(prParents.childId, pullRequests.id))
    .where(and(eq(prParents.parentId, parentId), eq(pullRequests.state, "open")))
    .orderBy(asc(pullRequests.number))
    .all()
    .map((row) => row.child);
}

/**
 * Comprueba el `merge_commit_sha` en `path` (ya con el fetch hecho): tiene que estar en `origin/<base>`, y su
 * árbol se compara con el de fusionar la punta final de la branch en lo que había antes del merge
 * (`merge-tree`). `unknown` si falta algún commit en el repo local.
 */
async function verifyMerge(path: string, merge: { sha: string; headSha: string; baseRef: string }): Promise<"same" | "differs" | "unknown"> {
  if (!(await isAncestor(path, merge.sha, `refs/remotes/origin/${merge.baseRef}`))) {
    throw new PermanentActionError(`El merge ${merge.sha.slice(0, 9)} no está en origin/${merge.baseRef}: no se puede restackear sobre algo que la base no tiene.`);
  }
  const before = await tryGit(path, ["rev-parse", "--verify", "--quiet", `${merge.sha}^`]);
  if (before === undefined || (await tryGit(path, ["rev-parse", "--verify", "--quiet", `${merge.headSha}^{commit}`])) === undefined) return "unknown";
  try {
    const tree = (await git(path, ["merge-tree", "--write-tree", before, merge.headSha])).split("\n")[0];
    return tree === (await git(path, ["rev-parse", `${merge.sha}^{tree}`])) ? "same" : "differs";
  } catch (error) {
    if (error instanceof GitError) return "differs"; // `merge-tree` sale con 1 si choca: la branch no cabría igual sobre la base.
    throw error;
  }
}

/** El cuerpo nombra la branch del PR mergeado o su número (`#12`, no `#123`). */
function mentionsBase(body: string | null, branch: string, number: number): boolean {
  return (body ?? "").includes(branch) || new RegExp(`(?<![\\w/])#${number}(?!\\d)`).test(body ?? "");
}

/**
 * `mergeable` de cada PR abierto del repo. GitHub lo calcula al pedirlo: los que vienen en `null` se
 * vuelven a leer tras `MERGEABLE_WAIT_MS`, hasta `MERGEABLE_RETRIES` veces; el que sigue sin respuesta queda en `null`.
 */
async function readMergeable(
  client: GitHubClient,
  { owner, repo }: { owner: string; repo: string },
  pause: (ms: number) => Promise<void>,
): Promise<{ number: number; mergeable: boolean | null }[]> {
  const open: number[] = [];
  for (let page = 1; ; page++) {
    const { data } = await client.request("GET /repos/{owner}/{repo}/pulls", { owner, repo, state: "open", per_page: 100, page });
    const numbers = z.array(z.object({ number: z.int() })).parse(data).map((p) => p.number);
    open.push(...numbers);
    if (numbers.length < 100) break;
  }
  const result = new Map<number, boolean | null>(open.sort((a, b) => a - b).map((number) => [number, null]));
  for (let attempt = 0; attempt <= MERGEABLE_RETRIES; attempt++) {
    const unknown = [...result].filter(([, mergeable]) => mergeable === null).map(([number]) => number);
    if (unknown.length === 0) break;
    if (attempt > 0) await pause(MERGEABLE_WAIT_MS);
    for (const number of unknown) {
      const { data } = await client.request("GET /repos/{owner}/{repo}/pulls/{pull_number}", { owner, repo, pull_number: number });
      result.set(number, Pull.parse(data).mergeable);
    }
  }
  return [...result].map(([number, mergeable]) => ({ number, mergeable }));
}

/** Una llamada a GitHub; un 401 deja la conexión `revoked` y se relanza. */
async function withGitHub<T>(deps: Pick<StackRestackDeps, "connections">, account: string, call: () => Promise<T>): Promise<T> {
  try {
    return await call();
  } catch (error) {
    if (error instanceof RequestError && error.status === 401) deps.connections.markRevoked("github", account, "core");
    throw error;
  }
}

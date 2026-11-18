import { PrRef, type RepoId } from "@clanker/api";
import { and, asc, eq, inArray, ne } from "drizzle-orm";
import * as z from "zod";
import type { Connections } from "../../connections/connections";
import { openDecision } from "../../decisions/decisions";
import { githubUnauthorized } from "../../breakers/breakers";
import { PermanentActionError, type ActionCtx, type ActionDef } from "../../flows/catalog";
import { git, GitError, isAncestor, tryGit } from "../../git/git";
import { combinedBases, prParents, pullRequests } from "../../store/schema";
import type { Store } from "../../store/store";
import { emitOnce } from "../marks";
import { AttachError, RebaseError, StaleCombinedBaseError, type BaseConflict, type RestackResult, type Workspaces, type WorkspaceRef } from "../../workspaces/workspaces";
import type { GitHubClient } from "../client";
import type { Prs } from "../prs";
import type { PrRow } from "../pr-cache";
import { githubPulls } from "../pr-rows";
import { landedCommit } from "../landed";
import { liveCombinedParents } from "../combined-parents";
import type { RepoConfig } from "../../repos/repos";

// El restack de la cadena (`docs/design.html#d-ops`, restack y restackRewritten): `stack.restack` al mergear un
// padre y `stack.restackRewritten` cuando se reescribe su branch.

export interface StackRestackDeps {
  store: Store;
  workspaces: Workspaces;
  repoConfig: (repoId: RepoId) => RepoConfig;
  prs: Pick<Prs, "get">;
  connections: Pick<Connections, "githubClient">;
  /** Espera entre las relecturas de `mergeable` (10 s); los tests la reemplazan. */
  pause?: (ms: number) => Promise<void>;
}

const RestackArgs = z.object({ pr: PrRef });
const RestackRewrittenArgs = z.object({ pr: PrRef, from: z.string().min(1), to: z.string().min(1) });

/** Un PR en draft que se pusheó: con su branch y su base, un flujo toma de ahí su worktree (`workspace.attach`). */
export type ChangedDraft = { pr: PrRef; branch: string; base: string };

/** Un PR local (sin GitHub) que el restack dejó sobre la branch por defecto: ya se puede publicar (`pr.promote`). */
export type Promotable = { prId: string; branch: string; base: string };

/**
 * Qué pasó con un hijo (o nieto) del PR mergeado. `base` es la branch sobre la que quedó. `prId` es su fila de
 * `pull_requests`; `pr` solo existe si el hijo ya está en GitHub (un PR `local` no tiene número).
 */
export type ChildReport = { prId: string; pr?: PrRef; branch: string } & (
  | { status: "restacked"; previousHead: string; head: string; commits: number; draft: boolean; base: string }
  | { status: "uptodate" }
  | { status: "conflict"; files: string[]; failures: string }
  | { status: "skipped"; reason: string }
);

type CombinedBase = typeof combinedBases.$inferSelect;

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
 * - Un PR que la cola de merge del pack (`merge.via: "comment"`, como bors) cerró sin mergear cuenta como mergeado en
 *   el commit de la base que ya trae su contenido (`landedCommit`).
 * - El `merge_commit_sha` sale de la API (`prs.get`, no del log) y se verifica contra la branch con
 *   `merge-tree` (`merge.squash`: `same`, `differs` o `unknown`; un squash distinto no impide el restack
 *   porque lo que cuenta es lo que quedó en la base).
 * - Por hijo: `workspaces.attach` (crea el worktree desde la branch remota si no hay) y
 *   `workspaces.restack`: commits propios sin los merges de la base (los de release-bot[bot]), mismo
 *   patch-id, push con lease. Después, el cambio de base del PR si GitHub no lo hizo y, si su cuerpo
 *   nombra la base vieja, una nota no bloqueante ("descripción obsoleta"). Los nietos parten de la
 *   punta que el hijo tenía antes y de la nueva.
 * - Un hijo con base combinada (`combined_bases`, ver `workspaces.restackCombined`) no usa el `from` ni el `onto`
 *   del padre: recalcula la base con los padres que siguen abiertos y el PR pasa a apuntar al primero (o a la
 *   branch por defecto si no queda ninguno). Su conflicto no dispara `pr.conflict`: queda una nota para una persona.
 * - Un hijo que no se puede restackear queda como estaba y no frena a los demás: `conflict` (la branch
 *   intacta, y un evento `pr.conflict` para el flujo de rebase) o
 *   `skipped` con su razón (council, merge de otra branch, lease rechazado, branch adelantada, sin
 *   commits propios). Sus propios hijos no se tocan: su base no se movió.
 * - Un hijo `local` (stacks locales) se restackea solo en la máquina: sin `prs.get`, sin push y sin tocar su PR en
 *   GitHub (no tiene); los que quedan sobre la branch por defecto salen en `promotable`, listos para `pr.promote`.
 * - Al final relee `mergeable` de todos los PRs abiertos del repo: GitHub lo calcula aparte, y es lo
 *   que Watch verá.
 *
 * Outcomes: `ok` y `conflict` (algún hijo quedó para el flujo de rebase). Output: `merge`, `children`
 * (en orden de recorrido), `changedDrafts` (los PRs en draft que se pushearon, cada uno como `{ pr, branch, base }`: piden /review otra
 * vez), `promotable` (`{ prId, branch, base }` de cada PR local que quedó sobre la branch por defecto) y `mergeable`. Un PR que no está en `pull_requests` o no tiene hijos da `ok` sin nada.
 */
export function stackRestackAction(deps: StackRestackDeps): ActionDef<typeof RestackArgs> {
  return {
    name: "stack.restack",
    args: RestackArgs,
    outcomes: ["ok", "conflict"],
    effects: "remote",
    async run({ pr }, ctx) {
      const found = rowOf(deps, pr);
      if (!found) return { outcome: "ok", output: NOTHING };

      const merged = await ctx.once("merged", async () => {
        const state = await deps.prs.get(pr);
        if (state.state === "merged" && state.mergeCommitSha !== undefined) {
          return { headRef: state.headRef, headSha: state.headSha, baseRef: state.baseRef, sha: state.mergeCommitSha };
        }
        // Una cola de merge (bors) lo cerró sin mergearlo: vale como merge en el commit de la base que trae su contenido.
        // Solo donde el pack mergea con un comando a su cola (`merge.via: "comment"`).
        if (state.state === "closed" && state.merge.via === "comment") {
          await fetchOrThrow(deps, found, pr.repo, "restackear");
          const { path, defaultBranch } = deps.repoConfig(found.repoId);
          const landed = state.baseRef === defaultBranch ? await landedCommit(path, { headSha: state.headSha, defaultBranch }) : undefined;
          if (landed) return { headRef: state.headRef, headSha: state.headSha, baseRef: state.baseRef, sha: landed };
        }
        throw new PermanentActionError(`El PR #${pr.number} de ${pr.repo} no está mergeado (${state.state}): no hay nada que restackear.`);
      });
      const squash = await ctx.once("verify", async () => {
        await fetchOrThrow(deps, found, pr.repo, "restackear");
        return verifyMerge(deps.repoConfig(found.repoId).path, merged);
      });

      const chain = await restackChain(deps, ctx, found, { from: merged.headSha, base: merged.baseRef }, merged.headRef);
      return { outcome: chain.outcome, output: { merge: { sha: merged.sha, squash }, ...chain.output } };
    },
  };
}

/**
 * `stack.restackRewritten { pr, from, to }` (`docs/design.html#d-ops`, restackRewritten): la branch de `pr`
 * (un PR del sistema abierto) se reescribió y su punta pasó de `from` a `to` (el `pr.base_rewritten` de
 * Watch, que ya no espera a que alguien avise). Es `stack.restack` con la punta vieja como padre: los
 * hijos de `pr` se restackean sobre `to` con sus commits propios (los de `from..HEAD`), el mismo
 * patch-id y push con lease, y de ahí en adelante todo igual (nietos, `conflict`, `skipped`,
 * `changedDrafts`, `mergeable`). Sigue colgando de `pr`: su base no cambia, solo su punta. Es también lo que
 * restackea los hijos de un PR que `stack.restack` dejó en conflicto, cuando el flujo de rebase lo resuelve
 * y lo pushea.
 *
 * Idempotente: un hijo ya sobre `to` (p. ej. porque `stack.restack` lo restackeó en cadena) da `uptodate`.
 * Sin hijos abiertos no toca nada, ni siquiera hace fetch. Lanza si `pr` ya no está abierto (si se mergeó, el
 * restack de sus hijos es de `stack.restack`) o si `from` no está en el repo local (Watch no emite el
 * evento sin él). Mismos outcomes que `stack.restack`; el output no trae `merge`.
 */
export function stackRestackRewrittenAction(deps: StackRestackDeps): ActionDef<typeof RestackRewrittenArgs> {
  return {
    name: "stack.restackRewritten",
    args: RestackRewrittenArgs,
    outcomes: ["ok", "conflict"],
    effects: "remote",
    async run({ pr, from, to }, ctx) {
      const found = rowOf(deps, pr);
      if (!found || childrenOf(deps.store, found.row.id).length === 0) return { outcome: "ok", output: NOTHING };

      await ctx.once("verify", async () => {
        const state = await deps.prs.get(pr);
        if (state.state === "merged" || state.state === "closed") {
          throw new PermanentActionError(`El PR #${pr.number} de ${pr.repo} ya está ${state.state === "merged" ? "mergeado" : "cerrado"}: sus hijos no se restackean sobre su branch reescrita.`);
        }
        await fetchOrThrow(deps, found, pr.repo, "restackear");
        const path = deps.repoConfig(found.repoId).path;
        for (const [name, sha] of [["vieja", from], ["nueva", to]] as const) {
          if ((await tryGit(path, ["rev-parse", "--verify", "--quiet", `${sha}^{commit}`])) === undefined) {
            throw new PermanentActionError(`La punta ${name} ${sha.slice(0, 9)} de ${found.row.headRef} no está en el repo local: no se puede restackear a sus hijos.`);
          }
        }
        return null;
      });

      return restackChain(deps, ctx, found, { from, onto: to, base: found.row.headRef });
    },
  };
}

type Found = NonNullable<ReturnType<typeof rowOf>>;

const NOTHING = { children: [], changedDrafts: [], promotable: [], mergeable: [] };

/**
 * Restackea a los hijos abiertos de `found.row` (y a los suyos) desde `start`. `mergedBranch` es la branch del
 * padre cuando se mergeó (`stack.restack`): los hijos directos cambian de base y dejan de colgar de él; sin ella,
 * la base de los hijos no cambia (`stack.restackRewritten`).
 */
async function restackChain(
  deps: StackRestackDeps,
  ctx: ActionCtx,
  { row: parentRow, repoId, remote }: Found,
  first: Start,
  mergedBranch?: string,
): Promise<{ outcome: "ok" | "conflict"; output: { children: ChildReport[]; changedDrafts: ChangedDraft[]; promotable: Promotable[]; mergeable: { number: number; mergeable: boolean | null }[] } }> {
  const { store, workspaces, prs } = deps;
  const pause = deps.pause ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const client = deps.connections.githubClient(remote.account);
  const [owner = "", name = ""] = remote.repo.split("/");
  const pull = (number: number) => ({ owner, repo: name, pull_number: number });
  const children: ChildReport[] = [];
  const promotable: Promotable[] = [];
  const { defaultBranch } = deps.repoConfig(repoId);

  async function restackChildren(parent: PrRow, start: Start, merged: string | undefined): Promise<void> {
    for (const child of childrenOf(store, parent.id)) {
      // Por el id de la fila: un PR local no tiene número.
      const stage = await ctx.once(`restack:${child.id}`, () => restackChild(child, start, merged));
      const { report } = stage;
      if (report.status === "restacked" || report.status === "uptodate") {
        const head = report.status === "restacked" ? report.head : undefined;
        await ctx.once(`retarget:${child.id}`, () => retarget(child, parent, stage.base, head, merged));
        if (child.state === "local" && stage.base === defaultBranch) promotable.push({ prId: child.id, branch: child.headRef, base: stage.base });
      }
      children.push(report);
      if (stage.next) await restackChildren(child, stage.next, undefined);
    }
  }

  /** Lo que se intentó con un hijo: el resultado y la base que el PR debe tener en GitHub después. */
  interface Attempt {
    result: RestackResult | BaseConflict;
    base: string;
    /** Los datos del `pr.conflict` para el flujo de rebase; una base combinada no los tiene: rebasea sobre su branch (ver `restackCombined`). */
    conflict?: { from: string; onto: string };
    /** La branch sintética, si el hijo sale de una base combinada: ahí se rebasea, y su conflicto lo resuelve `base-combinada-conflicto`. */
    combinedBranch?: string;
  }

  /**
   * Un hijo `local` vive solo en la máquina: sin `prs.get` (no hay council ni estado remoto) y con `acquire` en vez de
   * `attach` (que exige la branch en el remoto). `workspaces.restack` mueve una branch sin publicar sin pushear.
   */
  async function restackChild(child: PrRow, start: Start, merged: string | undefined): Promise<{ report: ChildReport; next?: Start; base: string }> {
    const local = child.state === "local";
    const childRef: PrRef | undefined = child.number === null ? undefined : { account: remote.account, repo: remote.repo, number: child.number };
    const base = { prId: child.id, ...(childRef && { pr: childRef }), branch: child.headRef };
    const skipped = (reason: string) => ({ report: { ...base, status: "skipped" as const, reason }, base: start.base });

    const state = local || !childRef ? undefined : await prs.get(childRef);
    if (state?.threads.councilEver) return skipped("tiene threads [clanker-council]: un restack reescribiría su historia y nunca se fuerza.");
    if (state?.state === "merged" || state?.state === "closed") return skipped(`el PR ya está ${state.state === "merged" ? "mergeado" : "cerrado"}.`);
    const headSha = state?.headSha ?? child.headSha;

    let lease;
    try {
      const request = { repo: repoId, branch: child.headRef, base: start.base, runId: ctx.runId };
      lease = local ? await workspaces.acquire(request) : await workspaces.attach(request);
    } catch (error) {
      if (error instanceof AttachError) return skipped(error.message);
      throw error;
    }
    try {
      const { result, base: toBase, conflict, combinedBranch } = await restackAttempt(lease, child, start, merged);
      switch (result.outcome) {
        case "restacked":
          return {
            report: { ...base, status: "restacked", previousHead: result.previousHead, head: result.head, commits: result.commits, draft: state?.state === "draft", base: toBase },
            next: { from: result.previousHead, onto: result.head, base: child.headRef },
            base: toBase,
          };
        case "uptodate":
          return { report: { ...base, status: "uptodate" }, base: toBase };
        case "conflict":
        case "base-conflict": {
          const files = result.outcome === "conflict" ? result.conflicts : result.files;
          const who = local ? { prId: child.id, local: true } : { number: child.number };
          if (result.outcome === "base-conflict" && combinedBranch) {
            // Los padres de la base combinada chocan entre sí: la resuelve `base-combinada-conflicto` (un merge real con el
            // dev y `rerere`), una vez por punta del hijo y padre que choca, y después rebasea el hijo sobre ella.
            store.tx((tx) =>
              emitOnce(
                tx,
                child,
                {
                  type: "pr.baseConflict",
                  keys: [`${headSha}:${result.parent}`],
                  runId: ctx.runId,
                  payload: () => ({
                    repo: remote.repo,
                    ...who,
                    sha: headSha,
                    base: combinedBranch,
                    resolveBranch: combinedBranch.replace(/^clanker\/base\//, "clanker/resolve/"),
                    defaultBranch: deps.repoConfig(repoId).defaultBranch,
                    parent: result.parent,
                    files,
                  }),
                },
                Date.now(),
              ),
            );
          } else {
            // La misma clave que usa Watch (el sha de la punta): si ya vio el conflicto, el flujo de rebase ya salió. Sobre
            // una base combinada el rebase es sobre su branch sintética, que ya trae a todos los padres.
            store.tx((tx) =>
              emitOnce(
                tx,
                child,
                {
                  type: "pr.conflict",
                  keys: [headSha],
                  runId: ctx.runId,
                  payload: () => ({ repo: remote.repo, ...who, sha: headSha, base: combinedBranch ?? toBase, ...conflict, files }),
                },
                Date.now(),
              ),
            );
          }
          return { report: { ...base, status: "conflict", files, failures: result.failures }, base: toBase };
        }
        case "foreign-merge":
          return { report: { ...base, status: "skipped", reason: result.failures }, base: toBase };
        case "empty":
          return { report: { ...base, status: "skipped", reason: `no le quedan commits propios sobre ${toBase}.` }, base: toBase };
        case "lease-rejected":
          return skipped(`${child.headRef} ya no está donde el core la dejó en el remoto: alguien más pusheó.`);
        case "unauthorized":
          throw githubUnauthorized(remote.account, `pushear ${child.headRef}`);
      }
    } catch (error) {
      if (error instanceof RebaseError) return skipped(error.message);
      throw error;
    } finally {
      workspaces.release(lease);
    }
  }

  /**
   * La base combinada de la issue solo vale si el PR salió de ella. Una fila vieja (la issue se relanzó a mano sobre
   * otra base y el PR cuelga de un solo padre) se retira y el PR se restackea como cualquier PR apilado.
   */
  async function restackAttempt(lease: WorkspaceRef, child: PrRow, start: Start, merged: string | undefined): Promise<Attempt> {
    const combined = combinedBaseOf(child);
    if (!combined) return restackPlain(lease, start);
    try {
      return await restackCombined(lease, child, combined, merged);
    } catch (error) {
      if (!(error instanceof StaleCombinedBaseError)) throw error;
    }
    // Otro PR abierto de la misma issue en el repo puede seguir usándola: ese la recalcula en su restack.
    const others = store.db
      .select({ id: pullRequests.id })
      .from(pullRequests)
      .where(and(eq(pullRequests.repoId, repoId), eq(pullRequests.issueId, combined.issueId), inArray(pullRequests.state, ["open", "local"]), ne(pullRequests.id, child.id)))
      .all();
    if (others.length === 0) await workspaces.dissolveBase(repoId, combined.branch);
    return restackPlain(lease, start);
  }

  async function restackPlain(lease: WorkspaceRef, start: Start): Promise<Attempt> {
    const onto = start.onto ?? (await workspaces.git(lease, "rev-parse", `refs/remotes/origin/${start.base}`));
    const result = await workspaces.restack(lease, { council: false, onto, from: start.from, base: start.base });
    return { result, base: start.base, conflict: { from: start.from, onto } };
  }

  /**
   * Un PR sobre una base combinada (`combined_bases`): la base se recalcula con los padres que siguen abiertos
   * (sin el mergeado, que es `merged`) y el PR pasa a apuntar al primero, o a la branch por defecto si no queda
   * ninguno. Si choca no hay `pr.conflict`: el flujo de rebase rebasea sobre una branch y no sabe rehacer la
   * base combinada, así que el conflicto queda como una nota para una persona.
   */
  async function restackCombined(lease: WorkspaceRef, child: PrRow, combined: CombinedBase, merged: string | undefined): Promise<Attempt> {
    const parents = liveCombinedParents(store, child, combined, merged);
    // Sin saber quiénes son sus padres no se disuelve nada: el hijo queda como estaba.
    if (parents === undefined) throw new RebaseError(`no se pudo identificar a los padres de la base combinada ${combined.branch}: ninguno es un PR conocido.`);
    const result = await workspaces.restackCombined(lease, { council: false, branch: combined.branch, parents });
    return { result, base: parents[0]?.branch ?? deps.repoConfig(repoId).defaultBranch, ...(parents.length > 0 && { combinedBranch: combined.branch }) };
  }

  /** La base combinada vigente de la issue del hijo, si su PR se abrió sobre una. */
  function combinedBaseOf(child: PrRow): CombinedBase | undefined {
    if (child.issueId === null) return undefined;
    return store.db
      .select()
      .from(combinedBases)
      .where(and(eq(combinedBases.repoId, repoId), eq(combinedBases.issueId, child.issueId), ne(combinedBases.status, "dissolved")))
      .get();
  }

  /**
   * Lo que queda tras el push de un hijo. Si colgaba del PR mergeado (`merged`: su branch): la base del PR en
   * GitHub, si GitHub no la movió, y el registro local, que ya no lo cuelga de él. Un hijo cuyo cuerpo
   * nombra la base vieja deja una nota. Sin `merged` solo se anota la punta nueva. Un hijo local no está en GitHub:
   * solo cambia su fila.
   */
  async function retarget(child: PrRow, parent: PrRow, base: string, head: string | undefined, merged: string | undefined): Promise<null> {
    const number = child.state === "local" ? null : child.number;
    const stale =
      merged !== undefined && number !== null
        ? await (async () => {
            const current = Pull.parse((await client.request("GET /repos/{owner}/{repo}/pulls/{pull_number}", pull(number))).data);
            if (current.base.ref !== base) await client.request("PATCH /repos/{owner}/{repo}/pulls/{pull_number}", { ...pull(number), base });
            return parent.number !== null && mentionsBase(current.body, merged, parent.number);
          })()
        : false;
    store.tx((tx) => {
      const changes = { ...(merged !== undefined && { baseRef: base }), ...(head !== undefined && { headSha: head }) };
      if (Object.keys(changes).length > 0) tx.db.update(pullRequests).set(changes).where(eq(pullRequests.id, child.id)).run();
      if (merged !== undefined) tx.db.delete(prParents).where(and(eq(prParents.childId, child.id), eq(prParents.parentId, parent.id))).run();
      if (stale) {
        openDecision(tx, {
          kind: "review_note",
          title: `Descripción obsoleta en ${remote.repo}#${number}`,
          body: `El cuerpo del PR nombra ${merged} (#${parent.number}), que ya se mergeó: ahora el PR va sobre ${base}. Actualiza la descripción.`,
          runId: ctx.runId,
          subject: { type: "pr", id: child.id },
        });
      }
    });
    return null;
  }

  await restackChildren(parentRow, first, mergedBranch);
  const mergeable = await ctx.once("mergeable", () => readMergeable(client, { owner, repo: name }, pause));
  const changedDrafts = children.flatMap((child) =>
    child.status === "restacked" && child.draft && child.pr ? [{ pr: child.pr, branch: child.branch, base: child.base }] : [],
  );
  return { outcome: children.some((child) => child.status === "conflict") ? "conflict" : "ok", output: { children, changedDrafts, promotable, mergeable } };
}

/** `workspaces.fetch` del repo de `found`; un token rechazado lanza (hay que reconectar la cuenta). */
async function fetchOrThrow(deps: StackRestackDeps, { repoId, remote }: Found, repo: string, what: string): Promise<void> {
  if ((await deps.workspaces.fetch(repoId)) === "unauthorized") {
    throw githubUnauthorized(remote.account, `traer ${repo} para ${what}`);
  }
}

/** La fila de `pull_requests` de `pr` (el repo se reconoce por su `owner/repo` de GitHub) con su repo y remoto. */
function rowOf(deps: StackRestackDeps, pr: PrRef) {
  for (const row of githubPulls(deps.store.db, eq(pullRequests.number, pr.number))) {
    const { remote } = deps.repoConfig(row.repoId);
    if (remote?.repo === pr.repo) return { row, repoId: row.repoId, remote };
  }
  return undefined;
}

/** Los PRs abiertos o locales que cuelgan de `parentId`, en orden de número (los locales, sin número, primero y por id). */
function childrenOf(store: Store, parentId: string): PrRow[] {
  const children = store.db.select({ id: prParents.childId }).from(prParents).where(eq(prParents.parentId, parentId));
  return store.db
    .select()
    .from(pullRequests)
    .where(and(inArray(pullRequests.state, ["open", "local"]), inArray(pullRequests.id, children)))
    .orderBy(asc(pullRequests.number), asc(pullRequests.id))
    .all();
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


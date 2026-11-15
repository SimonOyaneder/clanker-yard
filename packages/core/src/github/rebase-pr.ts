import { and, eq } from "drizzle-orm";
import * as z from "zod";
import { preparePush } from "../commits/prepare-push";
import { PermanentActionError, type ActionCtx, type ActionDef } from "../flows/catalog";
import { pullRequests, workspaces as workspaceRows } from "../store/schema";
import type { Store } from "../store/store";
import { RebaseError, WorkspaceOutput, type RepoConfig, type Workspaces } from "../workspaces/workspaces";
import type { Prs } from "./prs";
import { pushOrThrow } from "./push";

// El rebase de un PR abierto en el carril de mantenimiento (`docs/design.html#d-ops`, rebasePr):
// `workspace.rebase` y `pr.pushLease`. `workspace.attach` retoma el worktree antes.

export interface RebasePrDeps {
  store: Store;
  workspaces: Workspaces;
  repos: (repoId: string) => RepoConfig;
  prs: Pick<Prs, "get">;
}

/** El PR abierto de la branch del workspace, tal como lo registró `pr.publish`. */
function openPrOf(deps: RebasePrDeps, ws: { workspaceId: string; branch: string }) {
  const row = deps.store.db.select().from(workspaceRows).where(eq(workspaceRows.id, ws.workspaceId)).get();
  if (!row) throw new PermanentActionError(`No existe el workspace ${ws.workspaceId}.`);
  const { remote } = deps.repos(row.repoId);
  if (!remote) throw new PermanentActionError(`El repo ${row.repoId} no tiene remoto configurado: no se puede rebasear ni pushear.`);
  const pull = deps.store.db
    .select()
    .from(pullRequests)
    .where(and(eq(pullRequests.repoId, row.repoId), eq(pullRequests.headRef, ws.branch), eq(pullRequests.state, "open")))
    .get();
  if (!pull || !row.remoteSha) {
    throw new PermanentActionError(`${ws.branch} no tiene un PR abierto pusheado: no hay un PR que rebasear.`);
  }
  return { remote, ref: { account: remote.account, repo: remote.repo, number: pull.number } };
}

const RebaseArgs = z.object({
  ws: WorkspaceOutput,
  /** La base que el PR tiene ahora en GitHub, si cambió (el PR de abajo se mergeó). El mismo valor en cada visita del rebase. */
  base: z
    .string()
    .nullish()
    .transform((base) => base ?? undefined),
  /** Sigue el rebase detenido por conflicto, una vez que el agente resolvió los archivos. */
  continue: z.boolean().default(false),
});

/**
 * `workspace.rebase` (`docs/design.html#d-ops`, rebasePr y quién resuelve un conflicto): rebasea el PR sobre
 * su base con `workspaces.rebase`, que sabe de qué commit partir si el PR de abajo se mergeó. Una vez por
 * visita (`ctx.once`): tras un corte el reintento no vería las precondiciones. El PR con threads
 * `[clanker-council]` (`PrState.threads.councilEver`) no se rebasea: es `PermanentActionError`, como
 * cualquier precondición que no se cumple.
 *
 * Outcomes: `clean` (output `baseSha`, `head`), `conflict` (output `conflicts`, `failures`, `applying`: lo
 * que va al agente en modo conflict; el worktree queda con el rebase detenido y HEAD detached; con
 * `continue: true`, también si siguen quedando marcas) y `error` (falló sin conflicto: `--abort`, la branch
 * quedó igual; output `failures`).
 *
 * El `afterRebase` de la receta no corre aquí: es de `recipe.check` con `afterRebase: true`.
 */
export function workspaceRebaseAction(deps: RebasePrDeps): ActionDef<typeof RebaseArgs> {
  return {
    name: "workspace.rebase",
    args: RebaseArgs,
    outcomes: ["clean", "conflict", "error"],
    effects: "local",
    run: ({ ws, base, continue: resume }, ctx: ActionCtx) =>
      ctx.once("rebase", async () => {
        const { ref } = openPrOf(deps, ws);
        const council = (await deps.prs.get(ref)).threads.councilEver;
        try {
          const { outcome, ...output } = await deps.workspaces.rebase(ws, { council, continue: resume, ...(base !== undefined && { base }) });
          return { outcome, output };
        } catch (error) {
          if (error instanceof RebaseError) throw new PermanentActionError(error.message, { cause: error });
          throw error;
        }
      }),
  };
}

const PushLeaseArgs = z.object({ ws: WorkspaceOutput });

/**
 * `pr.pushLease` (`docs/design.html#d-flows`): pushea lo que quedó tras un rebase con `--force-with-lease`
 * contra el `remote_sha` (`workspaces.push`). Antes, `preparePush` por si quedó algún `fixup!`; no reconcilia
 * (tras un rebase `HEAD` ya no desciende de lo pusheado). Con council no hay force push: sería un rebase,
 * y `workspaces.push` lanza sin pushear. Un lease rechazado es `PermanentActionError` y un 401 reintenta,
 * igual que `pr.publish`. Dos etapas con `ctx.once` (push y lectura del PR). Lo que `afterRebase` haya
 * dejado sin commitear no se pushea.
 *
 * Outcomes `draft` y `ready` (el PR sigue en draft o ya está listo para review: ahí el flujo deja la nota
 * "pedir /review" en lugar de pr-feedback); output `head` y `pr`. Un PR ya cerrado o mergeado es
 * `PermanentActionError`.
 */
export function prPushLeaseAction(deps: RebasePrDeps): ActionDef<typeof PushLeaseArgs> {
  const { workspaces } = deps;
  return {
    name: "pr.pushLease",
    args: PushLeaseArgs,
    outcomes: ["draft", "ready"],
    effects: "remote",
    async run({ ws }, ctx) {
      const { remote, ref } = openPrOf(deps, ws);
      const council = await ctx.once("council", async () => (await deps.prs.get(ref)).threads.councilEver);

      const head = await ctx.once("push", async () => {
        const tip = await workspaces.git(ws, "rev-parse", "HEAD");
        const prepared = await preparePush(workspaces, ws, { knownSha: tip, base: workspaces.baseSha(ws), council });
        if (prepared.outcome !== "ok") throw new PermanentActionError(prepared.failures);
        await pushOrThrow(workspaces, ws, remote.account, { council });
        return prepared.head;
      });

      const state = await ctx.once("state", async () => (await deps.prs.get(ref)).state);
      if (state === "merged" || state === "closed") {
        throw new PermanentActionError(`El PR #${ref.number} de ${ref.repo} ya está ${state === "merged" ? "mergeado" : "cerrado"}: se pusheó ${ws.branch}, pero no hay nada que seguir.`);
      }
      return { outcome: state === "draft" ? "draft" : "ready", output: { head, pr: ref } };
    },
  };
}

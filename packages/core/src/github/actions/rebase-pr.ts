import { PrRef, type RepoId } from "@clanker/api";
import * as z from "zod";
import { preparePush } from "../../commits/prepare-push";
import { PermanentActionError, type ActionCtx, type ActionDef } from "../../flows/catalog";
import type { Store } from "../../store/store";
import { RebaseError, WorkspaceOutput, type RepoConfig, type Workspaces } from "../../workspaces/workspaces";
import type { Prs } from "../prs";
import { ownedOpenPr, pushOrThrow, type PrPurpose } from "./push";

// El rebase de un PR abierto en el carril de mantenimiento (`docs/design.html#d-ops`, rebasePr):
// `workspace.rebase` y `pr.pushLease`. `workspace.attach` retoma el worktree antes. `workspace.rebase` vive aquí y
// no en `workspaces/` porque lee el PR (que sea del sistema, sus threads de council); las acciones que solo tocan
// el worktree (`workspace.rebaseAbort`, `workspace.commitAfterRebase`) están en `workspaces/rebase-actions.ts`.

export interface RebasePrDeps {
  store: Store;
  workspaces: Workspaces;
  repoConfig: (repoId: RepoId) => RepoConfig;
  prs: Pick<Prs, "get">;
}

/** Para qué toma el rebase el PR de la branch (`ownedOpenPr`). */
const REBASE: PrPurpose = { needsRemote: "rebasear ni pushear", missing: "no hay un PR que rebasear", notOwned: "no se rebasea ni se pushea con force" };

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
        const { ref } = ownedOpenPr(deps, ws, REBASE);
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
      const { remote, ref } = ownedOpenPr(deps, ws, REBASE);
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

const ApprovalArgs = z.object({
  pr: PrRef,
  /** El agente reportó `behavior`: resolver el conflicto exigió decidir comportamiento. */
  behavior: z.boolean(),
  /** `rebaseNonDraft` del proyecto: con `ask`, un PR fuera de draft pide OK antes de seguir. */
  policy: z.enum(["auto", "ask"]),
});

/**
 * `pr.rebaseApproval` (`docs/design.html#d-ops`, quién resuelve un conflicto; decisiones 30 y 32): dice si el
 * rebase de un PR con el conflicto ya resuelto puede seguir solo. Un PR en draft siempre sigue (con
 * `behavior` el flujo deja además una nota). Fuera de draft pide un OK (`ask`) si el agente decidió
 * comportamiento o si el proyecto pide preguntar; con `auto` y sin `behavior` sigue. Lee el estado vivo del
 * PR: puede haber salido de draft desde que arrancó la corrida. Un PR cerrado o mergeado es
 * `PermanentActionError`.
 */
export function prRebaseApprovalAction(deps: Pick<RebasePrDeps, "prs">): ActionDef<typeof ApprovalArgs> {
  return {
    name: "pr.rebaseApproval",
    args: ApprovalArgs,
    outcomes: ["proceed", "ask"],
    effects: "local",
    async run({ pr, behavior, policy }) {
      const { state } = await deps.prs.get(pr);
      if (state === "merged" || state === "closed") {
        throw new PermanentActionError(`El PR #${pr.number} de ${pr.repo} ya está ${state === "merged" ? "mergeado" : "cerrado"}: no hay nada que rebasear.`);
      }
      const ask = state !== "draft" && (behavior || policy === "ask");
      return { outcome: ask ? "ask" : "proceed", output: { draft: state === "draft" } };
    },
  };
}

import type { RepoId } from "@clanker/api";
import { and, eq, inArray } from "drizzle-orm";
import * as z from "zod";
import { PermanentActionError, type ActionDef } from "../flows/catalog";
import { GitError } from "../git/git";
import { emitOnce } from "../github/marks";
import { prById } from "../github/pr-rows";
import { liveCombinedParents } from "../github/combined-parents";
import type { RepoConfig } from "../repos/repos";
import { combinedBases, pullRequests, workspaces as workspacesTable } from "../store/schema";
import type { Store } from "../store/store";
import { combinedMergeMessage } from "./combine";
import { withMarkers } from "./rebase";
import { RERERE, WorkspaceOutput, type Workspaces } from "./workspaces";

// Resolver una base combinada cuyos padres chocan (`docs/design.html#d-ops`, "Bases combinadas": "si el recálculo da
// conflicto, se dispara el flujo de rebase por conflicto"). El flujo `base-combinada-conflicto` junta los padres con un
// merge real en un worktree propio, con `rerere` encendido; el dev resuelve lo que choca y al commitear `rerere` guarda
// la resolución. La base final la arma `workspaces.combineBase`, el camino de siempre, que con `rerere` ya no choca: así
// su sha es el mismo que calcula cualquier restack posterior, y la misma resolución se reaplica sola cuando los padres
// se mueven.

export interface CombinedBaseActionsDeps {
  store: Store;
  workspaces: Workspaces;
  repoConfig: (repoId: RepoId) => RepoConfig;
}

const MergeArgs = z.object({
  ws: WorkspaceOutput,
  /** La branch sintética de la base combinada (`clanker/base/<clave>`). */
  base: z.string().min(1),
  /** Sigue el merge detenido, una vez que el agente resolvió los archivos. */
  continue: z.boolean().default(false),
});

/**
 * `workspace.combinedBaseMerge { ws, base, continue? }`: en el worktree de resolución (una branch propia, no la
 * sintética), parte de la punta de la branch por defecto y junta con un merge real cada padre que sigue abierto o
 * local, en orden, con `rerere` encendido (lo que ya sabe resolver lo aplica solo). Con `continue`, primero commitea el
 * merge detenido si no quedan marcas. Al juntar todos, rearma la base con `workspaces.combineBase` y la registra.
 *
 * Outcomes: `clean` (output `head`: la base nueva), `conflict` (output `conflicts` y `failures`, para el agente en modo
 * conflict; el merge queda detenido con las marcas) y `error` (la base no se pudo rearmar aun con la resolución).
 */
export function workspaceCombinedBaseMergeAction({ store, workspaces, repoConfig }: CombinedBaseActionsDeps): ActionDef<typeof MergeArgs> {
  return {
    name: "workspace.combinedBaseMerge",
    args: MergeArgs,
    outcomes: ["clean", "conflict", "error"],
    effects: "local",
    async run({ ws, base, continue: resume }) {
      const row = store.db.select({ repoId: workspacesTable.repoId }).from(workspacesTable).where(eq(workspacesTable.id, ws.workspaceId)).get();
      if (!row) throw new PermanentActionError(`No existe el workspace ${ws.workspaceId}.`);
      const combined = store.db.select().from(combinedBases).where(and(eq(combinedBases.repoId, row.repoId), eq(combinedBases.branch, base))).get();
      if (!combined || combined.status === "dissolved") throw new PermanentActionError(`${base} no es una base combinada vigente.`);
      const cfg = repoConfig(row.repoId);
      const g = (...args: string[]) => workspaces.git(ws, ...args);
      const rev = async (ref: string) => {
        try {
          return await g("rev-parse", "--verify", "--quiet", ref);
        } catch {
          return undefined;
        }
      };

      // Los padres que siguen vivos, en el orden de la base (los del PR hijo, `liveCombinedParents`); un padre que ya se
      // mergeó lo trae la branch por defecto.
      const child = combined.issueId
        ? store.db
            .select()
            .from(pullRequests)
            .where(and(eq(pullRequests.repoId, row.repoId), eq(pullRequests.issueId, combined.issueId), inArray(pullRequests.state, ["open", "local"])))
            .get()
        : undefined;
      // Sin PR hijo todavía (la issue no se lanzó), los padres salen de las branches de la base.
      const parents = liveCombinedParents(store, child ?? { id: "", repoId: row.repoId }, combined);
      if (parents === undefined || parents.length === 0) throw new PermanentActionError(`No se pudo identificar a los padres vivos de ${base}: no hay base que rearmar.`);

      if (resume) {
        const marked = await withMarkers(g);
        if (marked.length > 0) {
          return { outcome: "conflict", output: { conflicts: marked, failures: `Quedan marcas de conflicto (<<<<<<< o >>>>>>>) en ${marked.join(", ")}: resuélvelas antes de continuar.` } };
        }
        // Guarda la resolución en `rerere` aunque el agente haya commiteado por su cuenta: es lo que la reaplica después.
        await g("-c", "rerere.enabled=true", "rerere");
        if ((await rev("MERGE_HEAD")) !== undefined) {
          await g("add", "--all");
          await g("-c", "rerere.enabled=true", "-c", "core.editor=true", "commit", "--quiet", "--no-edit");
        }
      } else {
        if ((await rev("MERGE_HEAD")) !== undefined) await g("merge", "--abort");
        const tip = (await rev(`refs/remotes/origin/${cfg.defaultBranch}`)) ?? (await g("rev-parse", cfg.defaultBranch));
        await g("reset", "--quiet", "--hard", tip);
        await g("clean", "--quiet", "-fd");
      }

      for (const parent of parents) {
        const sha = (await rev(`refs/remotes/origin/${parent.branch}`)) ?? (await rev(`refs/heads/${parent.branch}`));
        if (sha === undefined) throw new PermanentActionError(`La punta de ${parent.branch} no está en el repo: no se puede rearmar ${base}.`);
        try {
          await g("merge-base", "--is-ancestor", sha, "HEAD");
          continue;
        } catch {
          // No lo trae todavía: se junta.
        }
        try {
          await g(...RERERE, "merge", "--no-ff", "--quiet", "-m", combinedMergeMessage(parent.branch, base), sha);
        } catch (error) {
          if (!(error instanceof GitError)) throw error;
          const unmerged = (await g("diff", "--name-only", "--diff-filter=U")).split("\n").filter(Boolean);
          if (unmerged.length > 0) {
            return { outcome: "conflict", output: { conflicts: unmerged, failures: `Al juntar ${parent.branch} en ${base}: conflicto en ${unmerged.join(", ")}. Las marcas <<<<<<< están en los archivos del worktree.` } };
          }
          // `rerere` resolvió todo: solo falta el commit del merge.
          await g("-c", "rerere.enabled=true", "-c", "core.editor=true", "commit", "--quiet", "--no-edit");
        }
      }

      if (combined.issueId === null) throw new PermanentActionError(`${base} no tiene issue: no se puede rearmar.`);
      const result = await workspaces.combineBase({ repo: row.repoId, issueId: combined.issueId, branch: base, parents: parents.map(({ key, branch }) => ({ key, branch })) });
      if (result.outcome !== "combined") {
        return { outcome: "error", output: { failures: `${base} sigue chocando al rearmarla (${result.files.join(", ")}): la resolución no quedó guardada para todo el conflicto.` } };
      }
      return { outcome: "clean", output: { head: result.head } };
    },
  };
}

const RequestArgs = z.object({ prId: z.string().min(1), base: z.string().min(1) });

/**
 * `pr.requestRebase { prId, base }`: con la base combinada ya resuelta, pide el rebase del PR que no cabía sobre ella
 * anotando un `pr.conflict` (con `local` según el PR), que toman `rebase-conflicto` o `rebase-conflicto-local`. Una vez
 * por punta del PR y de la base.
 */
export function prRequestRebaseAction({ store, repoConfig }: Pick<CombinedBaseActionsDeps, "store" | "repoConfig">): ActionDef<typeof RequestArgs> {
  return {
    name: "pr.requestRebase",
    args: RequestArgs,
    outcomes: ["ok"],
    effects: "local",
    async run({ prId, base }) {
      const pr = prById(store.db, prId);
      if (!pr || (pr.state !== "open" && pr.state !== "local")) throw new PermanentActionError(`El PR ${prId} ya no está abierto ni es local: no hay nada que rebasear.`);
      const remote = repoConfig(pr.repoId).remote;
      const baseHead = store.db.select({ head: combinedBases.headSha }).from(combinedBases).where(and(eq(combinedBases.repoId, pr.repoId), eq(combinedBases.branch, base))).get()?.head ?? base;
      const local = pr.state === "local";
      store.tx((tx) =>
        emitOnce(
          tx,
          pr,
          {
            type: "pr.conflict",
            keys: [`${pr.headSha}>${baseHead}`],
            payload: () => (local ? { repo: remote?.repo, prId: pr.id, local: true, sha: pr.headSha, base } : { repo: remote?.repo, number: pr.number, sha: pr.headSha, base }),
          },
          Date.now(),
        ),
      );
      return { outcome: "ok" };
    },
  };
}

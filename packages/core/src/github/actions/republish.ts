import { PrRef } from "@clanker/api";
import { RequestError } from "@octokit/request-error";
import { and, eq } from "drizzle-orm";
import * as z from "zod";
import type { Connections } from "../../connections/connections";
import { PermanentActionError, type ActionDef } from "../../flows/catalog";
import { GitError } from "../../git/git";
import { prParents, pullRequests, runs } from "../../store/schema";
import type { Store } from "../../store/store";
import { excerpt } from "../../workspaces/exec";
import { WorkspaceOutput, type Workspaces } from "../../workspaces/workspaces";
import type { GitHubClient } from "../client";

// Las dos acciones propias de `republish-pr` (`prs.republish`): rehacer un PR como uno nuevo con la branch, el autor
// y los commits de hoy. El resto del flujo (`workspace.acquire`, el committer, `pr.publish`) es el de siempre.

const ReplayArgs = z.object({
  ws: WorkspaceOutput,
  /** El head del PR viejo (un sha). */
  head: z.string().min(1),
  /** La branch que era la base del PR viejo. */
  base: z.string().min(1),
});

/**
 * `pr.replay`: deja en el worktree (index incluido, sin commits) el cambio del PR viejo, que es lo que el PR
 * mostraba: el árbol de su head menos el de su base. Es un merge de tres puntas entre la base del worktree y el head
 * viejo, con el punto de bifurcación del PR como ancestro, así que si la base no se movió el resultado es
 * exactamente el árbol del head viejo (el `tree` del output, que `pr.publish` exige a los commits). Si la base se
 * movió es ese mismo cambio sobre la base nueva. Lanza `PermanentActionError` (el PR viejo se queda como está)
 * si el merge conflictúa o si el cambio no toca los mismos archivos que el original (algo del PR ya estaba en la base).
 */
export function prReplayAction({ workspaces }: { workspaces: Workspaces }): ActionDef<typeof ReplayArgs> {
  return {
    name: "pr.replay",
    args: ReplayArgs,
    outcomes: ["ok"],
    effects: "local",
    async run({ ws, head, base }) {
      const files = async (from: string, to: string) =>
        (await workspaces.git(ws, "diff", "--name-only", "--no-renames", from, to)).split("\n").filter(Boolean).sort();
      try {
        const mergeBase = await workspaces.git(ws, "merge-base", head, `refs/remotes/origin/${base}`);
        const merged = (await workspaces.git(ws, "merge-tree", "--write-tree", `--merge-base=${mergeBase}`, "HEAD", head)).split("\n")[0]!;
        const expected = await files(mergeBase, head);
        const actual = await files("HEAD", merged);
        if (expected.join("\n") !== actual.join("\n")) {
          throw new PermanentActionError(
            `El cambio del PR viejo toca ${expected.length} archivos y sobre la base nueva quedan ${actual.length}: parte ya estaba en la base. No se rehace sin que alguien lo mire.`,
          );
        }
        await workspaces.git(ws, "read-tree", "--reset", "-u", merged);
        return { outcome: "ok", output: { tree: merged } };
      } catch (error) {
        if (!(error instanceof GitError)) throw error;
        throw new PermanentActionError(`El cambio del PR viejo no se pudo aplicar sobre la base nueva: ${excerpt(error.output)}`, { cause: error });
      }
    },
  };
}

const SupersedeArgs = z.object({
  /** El PR nuevo. */
  pr: PrRef,
  /** El PR viejo. */
  oldNumber: z.int().positive(),
  /** Su branch head y la de su base. */
  oldHead: z.string().min(1),
  oldBase: z.string().min(1),
  /** El estado de draft que tenía: con `draft` el flujo sigue a `pr-feedback` (`/review`), con `ready` termina. */
  draft: z.boolean(),
});

export interface PrSupersedeDeps {
  store: Store;
  connections: Pick<Connections, "githubClient">;
}

/**
 * `pr.supersede`, después de publicar el PR nuevo: comenta "Reemplazado por #n" en el viejo y lo cierra; borra
 * del remoto su branch (y la de su base, si era el head de un padre ya reemplazado) salvo que algún PR abierto la
 * use como base, y deja al core siguiendo al PR nuevo: las corridas que tenían el viejo y los hijos apilados pasan
 * a él. Cada etapa de GitHub va en su `ctx.once`.
 *
 * Outcomes: `draft` y `ready`, según el estado del viejo.
 */
export function prSupersedeAction({ store, connections }: PrSupersedeDeps): ActionDef<typeof SupersedeArgs> {
  return {
    name: "pr.supersede",
    args: SupersedeArgs,
    outcomes: ["draft", "ready"],
    effects: "remote",
    async run({ pr, oldNumber, oldHead, oldBase, draft }, ctx) {
      const [owner = "", repo = ""] = pr.repo.split("/");
      const client = connections.githubClient(pr.account);
      await ctx.once("comment", async () => {
        await client.request("POST /repos/{owner}/{repo}/issues/{issue_number}/comments", { owner, repo, issue_number: oldNumber, body: `Reemplazado por #${pr.number}` });
        return true;
      });
      await ctx.once("close", async () => {
        await client.request("PATCH /repos/{owner}/{repo}/pulls/{pull_number}", { owner, repo, pull_number: oldNumber, state: "closed" });
        return true;
      });
      const row = store.db
        .select({ repoId: pullRequests.repoId })
        .from(pullRequests)
        .where(and(eq(pullRequests.runId, ctx.runId), eq(pullRequests.number, pr.number)))
        .get();
      if (!row) throw new PermanentActionError(`El core no registró el PR nuevo ${pr.repo}#${pr.number}.`);
      const parentHead = supersededParent(store, row.repoId, oldBase);
      await ctx.once("branches", async () => {
        for (const branch of [oldHead, ...(parentHead ? [parentHead] : [])]) await deleteUnlessBase(client, owner, repo, branch);
        return true;
      });
      followNew(store, ctx.runId, row.repoId, oldNumber, pr.number);
      return { outcome: draft ? "draft" : "ready" };
    },
  };
}

/** `branch` si es el head de un PR cerrado cuya issue ya tiene otro PR abierto (un padre que ya se rehízo), `undefined` si no. */
function supersededParent(store: Store, repoId: string, branch: string): string | undefined {
  const closed = store.db
    .select({ issueId: pullRequests.issueId })
    .from(pullRequests)
    .where(and(eq(pullRequests.repoId, repoId), eq(pullRequests.headRef, branch), eq(pullRequests.state, "closed")))
    .get();
  if (!closed?.issueId) return undefined;
  const replacement = store.db
    .select({ id: pullRequests.id })
    .from(pullRequests)
    .where(and(eq(pullRequests.repoId, repoId), eq(pullRequests.issueId, closed.issueId), eq(pullRequests.state, "open")))
    .get();
  return replacement ? branch : undefined;
}

/** GitHub cierra los PRs de una branch borrada, también los que la tienen de base: antes se mira que ninguno esté abierto. */
async function deleteUnlessBase(client: GitHubClient, owner: string, repo: string, branch: string): Promise<void> {
  const { data } = await client.request("GET /repos/{owner}/{repo}/pulls", { owner, repo, base: branch, state: "open", per_page: 1 });
  if (Array.isArray(data) && data.length > 0) return;
  try {
    await client.request("DELETE /repos/{owner}/{repo}/git/refs/{ref}", { owner, repo, ref: `heads/${branch}` });
  } catch (error) {
    // Ya no estaba (alguien la borró, o GitHub la borró al cerrar el PR): el resultado es el mismo.
    if (!(error instanceof RequestError && (error.status === 404 || error.status === 422))) throw error;
  }
}

/** El viejo queda cerrado en el caché, y lo que lo seguía (corridas que lo tenían, PRs apilados sobre él) pasa al nuevo. */
function followNew(store: Store, runId: string, repoId: string, oldNumber: number, newNumber: number): void {
  store.tx(({ db }) => {
    const old = db.select({ id: pullRequests.id }).from(pullRequests).where(and(eq(pullRequests.repoId, repoId), eq(pullRequests.number, oldNumber))).get();
    const fresh = db.select({ id: pullRequests.id }).from(pullRequests).where(and(eq(pullRequests.repoId, repoId), eq(pullRequests.number, newNumber))).get();
    if (!old || !fresh) return;
    db.update(pullRequests).set({ state: "closed" }).where(eq(pullRequests.id, old.id)).run();
    db.update(runs).set({ claimedPrId: fresh.id }).where(eq(runs.claimedPrId, old.id)).run();
    db.update(prParents).set({ parentId: fresh.id }).where(eq(prParents.parentId, old.id)).run();
  });
}

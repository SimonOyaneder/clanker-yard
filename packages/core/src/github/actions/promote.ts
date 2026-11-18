import type { PrRef, RepoId, RunId } from "@clanker/api";
import { and, eq, inArray, ne } from "drizzle-orm";
import * as z from "zod";
import type { Connections } from "../../connections/connections";
import { PermanentActionError, type ActionDef } from "../../flows/catalog";
import { combinedBases, prParents, pullRequests, runs, workspaces as workspacesTable } from "../../store/schema";
import type { Store } from "../../store/store";
import type { RepoConfig } from "../../repos/repos";
import { WorkspaceOutput, type Workspaces } from "../../workspaces/workspaces";
import { prById } from "../pr-rows";
import { pushOrThrow } from "./push";
import { assignOrNote, findOpenPull, openPull, type Pull } from "./pulls";

export interface PrPromoteDeps {
  store: Store;
  workspaces: Workspaces;
  repoConfig: (repoId: RepoId) => RepoConfig;
  connections: Pick<Connections, "githubClient">;
}

const PromoteArgs = z.object({
  /** El worktree de la branch del PR local (`workspace.acquire`): de ahí sale el push. */
  ws: WorkspaceOutput,
  /** La fila `local` de `pull_requests`. */
  prId: z.string().min(1),
  /** La base del PR en GitHub; por defecto la `base_ref` de la fila (la branch por defecto tras un restack). */
  base: z.string().min(1).nullish(),
});

/**
 * `pr.promote { ws, prId, base? }` (stacks locales): publica en GitHub un PR que vivía solo en la máquina (fila
 * `local` de `pull_requests`). Dos etapas con `ctx.once`, como `pr.publish`: `push` (con lease; la branch no está en el
 * remoto, `remote_sha` NULL) y `pr` (busca el PR abierto de la branch o abre uno draft con el `title` y `body`
 * guardados, y lo asigna a la cuenta). La fila es la misma: pasa a `open` con `number` y `node_id`, y conserva
 * `id`, issue, corrida y `pr_parents`. Emite `pr.opened`. Un PR que ya no es `local` (un reintento después de
 * guardarlo) devuelve lo que ya está.
 *
 * Outcome `ok`, output `{ pr, url, head }`, igual que `pr.publish`.
 */
export function prPromoteAction(deps: PrPromoteDeps): ActionDef<typeof PromoteArgs> {
  const { store, workspaces } = deps;
  return {
    name: "pr.promote",
    args: PromoteArgs,
    outcomes: ["ok"],
    effects: "remote",
    async run({ ws, prId, base }, ctx) {
      const row = prById(store.db, prId);
      if (!row) throw new PermanentActionError(`No existe el PR ${prId}.`);
      const { remote } = deps.repoConfig(row.repoId);
      if (!remote) throw new PermanentActionError(`El repo ${row.repoId} no tiene remoto configurado: no se puede publicar ${row.headRef}.`);
      if (row.headRef !== ws.branch) throw new PermanentActionError(`El worktree es de ${ws.branch} y el PR ${prId} de ${row.headRef}.`);
      if (row.state !== "local" && row.state !== "open") {
        throw new PermanentActionError(`El PR ${prId} (${row.headRef}) ya está ${row.state}: no hay nada que publicar.`);
      }
      const [owner = "", name = ""] = remote.repo.split("/");
      const target = base ?? row.baseRef;

      const head = await ctx.once("push", async () => {
        await pushOrThrow(workspaces, ws, remote.account, { council: false });
        return workspaces.git(ws, "rev-parse", "HEAD");
      });

      const pull = await ctx.once("pr", async () => {
        workspaces.validate(ws);
        const client = deps.connections.githubClient(remote.account);
        const existing = await findOpenPull(client, owner, name, row.headRef);
        const pull = existing ?? (await openPull(client, owner, name, { title: row.title ?? row.headRef, body: row.body ?? "", head: row.headRef, base: target, draft: true }));
        record(store, { prId, repoId: row.repoId, repo: remote.repo, pull, base: target, runId: ctx.runId });
        if (!existing) await assignOrNote(store, client, ctx.runId, { owner, repo: name, number: pull.number, assignee: remote.account });
        return pull;
      });

      const pr: PrRef = { account: remote.account, repo: remote.repo, number: pull.number };
      return { outcome: "ok", output: { pr, url: pull.html_url, head } };
    },
  };
}

/**
 * La fila local pasa a ser la del PR de GitHub. Si Watch ya lo había descubierto (la búsqueda de tus PRs abiertos)
 * hay otra fila con ese número, sin `owned`: se borra y la local queda como la del PR. Emite `pr.opened` solo la
 * primera vez.
 */
function record(store: Store, { prId, repoId, repo, pull, base, runId }: { prId: string; repoId: RepoId; repo: string; pull: Pull; base: string; runId: RunId }): void {
  store.tx(({ db, emit }) => {
    const current = db.select().from(pullRequests).where(eq(pullRequests.id, prId)).get();
    if (!current || current.state !== "local") return;
    db.delete(pullRequests).where(and(eq(pullRequests.repoId, repoId), eq(pullRequests.number, pull.number), ne(pullRequests.id, prId), eq(pullRequests.owned, false))).run();
    db.update(pullRequests)
      .set({ number: pull.number, nodeId: pull.node_id, state: pull.state, isDraft: pull.draft, headSha: pull.head.sha, baseRef: base, headChangedAt: Date.now() })
      .where(eq(pullRequests.id, prId))
      .run();
    const projectId = current.runId ? db.select({ id: runs.projectId }).from(runs).where(eq(runs.id, current.runId)).get()?.id : undefined;
    emit({
      type: "pr.opened",
      origin: "core",
      runId,
      ...(projectId && { projectId }),
      subject: { type: "pr", id: prId },
      payload: { repo, number: pull.number, url: pull.html_url },
    });
  });
}

const SaveLocalArgs = z.object({ ws: WorkspaceOutput, prId: z.string().min(1) });

/**
 * `pr.saveLocal { ws, prId }` (stacks locales): un PR local que se rebaseó en la máquina (`rebase-conflicto-local`)
 * guarda su punta y su base en la fila, sin push. Cuelga del PR (abierto o local) cuya branch es la base nueva, y de
 * ninguno si quedó sobre la branch por defecto.
 *
 * Outcomes: `local` (sigue apilado) y `promotable` (quedó sobre la branch por defecto: ya se puede publicar). Output
 * `{ prId, branch, base, head }`.
 */
export function prSaveLocalAction(deps: Pick<PrPromoteDeps, "store" | "workspaces" | "repoConfig">): ActionDef<typeof SaveLocalArgs> {
  const { store, workspaces } = deps;
  return {
    name: "pr.saveLocal",
    args: SaveLocalArgs,
    outcomes: ["local", "promotable"],
    effects: "local",
    async run({ ws, prId }) {
      const row = prById(store.db, prId);
      if (!row || row.state !== "local") throw new PermanentActionError(`El PR ${prId} no es un PR local: no hay nada que guardar.`);
      const workspace = store.db.select({ baseRef: workspacesTable.baseRef }).from(workspacesTable).where(eq(workspacesTable.id, ws.workspaceId)).get();
      if (!workspace) throw new PermanentActionError(`No existe el workspace ${ws.workspaceId}.`);
      // Sobre una base combinada, el PR cuelga de sus padres que siguen vivos y su base es el primero.
      const combined = store.db
        .select({ parents: combinedBases.parents })
        .from(combinedBases)
        .where(and(eq(combinedBases.repoId, row.repoId), eq(combinedBases.branch, workspace.baseRef), ne(combinedBases.status, "dissolved")))
        .get();
      const head = await workspaces.git(ws, "rev-parse", "HEAD");
      const base = store.tx(({ db, emit }) => {
        const branches = combined ? combined.parents.map((p) => p.branch) : [workspace.baseRef];
        const parents = db
          .select({ id: pullRequests.id, headRef: pullRequests.headRef })
          .from(pullRequests)
          .where(and(eq(pullRequests.repoId, row.repoId), inArray(pullRequests.headRef, branches), inArray(pullRequests.state, ["open", "local"])))
          .all();
        const base = combined ? (branches.find((b) => parents.some((p) => p.headRef === b)) ?? deps.repoConfig(row.repoId).defaultBranch) : workspace.baseRef;
        db.update(pullRequests).set({ baseRef: base, headSha: head, headChangedAt: Date.now() }).where(eq(pullRequests.id, prId)).run();
        db.delete(prParents).where(eq(prParents.childId, prId)).run();
        for (const parent of parents) db.insert(prParents).values({ childId: prId, parentId: parent.id }).run();
        emit({ type: "pr.changed", origin: "core", subject: { type: "pr", id: prId }, payload: {} });
        return base;
      });
      const promotable = base === deps.repoConfig(row.repoId).defaultBranch;
      return { outcome: promotable ? "promotable" : "local", output: { prId, branch: row.headRef, base, head } };
    },
  };
}

import type { PrRef } from "@clanker/api";
import { RequestError } from "@octokit/request-error";
import { and, eq } from "drizzle-orm";
import * as z from "zod";
import { ApplyArgs, cleanMessage, commitsApplyAction } from "../commits/apply";
import { preparePush } from "../commits/prepare-push";
import type { Connections } from "../connections/connections";
import { PermanentActionError, type ActionCtx, type ActionDef, type ActionResult } from "../flows/catalog";
import { claimPr } from "../flows/subjects";
import type { Packs } from "../packs/packs";
import type { Recipes } from "../recipe/recipe";
import { newId } from "../store/conventions";
import { prParents, pullRequests, runs, workspaces as workspaceRows } from "../store/schema";
import type { Store } from "../store/store";
import type { RepoConfig, Workspaces } from "../workspaces/workspaces";
import type { GitHubClient } from "./client";
import { pushOrThrow } from "./push";

const PublishArgs = ApplyArgs.extend({
  /** El reporte del committer: de él lee los commits (como `commits.apply`) y el título y cuerpo del PR. */
  plan: ApplyArgs.shape.plan.extend({ pr: z.object({ title: z.string().min(1), body: z.string() }) }),
  /** El PR se abre en draft; solo `false` lo abre listo para review. */
  draft: z.boolean().default(true),
  /** PRs de los que este depende, como `repo#n` (un PR apilado): el cuerpo abre con "Depende de ...". */
  dependsOn: z.array(z.string().regex(/^[^\s#]+#\d+$/, "debe ser repo#n")).default([]),
});

/** Lo que la acción lee de un PR de la API REST. */
const Pull = z.object({
  number: z.int().positive(),
  node_id: z.string(),
  html_url: z.string(),
  state: z.enum(["open", "closed"]),
  draft: z.boolean(),
  head: z.object({ sha: z.string() }),
});
type Pull = z.infer<typeof Pull>;

export interface PrPublishDeps {
  store: Store;
  workspaces: Workspaces;
  recipes: Recipes;
  repos: (repoId: string) => RepoConfig;
  connections: Pick<Connections, "githubClient" | "markRevoked">;
  packs: Packs;
}

/**
 * `pr.publish` (`docs/design.html#d-flows`, etapas y efectos externos): `commits.apply`, push con lease
 * y PR draft, cada etapa con `ctx.once`, así que un reintento tras un corte retoma donde quedó y no
 * duplica commits, push ni PR. El PR sale con la identidad de la cuenta del repo (su token) y sin
 * líneas que lo firmen como hecho por una IA.
 *
 * - Commits: los de `commits.apply` (que ya reconoce los suyos si el corte llegó antes de guardarse).
 * - Push: `preparePush` y `workspaces.push` con lease. Un lease rechazado (alguien más pusheó) no se
 *   arregla reintentando y un 401 sí puede (reconectando la cuenta), así que ese lanza con su backoff.
 * - PR: se busca el abierto de la branch antes de crearlo. Título y cuerpo salen del plan del committer
 *   (que sigue la plantilla del pack) sin las secciones de `conventions.pr.omitSections`; `dependsOn`
 *   agrega "Depende de repo#n". Queda en `pull_requests` (`owned`) enlazado a la issue y la corrida, y
 *   emite `pr.opened`.
 *
 * Outcomes: `ok` (output `pr`: la `PrRef`, más `url` y `head`) y `replan` (`failures` va de vuelta al
 * committer: el plan no se puede aplicar, no trae commits, un hook rechazó un commit o los commits
 * del agente no cuadran).
 */
export function prPublishAction(deps: PrPublishDeps): ActionDef<typeof PublishArgs> {
  const { store, workspaces, packs } = deps;
  const apply = commitsApplyAction({ workspaces, recipes: deps.recipes });

  async function publish(args: z.infer<typeof PublishArgs>, ctx: ActionCtx): Promise<ActionResult> {
    const { ws, plan } = args;
    const row = store.db.select().from(workspaceRows).where(eq(workspaceRows.id, ws.workspaceId)).get();
    if (!row) throw new PermanentActionError(`No existe el workspace ${ws.workspaceId}.`);
    const { remote } = deps.repos(row.repoId);
    if (!remote) throw new PermanentActionError(`El repo ${row.repoId} no tiene remoto configurado: no se puede publicar.`);

    const applied = await apply.run(args, ctx);
    if (applied.outcome !== "ok") return { outcome: "replan", output: applied.output };
    const { commits } = z.object({ commits: z.array(z.object({ sha: z.string() })) }).parse(applied.output);
    const tip = commits.at(-1)?.sha;
    if (tip === undefined) {
      return { outcome: "replan", output: { failures: "El plan no tiene commits: no hay nada que publicar." } };
    }

    const pushed = await ctx.once("push", async () => {
      const prepared = await preparePush(workspaces, ws, { knownSha: tip, base: workspaces.baseSha(ws), council: false });
      if (prepared.outcome === "replan") return { replan: prepared.failures };
      if (prepared.outcome === "squash-failed") throw new PermanentActionError(prepared.failures);
      await pushOrThrow(workspaces, ws, remote.account, { council: false });
      return { head: prepared.head };
    });
    if ("replan" in pushed) return { outcome: "replan", output: { failures: pushed.replan } };

    const [owner = "", name = ""] = remote.repo.split("/");
    const pack = packs.packFor({ githubOrg: owner });
    const title = cleanMessage(plan.pr.title).split("\n")[0]!.trim();
    const body = prBody(cleanMessage(plan.pr.body), pack.conventions.pr?.omitSections ?? [], args.dependsOn);

    const pull = await ctx.once("pr", async () => {
      workspaces.validate(ws);
      const client = deps.connections.githubClient(remote.account);
      try {
        const existing = await findOpenPull(client, owner, name, ws.branch);
        const pull = existing ?? (await openPull(client, owner, name, { title, body, head: ws.branch, base: row.baseRef, draft: args.draft }));
        recordPull(store, ctx, { repoId: row.repoId, repo: remote.repo, pull, headRef: ws.branch, baseRef: row.baseRef });
        return pull;
      } catch (error) {
        if (error instanceof RequestError && error.status === 401) deps.connections.markRevoked("github", remote.account, "core");
        throw error;
      }
    });

    const pr: PrRef = { account: remote.account, repo: remote.repo, number: pull.number };
    return { outcome: "ok", output: { pr, url: pull.html_url, head: pushed.head } };
  }

  return {
    name: "pr.publish",
    args: PublishArgs,
    outcomes: ["ok", "replan"],
    effects: "remote",
    run: publish,
  };
}

async function findOpenPull(client: GitHubClient, owner: string, repo: string, branch: string): Promise<Pull | undefined> {
  const { data } = await client.request("GET /repos/{owner}/{repo}/pulls", {
    owner,
    repo,
    head: `${owner}:${branch}`,
    state: "open",
  });
  return z.array(Pull).parse(data)[0];
}

async function openPull(
  client: GitHubClient,
  owner: string,
  repo: string,
  pull: { title: string; body: string; head: string; base: string; draft: boolean },
): Promise<Pull> {
  const { data } = await client.request("POST /repos/{owner}/{repo}/pulls", { owner, repo, ...pull });
  return Pull.parse(data);
}

/**
 * Guarda el PR (y de qué PR abierto cuelga, `pr_parents`) y emite `pr.opened` en la misma tx. Si la fila ya estaba (un reintento tras un corte
 * después de guardarla) no hace nada: ni la pisa ni repite el evento.
 */
function recordPull(
  store: Store,
  ctx: ActionCtx,
  { repoId, repo, pull, headRef, baseRef }: { repoId: string; repo: string; pull: Pull; headRef: string; baseRef: string },
): void {
  const run = store.db.select().from(runs).where(eq(runs.id, ctx.runId)).get();
  store.tx((tx) => {
    const { db, emit } = tx;
    const saved = db
      .insert(pullRequests)
      .values({
        id: newId("pr"),
        repoId,
        number: pull.number,
        nodeId: pull.node_id,
        headRef,
        baseRef,
        headSha: pull.head.sha,
        state: pull.state,
        isDraft: pull.draft,
        issueId: run?.subjectType === "issue" ? run.subjectId : null,
        runId: ctx.runId,
        owned: true,
      })
      .onConflictDoNothing()
      .returning({ id: pullRequests.id })
      .get();
    if (!saved) return;
    // La corrida de la issue también es la dueña del PR: un council o un rebase sobre él espera a que ella termine o se estacione.
    claimPr(tx, ctx.runId, saved.id);
    // Su base es la branch de otro PR abierto del repo: cuelga de él hasta que se mergee (`stack.restack`).
    const parent = db
      .select({ id: pullRequests.id })
      .from(pullRequests)
      .where(and(eq(pullRequests.repoId, repoId), eq(pullRequests.headRef, baseRef), eq(pullRequests.state, "open")))
      .get();
    if (parent) db.insert(prParents).values({ childId: saved.id, parentId: parent.id }).run();
    emit({
      type: "pr.opened",
      origin: "core",
      runId: ctx.runId,
      ...(run?.projectId && { projectId: run.projectId }),
      subject: { type: "pr", id: saved.id },
      payload: { repo, number: pull.number, url: pull.html_url },
    });
  });
}

/** El cuerpo sin las secciones omitidas, con el aviso de dependencia arriba si el PR está apilado. */
function prBody(body: string, omit: string[], dependsOn: string[]): string {
  const omitted = new Set(omit.map((title) => title.trim().toLowerCase()));
  const kept: string[] = [];
  let skipping: number | undefined;
  let fenced = false;
  for (const line of body.split("\n")) {
    if (/^\s*(```|~~~)/.test(line)) fenced = !fenced;
    const heading = fenced ? null : /^(#{1,6})\s+(.*?)\s*#*\s*$/.exec(line);
    if (heading) {
      const level = heading[1]!.length;
      if (skipping !== undefined && level <= skipping) skipping = undefined;
      if (skipping === undefined && omitted.has(heading[2]!.toLowerCase())) skipping = level;
    }
    if (skipping === undefined) kept.push(line);
  }
  const text = kept.join("\n").replace(/\n{3,}/g, "\n\n").trim();
  return dependsOn.length === 0 ? text : `Depende de ${dependsOn.join(", ")}\n\n${text}`.trim();
}

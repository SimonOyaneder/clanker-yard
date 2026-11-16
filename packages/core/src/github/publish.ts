import type { IssueId, PrRef, RunId } from "@clanker/api";
import { RequestError } from "@octokit/request-error";
import { and, eq, inArray } from "drizzle-orm";
import * as z from "zod";
import { ApplyArgs, cleanMessage, commitsApplyAction } from "../commits/apply";
import { preparePush } from "../commits/prepare-push";
import type { Connections } from "../connections/connections";
import { openDecision } from "../decisions/decisions";
import { PermanentActionError, type ActionCtx, type ActionDef, type ActionResult } from "../flows/catalog";
import { claimPr } from "../flows/subjects";
import type { Packs } from "../packs/packs";
import type { Recipes } from "../recipe/recipe";
import { newId } from "../store/conventions";
import { type CombinedBaseParent, combinedBases, issues, prParents, pullRequests, runs, workspaces as workspaceRows } from "../store/schema";
import type { Store } from "../store/store";
import { RebaseError, type RepoConfig, type Workspaces, type WorkspaceRef } from "../workspaces/workspaces";
import type { GitHubClient } from "./client";
import { pushOrThrow } from "./push";

const PublishArgs = ApplyArgs.extend({
  /** El reporte del committer: de él lee los commits (como `commits.apply`) y el título y cuerpo del PR. */
  plan: ApplyArgs.shape.plan.extend({ pr: z.object({ title: z.string().min(1), body: z.string() }) }),
  /** El PR se abre en draft; solo `false` lo abre listo para review. */
  draft: z.boolean().default(true),
  /** PRs de los que este depende, como `repo#n` (un PR apilado): el cuerpo abre con "Depende de ...". */
  dependsOn: z.array(z.string().regex(/^[^\s#]+#\d+$/, "debe ser repo#n")).default([]),
  /** El árbol que los commits deben dejar (`pr.replay` lo calcula al rehacer un PR): otro y no se publica nada. */
  expectTree: z.string().optional(),
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
 * líneas que lo firmen como hecho por una IA. El título parte con `[KEY]` de la issue de la corrida (`titleWithKey`,
 * sea cual sea su tracker) y el PR nuevo se asigna a esa misma cuenta; si GitHub no deja asignarlo, la publicación sigue
 * y queda una nota en la Bandeja.
 *
 * - Commits: los de `commits.apply` (que ya reconoce los suyos si el corte llegó antes de guardarse).
 * - Push: `preparePush` y `workspaces.push` con lease. Un lease rechazado (alguien más pusheó) no se
 *   arregla reintentando y un 401 sí puede (reconectando la cuenta), así que ese lanza con su backoff.
 * - PR: se busca el abierto de la branch antes de crearlo. Título y cuerpo salen del plan del committer
 *   (que sigue la plantilla del pack) sin las secciones de `conventions.pr.omitSections`; `dependsOn`
 *   agrega "Depende de repo#n". Con una base combinada (`combined_bases`, ver `workspaces.combineBase`) el PR
 *   se abre contra la branch del primer padre, con una nota al principio del cuerpo de qué otros PRs aportan
 *   commits, y cuelga de todos ellos (`pr_parents`). Queda en `pull_requests` (`owned`) enlazado a la issue y la corrida, y
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
    const { commits, tree } = z.object({ commits: z.array(z.object({ sha: z.string() })), tree: z.string() }).parse(applied.output);
    if (args.expectTree !== undefined && tree !== args.expectTree) {
      throw new PermanentActionError(`Los commits dejan el árbol ${tree.slice(0, 9)} y no el esperado ${args.expectTree.slice(0, 9)}: no se publica.`);
    }
    const tip = commits.at(-1)?.sha;
    if (tip === undefined) {
      return { outcome: "replan", output: { failures: "El plan no tiene commits: no hay nada que publicar." } };
    }

    // Un padre pudo mergearse mientras la corrida trabajaba: nadie recalcula una base que aún no tiene PR, así que se hace aquí.
    const settled = await ctx.once("base", () => settleBase(deps, ctx.runId, ws, row, tip));

    const pushed = await ctx.once("push", async () => {
      const prepared = await preparePush(workspaces, ws, { knownSha: settled.head, base: workspaces.baseSha(ws), council: false, messagePattern: args.messagePattern });
      if (prepared.outcome === "replan") return { replan: prepared.failures };
      if (prepared.outcome === "squash-failed") throw new PermanentActionError(prepared.failures);
      await pushOrThrow(workspaces, ws, remote.account, { council: false });
      return { head: prepared.head };
    });
    if ("replan" in pushed) return { outcome: "replan", output: { failures: pushed.replan } };

    const [owner = "", name = ""] = remote.repo.split("/");
    const pack = packs.packFor({ githubOrg: owner });
    const title = titleWithKey(cleanMessage(plan.pr.title).split("\n")[0]!.trim(), issueKey(store, ctx.runId));
    const { baseRef, parents } = settled;
    const body = prBody(cleanMessage(plan.pr.body), pack.conventions.pr?.omitSections ?? [], args.dependsOn, parents);

    const pull = await ctx.once("pr", async () => {
      workspaces.validate(ws);
      const client = deps.connections.githubClient(remote.account);
      try {
        const existing = await findOpenPull(client, owner, name, ws.branch);
        const pull = existing ?? (await openPull(client, owner, name, { title, body, head: ws.branch, base: baseRef, draft: args.draft }));
        recordPull(store, ctx, { repoId: row.repoId, repo: remote.repo, pull, headRef: ws.branch, baseRef, parentBranches: parents.map((p) => p.branch) });
        if (!existing) await assignOrNote(store, client, ctx.runId, { owner, repo: name, number: pull.number, assignee: remote.account });
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

/** Con qué base y qué padres se abre el PR, y la punta de la branch (`head`, que cambia si hubo que rehacer la base). */
interface SettledBase {
  head: string;
  baseRef: string;
  parents: CombinedBaseParent[];
}

/**
 * La base con que sale el PR. Con una base combinada el PR apunta al primer padre (GitHub admite una sola base y el
 * resto viaja en los merges de la branch); apilado, a la branch de su padre. Si alguno de esos padres ya se mergeó o
 * cerró (se pregunta a GitHub, no al caché: Watch puede ir atrás), la base se recalcula como lo haría `stack.restack`
 * con los que siguen abiertos, o es la branch por defecto si no queda ninguno. Los commits propios (`tip` es el
 * último) se rehacen sobre la base nueva antes de pushear nada, así que nada se fuerza. Si no se pueden rehacer
 * (conflicto, merge de otra branch), la branch queda como estaba, el PR se abre igual sobre la base correcta, y
 * una nota deja avisado; Watch levanta el conflicto si es real. Sin padres cerrados no cambia nada.
 */
async function settleBase(deps: PrPublishDeps, runId: RunId, ws: WorkspaceRef, row: typeof workspaceRows.$inferSelect, tip: string): Promise<SettledBase> {
  const { store, workspaces } = deps;
  const { remote, defaultBranch } = deps.repos(row.repoId);
  if (!remote) throw new PermanentActionError(`El repo ${row.repoId} no tiene remoto configurado: no se puede publicar.`);
  const combined = store.db
    .select()
    .from(combinedBases)
    .where(and(eq(combinedBases.repoId, row.repoId), eq(combinedBases.branch, row.baseRef), eq(combinedBases.status, "active")))
    .get();
  const declared = combined?.parents ?? [];
  const unchanged = { head: tip, baseRef: declared[0]?.branch ?? row.baseRef, parents: declared };
  const watched = combined ? declared.map((parent) => parent.branch) : row.baseRef === defaultBranch ? [] : [row.baseRef];
  if (watched.length === 0) return unchanged;

  const [owner = "", name = ""] = remote.repo.split("/");
  const client = deps.connections.githubClient(remote.account);
  const open = new Set<string>();
  try {
    for (const branch of watched) {
      const { data } = await client.request("GET /repos/{owner}/{repo}/pulls", { owner, repo: name, head: `${owner}:${branch}`, state: "all" });
      const pulls = z.array(z.object({ state: z.enum(["open", "closed"]) })).parse(data);
      // Sin ningún PR no hay cómo saber que se mergeó: se deja como estaba.
      if (pulls.length === 0 || pulls.some((pull) => pull.state === "open")) open.add(branch);
    }
  } catch (error) {
    if (error instanceof RequestError && error.status === 401) deps.connections.markRevoked("github", remote.account, "core");
    throw error;
  }
  if (watched.every((branch) => open.has(branch))) return unchanged;

  if ((await workspaces.fetch(row.repoId)) === "unauthorized") {
    throw new Error(`GitHub rechazó el token de ${remote.account}: reconecta la cuenta para publicar ${ws.branch}.`);
  }
  const parents = declared.filter((parent) => open.has(parent.branch));
  const baseRef = parents[0]?.branch ?? defaultBranch;
  let result;
  try {
    result = combined
      ? await workspaces.restackCombined(ws, { council: false, branch: row.baseRef, parents })
      : await workspaces.restack(ws, {
          council: false,
          onto: await workspaces.git(ws, "rev-parse", `refs/remotes/origin/${defaultBranch}`),
          from: workspaces.baseSha(ws),
          base: defaultBranch,
        });
  } catch (error) {
    if (!(error instanceof RebaseError)) throw error;
    result = { outcome: "error" as const, failures: error.message };
  }
  if (result.outcome === "restacked" || result.outcome === "uptodate") {
    return { head: await workspaces.git(ws, "rev-parse", "HEAD"), baseRef, parents };
  }
  const why = "failures" in result ? result.failures : result.outcome;
  store.tx((tx) =>
    openDecision(tx, {
      kind: "note",
      title: `${ws.branch} sale sobre ${baseRef} sin recalcular su base`,
      body: `Su base (${watched.join(", ")}) ya se mergeó o cerró y no se pudo rehacer la branch sobre ${baseRef}: ${why}. El PR se abre sobre ${baseRef} con la historia que tenía; si choca, el flujo de rebase por conflicto lo toma.`,
      runId,
    }),
  );
  return { head: tip, baseRef, parents };
}

/** La key de la issue de la corrida, o `undefined` si la corrida no es de una issue o su tracker no le da key. */
function issueKey(store: Store, runId: RunId): string | undefined {
  const run = store.db.select().from(runs).where(eq(runs.id, runId)).get();
  if (run?.subjectType !== "issue") return undefined;
  return store.db.select({ key: issues.key }).from(issues).where(eq(issues.id, run.subjectId as IssueId)).get()?.key || undefined;
}

/** El título como `[KEY] título`: un `[KEY]` que ya traiga, al inicio, al final o en medio, se saca y queda solo al inicio. */
export function titleWithKey(title: string, key: string | undefined): string {
  if (!key) return title;
  const bare = title.replaceAll(`[${key}]`, " ").replace(/\s+/g, " ").trim();
  return bare ? `[${key}] ${bare}` : `[${key}]`;
}

/**
 * Asigna el PR a la cuenta con que se publicó. Un fallo (p. ej. sin permiso) no tumba la publicación: queda una nota
 * en la Bandeja. Un 401 sí lo relanza, para que el flujo del 401 de `pr.publish` marque la conexión revocada.
 */
async function assignOrNote(store: Store, client: GitHubClient, runId: RunId, pr: { owner: string; repo: string; number: number; assignee: string }): Promise<void> {
  try {
    await client.request("POST /repos/{owner}/{repo}/issues/{issue_number}/assignees", {
      owner: pr.owner,
      repo: pr.repo,
      issue_number: pr.number,
      assignees: [pr.assignee],
    });
  } catch (error) {
    if (error instanceof RequestError && error.status === 401) throw error;
    const why = error instanceof Error ? error.message : String(error);
    store.tx((tx) =>
      openDecision(tx, {
        kind: "note",
        title: `${pr.owner}/${pr.repo}#${pr.number} quedó sin assignee`,
        body: `No se pudo asignar el PR a ${pr.assignee}: ${why}. La publicación siguió; asígnalo a mano si hace falta.`,
        runId,
      }),
    );
  }
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
  { repoId, repo, pull, headRef, baseRef, parentBranches }: { repoId: string; repo: string; pull: Pull; headRef: string; baseRef: string; parentBranches: string[] },
): void {
  const run = store.db.select().from(runs).where(eq(runs.id, ctx.runId)).get();
  store.tx((tx) => {
    const { db, emit } = tx;
    const values = {
      nodeId: pull.node_id,
      headRef,
      baseRef,
      headSha: pull.head.sha,
      state: pull.state,
      isDraft: pull.draft,
      issueId: run?.subjectType === "issue" ? run.subjectId : null,
      runId: ctx.runId,
      owned: true,
      headChangedAt: Date.now(),
    };
    // Si Watch ya lo había descubierto (un reintento tras un corte entre abrirlo y guardarlo) la fila existe
    // sin `owned`: se adopta. Una fila ya `owned` es un reintento de este mismo registro y no se toca.
    const saved = db
      .insert(pullRequests)
      .values({ id: newId("pr"), repoId, number: pull.number, ...values })
      .onConflictDoUpdate({ target: [pullRequests.repoId, pullRequests.number], set: values, setWhere: eq(pullRequests.owned, false) })
      .returning({ id: pullRequests.id })
      .get();
    if (!saved) return;
    // La corrida de la issue también es la dueña del PR: un council o un rebase sobre él espera a que ella termine o se estacione.
    claimPr(tx, ctx.runId, saved.id);
    // Su base es la branch de otro PR abierto del repo (o, con base combinada, de varios): cuelga de ellos hasta que se mergeen (`stack.restack`).
    const parents = db
      .select({ id: pullRequests.id })
      .from(pullRequests)
      .where(and(eq(pullRequests.repoId, repoId), inArray(pullRequests.headRef, [baseRef, ...parentBranches]), eq(pullRequests.state, "open")))
      .all();
    for (const parent of parents) db.insert(prParents).values({ childId: saved.id, parentId: parent.id }).run();
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

/**
 * El cuerpo sin las secciones omitidas, con arriba el aviso de la base combinada (si el PR tiene `combined`: sus
 * padres en orden) y el de dependencia si el PR está apilado.
 */
function prBody(body: string, omit: string[], dependsOn: string[], combined: readonly CombinedBaseParent[]): string {
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
  const notes = [
    ...(combined.length > 1
      ? [
          `Base combinada: este PR apunta a \`${combined[0]!.branch}\` (${combined[0]!.key}) pero también trae los commits de ${combined
            .slice(1)
            .map((parent) => `${parent.key} (\`${parent.branch}\`)`)
            .join(", ")}. Al mergearse un padre, la base se recalcula y el PR cambia de base solo.`,
        ]
      : []),
    ...(dependsOn.length > 0 ? [`Depende de ${dependsOn.join(", ")}`] : []),
  ];
  return [...notes, text].join("\n\n").trim();
}

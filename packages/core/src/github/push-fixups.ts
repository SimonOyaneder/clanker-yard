import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { and, eq } from "drizzle-orm";
import * as z from "zod";
import { ApplyArgs, cleanMessage, CONVENTIONAL_COMMIT, patchOf } from "../commits/apply";
import { preparePush } from "../commits/prepare-push";
import { branchCommits, fixupMessage, FIXUP_PREFIX, oldRange, routeHunks } from "../commits/route";
import { PermanentActionError, type ActionCtx, type ActionDef, type ActionResult } from "../flows/catalog";
import { diffBetween, listHunks, snapshotTree, type Hunk } from "../git/tree";
import { pullRequests, workspaces as workspaceRows } from "../store/schema";
import type { Store } from "../store/store";
import type { RepoConfig, Workspaces } from "../workspaces/workspaces";
import type { Prs } from "./prs";
import { pushOrThrow } from "./push";

const PushFixupsArgs = z.object({
  ws: ApplyArgs.shape.ws,
  /**
   * Lo que el flujo va a contestar en el PR (los ítems del triage): `byItem` dice en qué commit quedó el
   * arreglo de cada uno. Con `path` (y `line`, la línea de `HEAD` que el hallazgo señala) es el commit
   * que cambió ahí; sin eso o sin cambio ahí, la punta que quedó pusheada.
   */
  items: z
    .array(z.object({ id: z.string(), path: z.string().optional(), line: z.int().positive().optional() }))
    .nullish()
    .transform((items) => items ?? []),
  /**
   * El reporte del committer en modo route (`CommitRoute`): los commits nuevos de los hunks que devolvió
   * esta acción en `unrouted`, que se numeran igual mientras el worktree no cambie. De él solo lee `commits[{ message, hunks }]`.
   */
  route: z
    .object({ commits: z.array(z.object({ message: z.string(), hunks: z.array(z.string()) })) })
    .nullish()
    .transform((route) => route ?? undefined),
  /** Regex que debe cumplir la primera línea del mensaje de cada commit nuevo. Por defecto, Conventional Commits. */
  messagePattern: ApplyArgs.shape.messagePattern,
});

export interface PrPushFixupsDeps {
  store: Store;
  workspaces: Workspaces;
  repos: (repoId: string) => RepoConfig;
  prs: Pick<Prs, "get">;
}

/** Un commit que hizo la acción y los trozos de archivo que cambió, para ligarlo con los ítems. */
interface Made {
  sha: string;
  /** El commit donde el cambio queda al terminar el squash: el destino de un `fixup!`, o el propio commit nuevo. */
  lands: string;
  spans: { path: string; from: number; to: number }[];
}

type Committed = { made: Made[] } | { route: { unrouted: string[]; failures?: string } };

/**
 * `pr.pushFixups` (`docs/design.html#d-flows`, Fixups): lo que el dev cambió después del triage del bot
 * (o de un thread de council) sale como `fixup!` del commit al que pertenece, y solo se pushea cuando
 * todo tiene destino. Tres etapas con `ctx.once`, así que un reintento tras un corte retoma donde quedó.
 *
 * - `council`: si el PR tuvo threads `[clanker-council]` (`PrState.threads.councilEver`), los `fixup!` quedan
 *   visibles: sin autosquash y con un push que nunca fuerza. Si no, `preparePush` hace el autosquash y el
 *   push es con lease.
 * - `commit`: reconcilia los commits que el agente hizo por su cuenta (`preparePush` en modo council, que
 *   no squashea) y parte el diff de `HEAD` contra el worktree en hunks (`routeHunks`: el destino sale de
 *   `git blame`). Un `fixup!` por commit destino. Con hunks sin destino no commitea nada y devuelve el
 *   outcome `route` con sus ids (`unrouted`); el flujo llama al committer en modo route y vuelve a esta
 *   acción con su reporte en `route`, que se vuelve commits nuevos encima de los `fixup!`. Si algo
 *   falla, la branch vuelve a donde estaba (el worktree no se toca).
 * - `push`: `preparePush` y `workspaces.push` con lease (o sin forzar, con council).
 *
 * Los commits que el agente haya hecho por su cuenta y no cuadren con el worktree vuelven a ser cambios
 * sin commitear (`reset --mixed`), así que pasan por el mismo ruteo que cualquier otro cambio.
 *
 * Outcomes: `ok` (output `byItem`, id → sha pusheado, y `head`) y `route`.
 */
export function prPushFixupsAction(deps: PrPushFixupsDeps): ActionDef<typeof PushFixupsArgs> {
  const { store, workspaces } = deps;

  async function pushFixups(args: z.infer<typeof PushFixupsArgs>, ctx: ActionCtx): Promise<ActionResult> {
    const { ws, items } = args;
    const row = store.db.select().from(workspaceRows).where(eq(workspaceRows.id, ws.workspaceId)).get();
    if (!row) throw new PermanentActionError(`No existe el workspace ${ws.workspaceId}.`);
    const { remote } = deps.repos(row.repoId);
    if (!remote) throw new PermanentActionError(`El repo ${row.repoId} no tiene remoto configurado: no se puede pushear.`);
    const pull = store.db
      .select()
      .from(pullRequests)
      .where(and(eq(pullRequests.repoId, row.repoId), eq(pullRequests.headRef, ws.branch), eq(pullRequests.state, "open")))
      .get();
    if (!pull || !row.remoteSha) {
      throw new PermanentActionError(`${ws.branch} no tiene un PR abierto pusheado: no hay a qué pushear fixups.`);
    }
    // Watch también deja en `pull_requests` los PRs tuyos que el sistema no abrió: a esos no se les pushea.
    if (!pull.owned) {
      throw new PermanentActionError(`El PR #${pull.number} de ${remote.repo} no lo abrió Clanker Yard: no se le pushean fixups.`);
    }
    const base = workspaces.baseSha(ws);
    const knownSha = row.remoteSha;

    const council = await ctx.once("council", async () => {
      const state = await deps.prs.get({ account: remote.account, repo: remote.repo, number: pull.number });
      return state.threads.councilEver;
    });

    const committed = await ctx.once("commit", () => commit(args, { knownSha, base }));
    if ("route" in committed) return { outcome: "route", output: committed.route };
    const { made } = committed;

    const pushed = await ctx.once("push", async () => {
      const before = (await branchCommits(workspaces, ws, base)).filter((c) => !c.subject.startsWith(FIXUP_PREFIX));
      // La etapa `commit` ya reconcilió; desde `HEAD` no hay nada que reconciliar (y tras un corte
      // posterior al squash, la punta de `commit` ya no existe).
      const head = await workspaces.git(ws, "rev-parse", "HEAD");
      const prepared = await preparePush(workspaces, ws, { knownSha: head, base, council });
      if (prepared.outcome !== "ok") throw new PermanentActionError(prepared.failures);
      await pushOrThrow(workspaces, ws, remote.account, { council });
      // El squash reescribe los shas pero deja los commits en orden: el n-ésimo de antes es el n-ésimo de ahora.
      const after = (await branchCommits(workspaces, ws, base)).filter((c) => !c.subject.startsWith(FIXUP_PREFIX));
      if (after.length !== before.length) {
        throw new PermanentActionError(`El squash de ${ws.branch} dejó ${after.length} commits y había ${before.length}.`);
      }
      const rewritten: Record<string, string> = {};
      for (const [i, commit] of before.entries()) rewritten[commit.sha] = after[i]!.sha;
      return { head: prepared.head, rewritten };
    });

    const byItem: Record<string, string> = {};
    for (const { id, path, line } of items) {
      const hit = made.find((m) =>
        m.spans.some((s) => s.path === path && (line === undefined || (s.from <= line && line <= s.to))),
      );
      byItem[id] = hit === undefined ? pushed.head : council ? hit.sha : (pushed.rewritten[hit.lands] ?? pushed.head);
    }
    return { outcome: "ok", output: { byItem, head: pushed.head } };
  }

  async function commit(
    { ws, route, messagePattern }: z.infer<typeof PushFixupsArgs>,
    { knownSha, base }: { knownSha: string; base: string },
  ): Promise<Committed> {
    // `replan` aquí es "vuelve a la última punta conocida": lo que el agente hizo queda sin commitear y se rutea.
    await preparePush(workspaces, ws, { knownSha, base, council: true });
    const head = await workspaces.git(ws, "rev-parse", "HEAD");
    const saved = await snapshotTree(ws.path);
    const hunks = listHunks(await diffBetween(ws.path, head, saved));
    if (hunks.length === 0) return { made: [] };

    const commits = await branchCommits(workspaces, ws, base);
    const { fixups, unrouted } = await routeHunks(workspaces, ws, hunks, commits);

    const planned: { message: string; hunks: Hunk[] }[] = [];
    if (unrouted.length > 0) {
      const problems = route === undefined ? [] : routeProblems(route.commits, unrouted, messagePattern);
      if (route === undefined || problems.length > 0) {
        return { route: { unrouted: unrouted.map((h) => h.id), ...(problems.length > 0 && { failures: problems.join("\n") }) } };
      }
      for (const { message, hunks: ids } of route.commits) {
        planned.push({ message: cleanMessage(message), hunks: ids.map((id) => unrouted.find((h) => h.id === id)!) });
      }
    }

    const dir = mkdtempSync(join(tmpdir(), "clanker-fixups-"));
    const made: Made[] = [];
    try {
      // El index al estado de `HEAD`: lo que el agente haya dejado en staging no se cuela en un commit.
      await workspaces.git(ws, "reset", "--quiet", "--mixed", "HEAD");
      const steps = [
        ...fixups.map((f) => ({ message: fixupMessage(f.target, commits), hunks: f.hunks, lands: f.target.sha })),
        ...planned.map((p) => ({ ...p, lands: undefined })),
      ];
      for (const [i, step] of steps.entries()) {
        const patch = join(dir, `${i + 1}.patch`);
        writeFileSync(patch, patchOf(step.hunks, hunks));
        await workspaces.git(ws, "apply", "--cached", "--whitespace=nowarn", patch);
        await workspaces.git(ws, "commit", "--quiet", "--message", step.message);
        const sha = await workspaces.git(ws, "rev-parse", "HEAD");
        made.push({ sha, lands: step.lands ?? sha, spans: step.hunks.map((h) => ({ path: h.path, ...oldRange(h) })) });
      }
      if (made.length > 0 && (await workspaces.git(ws, "rev-parse", "HEAD^{tree}")) !== saved) {
        throw new PermanentActionError(
          `Los commits de ${ws.branch} no dejan el árbol del worktree (¿un hook cambió archivos al commitear?).`,
        );
      }
      return { made };
    } catch (error) {
      await workspaces.git(ws, "reset", "--quiet", "--mixed", head);
      throw error;
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  return {
    name: "pr.pushFixups",
    args: PushFixupsArgs,
    outcomes: ["ok", "route"],
    effects: "remote",
    run: pushFixups,
  };
}

/** Lo que impide aplicar el reporte del committer, una línea por problema. Vacío: cubre cada hunk sin destino una vez. */
function routeProblems(commits: { message: string; hunks: string[] }[], unrouted: Hunk[], messagePattern: string | undefined): string[] {
  const problems: string[] = [];
  const pattern = messagePattern === undefined ? CONVENTIONAL_COMMIT : new RegExp(messagePattern);
  const assigned = new Set<string>();
  for (const [i, commit] of commits.entries()) {
    const subject = cleanMessage(commit.message).split("\n")[0]!;
    const label = `commit ${i + 1} "${subject}"`;
    if (!pattern.test(subject)) problems.push(`[${label}] el mensaje no cumple ${pattern}`);
    if (commit.hunks.length === 0) problems.push(`[${label}] no tiene hunks`);
    for (const id of commit.hunks) {
      if (!unrouted.some((h) => h.id === id)) problems.push(`[${label}] usa el hunk ${id}, que no está entre los hunks sin destino`);
      else if (assigned.has(id)) problems.push(`[${label}] usa el hunk ${id}, que ya es de otro commit`);
      assigned.add(id);
    }
  }
  const missing = unrouted.filter((h) => !assigned.has(h.id));
  if (missing.length > 0) problems.push(`Hunks sin asignar a ningún commit: ${missing.map((h) => `${h.id} ${h.path} ${h.header}`).join("; ")}`);
  return problems;
}

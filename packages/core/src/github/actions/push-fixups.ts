import type { RepoId } from "@clanker/api";
import { and, eq } from "drizzle-orm";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as z from "zod";
import { ApplyArgs, cleanMessage, CONVENTIONAL_COMMIT, patchOf } from "../../commits/apply";
import { preparePush } from "../../commits/prepare-push";
import { branchCommits, fixupMessage, FIXUP_PREFIX, hunkOwners, oldRange, routeHunks, type BranchCommit } from "../../commits/route";
import { PermanentActionError, type ActionCtx, type ActionDef, type ActionResult } from "../../flows/catalog";
import { diffBetween, listHunks, snapshotTree, type Hunk } from "../../git/tree";
import { pullRequests, workspaces as workspacesTable } from "../../store/schema";
import type { Store } from "../../store/store";
import type { RepoConfig } from "../../repos/repos";
import type { Workspaces, WorkspaceRef } from "../../workspaces/workspaces";
import type { Prs } from "../prs";
import { ownedOpenPr, pushOrThrow, type PrPurpose } from "./push";

/** Para qué toma `pr.pushFixups` el PR de la branch (`ownedOpenPr`). */
const FIXUPS: PrPurpose = { needsRemote: "pushear", missing: "no hay un PR al que aplicar fixups", notOwned: "no se le aplican fixups" };

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
   * esta acción en `unrouted`, que se numeran igual mientras el worktree no cambie. De él solo lee
   * `commits[{ message, hunks, into }]`: con `into`, los hunks van como `fixup!` de ese commit del PR.
   */
  route: z
    .object({ commits: z.array(z.object({ message: z.string(), hunks: z.array(z.string()), into: z.string().optional() })) })
    .nullish()
    .transform((route) => route ?? undefined),
  /** Regex que debe cumplir la primera línea del mensaje de cada commit nuevo. Por defecto, Conventional Commits. */
  messagePattern: ApplyArgs.shape.messagePattern,
});

export interface PrPushFixupsDeps {
  store: Store;
  workspaces: Workspaces;
  repoConfig: (repoId: RepoId) => RepoConfig;
  prs: Pick<Prs, "get">;
}

/** Un commit que hizo la acción y los trozos de archivo que cambió, para ligarlo con los ítems. */
interface Made {
  sha: string;
  /** El commit donde el cambio queda al terminar el squash: el destino de un `fixup!`, o el propio commit nuevo. */
  lands: string;
  spans: { path: string; from: number; to: number }[];
}

type CommitPlan = {
  head: string;
  saved: string;
  hunks: Hunk[];
  steps: { message: string; hunks: Hunk[]; lands?: string }[];
};

type Planned = CommitPlan | { route: { unrouted: string[]; commits: { sha: string; subject: string }[]; failures?: string } };

/**
 * `pr.pushFixups` (`docs/design.html#d-flows`, Fixups): lo que el dev cambió después del triage del bot
 * (o de un thread de council) sale como `fixup!` del commit al que pertenece, y solo se pushea cuando
 * todo tiene destino. Las etapas con `ctx.once` conservan la punta inicial y retoman donde quedaron tras un corte.
 *
 * - `council`: si el PR tuvo threads `[clanker-council]` (`PrState.threads.councilEver`), los `fixup!` quedan
 *   visibles: sin autosquash y con un push que nunca fuerza. Si no, `preparePush` hace el autosquash y el
 *   push es con lease.
 * - `plan` y `commit`: reconcilia los commits que el agente hizo por su cuenta (`preparePush` en modo council, que
 *   no squashea) y parte el diff de `HEAD` contra el worktree en hunks (`routeHunks`: el destino sale de
 *   `git blame`). Un `fixup!` por commit destino. Con hunks sin destino no commitea nada y devuelve el
 *   outcome `route` con sus ids (`unrouted`) y los commits del PR (`commits`); el flujo llama al committer en
 *   modo route y vuelve a esta acción con su reporte en `route`: los hunks con `into` se suman a los `fixup!`
 *   de ese commit y el resto se vuelven commits nuevos encima. Si algo
 *   falla, la branch vuelve a donde estaba (el worktree no se toca).
 * - `push`: `preparePush` y `workspaces.push` con lease (o sin forzar, con council); en un PR local, sin council,
 *   guarda la punta en la fila sin push.
 *
 * Los commits que el agente haya hecho por su cuenta y no cuadren con el worktree vuelven a ser cambios
 * sin commitear (`reset --mixed`), así que pasan por el mismo ruteo que cualquier otro cambio.
 *
 * Outcomes: `ok` (output `byItem`, id → sha final, `head`, `from` inicial y `to` final) y `route`.
 */
export function prPushFixupsAction(deps: PrPushFixupsDeps): ActionDef<typeof PushFixupsArgs> {
  const { store, workspaces } = deps;

  async function pushFixups(args: z.infer<typeof PushFixupsArgs>, ctx: ActionCtx): Promise<ActionResult> {
    const { ws, items } = args;
    const localPr = store.db
      .select({ id: pullRequests.id, headSha: pullRequests.headSha })
      .from(pullRequests)
      .innerJoin(workspacesTable, eq(workspacesTable.repoId, pullRequests.repoId))
      .where(and(
        eq(workspacesTable.id, ws.workspaceId),
        eq(pullRequests.headRef, ws.branch),
        eq(pullRequests.state, "local"),
        eq(pullRequests.owned, true),
      ))
      .get();
    const published = localPr ? undefined : ownedOpenPr(deps, ws, FIXUPS);
    const knownSha = localPr?.headSha ?? published!.remoteSha;
    const base = workspaces.baseSha(ws);
    const from = await ctx.once("from", () => workspaces.git(ws, "rev-parse", "HEAD"));

    const council = await ctx.once("council", async () => {
      return published ? (await deps.prs.get(published.ref)).threads.councilEver : false;
    });

    const planned = await ctx.once("plan", () => planCommits(args, { knownSha, base }));
    if ("route" in planned) return { outcome: "route", output: planned.route };
    const { made } = await ctx.once("commit", async () => ({ made: await commit(ws, planned) }));
    const before = await ctx.once("before-squash", async () =>
      (await branchCommits(workspaces, ws, base)).filter((c) => !c.subject.startsWith(FIXUP_PREFIX)),
    );

    const pushed = await ctx.once("push", async () => {
      const head = await workspaces.git(ws, "rev-parse", "HEAD");
      const prepared = await preparePush(workspaces, ws, { knownSha: head, base, council });
      if (prepared.outcome !== "ok") throw new PermanentActionError(prepared.failures);
      if (localPr) {
        store.tx(({ db }) => {
          workspaces.validate(ws);
          db.update(pullRequests).set({ headSha: prepared.head, headChangedAt: Date.now() }).where(eq(pullRequests.id, localPr.id)).run();
        });
      } else {
        await pushOrThrow(workspaces, ws, published!.remote.account, { council });
      }
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
    return { outcome: "ok", output: { byItem, head: pushed.head, from, to: pushed.head } };
  }

  async function planCommits(
    { ws, route, messagePattern }: z.infer<typeof PushFixupsArgs>,
    { knownSha, base }: { knownSha: string; base: string },
  ): Promise<Planned> {
    // `replan` aquí es "vuelve a la última punta conocida": lo que el agente hizo queda sin commitear y se rutea.
    await preparePush(workspaces, ws, { knownSha, base, council: true, messagePattern });
    const head = await workspaces.git(ws, "rev-parse", "HEAD");
    const saved = await snapshotTree(ws.path);
    const hunks = listHunks(await diffBetween(ws.path, head, saved));
    if (hunks.length === 0) return { head, saved, hunks, steps: [] };

    const commits = await branchCommits(workspaces, ws, base);
    const { fixups, unrouted } = await routeHunks(workspaces, ws, hunks, commits);

    const planned: { message: string; hunks: Hunk[] }[] = [];
    if (unrouted.length > 0) {
      const targets = commits.filter((c) => !c.subject.startsWith(FIXUP_PREFIX));
      const problems = route === undefined ? [] : await routeProblems(route.commits, unrouted, { targets, commits, messagePattern, owners: hunkOwners(workspaces, ws, commits) });
      if (route === undefined || problems.length > 0) {
        return {
          route: {
            unrouted: unrouted.map((h) => h.id),
            commits: targets.map(({ sha, subject }) => ({ sha, subject })),
            ...(problems.length > 0 && { failures: problems.join("\n") }),
          },
        };
      }
      for (const { message, hunks: ids, into } of route.commits) {
        const routed = ids.map((id) => unrouted.find((h) => h.id === id)!);
        const target = into === undefined ? undefined : intoTarget(targets, into)!;
        if (target === undefined) {
          planned.push({ message: cleanMessage(message), hunks: routed });
          continue;
        }
        const existing = fixups.find((f) => f.target.sha === target.sha);
        if (existing) existing.hunks.push(...routed);
        else fixups.push({ target, hunks: routed });
      }
      fixups.sort((a, b) => commits.indexOf(a.target) - commits.indexOf(b.target));
    }

    return {
      head,
      saved,
      hunks,
      steps: [
        ...fixups.map((f) => ({ message: fixupMessage(f.target, commits), hunks: f.hunks, lands: f.target.sha })),
        ...planned,
      ],
    };
  }

  async function commit(ws: WorkspaceRef, { head, saved, hunks, steps }: CommitPlan): Promise<Made[]> {
    if (steps.length === 0) return [];
    const dir = mkdtempSync(join(tmpdir(), "clanker-fixups-"));
    const made: Made[] = [];
    try {
      await workspaces.git(ws, "reset", "--quiet", "--mixed", head);
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
      return made;
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

/** El commit del PR que nombra `into` (su sha o un prefijo de 7+ caracteres); `undefined` si no hay uno solo. */
function intoTarget(targets: BranchCommit[], into: string): BranchCommit | undefined {
  const sha = into.trim().toLowerCase();
  const matches = sha.length >= 7 ? targets.filter((c) => c.sha.startsWith(sha)) : [];
  return matches.length === 1 ? matches[0] : undefined;
}

/**
 * Lo que impide aplicar el reporte del committer, una línea por problema. Vacío: cubre cada hunk sin destino una vez.
 * Un `into` anterior a un commit del que depende el hunk (el que creó su archivo, o el dueño de líneas que quita o
 * que quedan pegadas) se rechaza aquí: el autosquash pondría el `fixup!` donde esas líneas aún no existen y chocaría.
 */
async function routeProblems(
  route: { message: string; hunks: string[]; into?: string }[],
  unrouted: Hunk[],
  { targets, commits, messagePattern, owners }: {
    targets: BranchCommit[];
    commits: BranchCommit[];
    messagePattern: string | undefined;
    owners: ReturnType<typeof hunkOwners>;
  },
): Promise<string[]> {
  const problems: string[] = [];
  const pattern = messagePattern === undefined ? CONVENTIONAL_COMMIT : new RegExp(messagePattern);
  const subjects = new Set(targets.map((c) => c.subject));
  const assigned = new Set<string>();
  for (const [i, commit] of route.entries()) {
    const subject = cleanMessage(commit.message).split("\n")[0]!;
    const label = commit.into === undefined ? `commit ${i + 1} "${subject}"` : `commit ${i + 1} (into ${commit.into})`;
    const target = commit.into === undefined ? undefined : intoTarget(targets, commit.into);
    if (commit.into !== undefined) {
      if (target === undefined) problems.push(`[${label}] ${commit.into} no es el sha de un único commit del PR`);
    } else {
      if (!pattern.test(subject)) problems.push(`[${label}] el mensaje no cumple ${pattern}`);
      if (subjects.has(subject)) problems.push(`[${label}] repite el título de un commit del PR: si sus hunks son de ese commit, usa \`into\` con su sha`);
    }
    if (commit.hunks.length === 0) problems.push(`[${label}] no tiene hunks`);
    for (const id of commit.hunks) {
      const hunk = unrouted.find((h) => h.id === id);
      if (hunk === undefined) problems.push(`[${label}] usa el hunk ${id}, que no está entre los hunks sin destino`);
      else if (assigned.has(id)) problems.push(`[${label}] usa el hunk ${id}, que ya es de otro commit`);
      else if (target !== undefined) {
        const { removed, adjacent, born } = await owners(hunk);
        const needed = commits[Math.max(removed ?? -1, adjacent, born)];
        if (needed !== undefined && commits.indexOf(target) < commits.indexOf(needed)) {
          problems.push(
            `[${label}] el hunk ${id} (${hunk.path}) depende de ${needed.sha.slice(0, 9)} "${needed.subject}", posterior a ${commit.into}: ` +
              `ahí su archivo o sus líneas todavía no existen y el autosquash chocaría. Usa \`into\` con ese commit o uno posterior`,
          );
        }
      }
      assigned.add(id);
    }
  }
  const missing = unrouted.filter((h) => !assigned.has(h.id));
  if (missing.length > 0) problems.push(`Hunks sin asignar a ningún commit: ${missing.map((h) => `${h.id} ${h.path} ${h.header}`).join("; ")}`);
  return problems;
}

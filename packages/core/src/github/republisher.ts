import type { IssueId, PrRef, PrRepublish, RepublishInput, RunId } from "@clanker/api";
import { RequestError } from "@octokit/request-error";
import { and, eq, inArray, or } from "drizzle-orm";
import * as z from "zod";
import type { Connections } from "../connections/connections";
import type { Engine } from "../flows/engine";
import type { FetchOutcome } from "../git/remote";
import { freshIssueBranch } from "../projects/branch-name";
import type { Projects } from "../projects/projects";
import { prParents, pullRequests, runs } from "../store/schema";
import type { Store } from "../store/store";
import type { Issues } from "../tracker/issues";
import type { Repos } from "../workspaces/repos";
import type { Prs } from "./prs";

export interface PrRepublisherDeps {
  store: Store;
  repos: Pick<Repos, "config">;
  issues: Pick<Issues, "get">;
  projects: Pick<Projects, "get">;
  flows: Pick<Engine, "start" | "getRun">;
  connections: Pick<Connections, "githubClient" | "markRevoked">;
  prs: Pick<Prs, "get">;
  /** `workspaces.fetch`: trae las branches del remoto, que `pr.replay` y los nombres nuevos necesitan al día. */
  fetchRepo(repoId: string): Promise<FetchOutcome>;
  /** Cada cuántos ms mira si la corrida terminó. */
  pollMs?: number;
}

export interface PrRepublisher {
  /**
   * `prs.republish`: por cada PR abierto del sistema (`owned` y de una issue), en orden de stack (un padre antes que sus
   * hijos), lanza el flujo `republish-pr` y espera a que termine. Así, con la implementación intacta, el PR sale de
   * nuevo con la branch de hoy (`freshIssueBranch`; creada sobre la branch nueva del padre si estaba apilado), los commits
   * que corta el committer con las reglas vigentes y el autor del repo; el viejo queda cerrado con "Reemplazado por #n".
   *
   * Un PR se salta, con su razón, si la issue tiene una corrida viva, si GitHub ya no lo tiene abierto, si tiene threads
   * sin resolver de council o de humanos (o humanos que comentaron: rehacerlo perdería ese contexto), si tiene base
   * combinada (varios padres) o si ya es un PR republicado ("Reemplaza a #n"). Un padre que no se rehízo (salteado o
   * fallido) salta a sus hijos; los errores son por PR y no frenan a los demás. Con `dryRun` solo se leen GitHub y el
   * caché: no se lanza ninguna corrida, no cuesta nada y `commits` es lo que tiene hoy el PR viejo.
   */
  republish(input: RepublishInput): Promise<PrRepublish[]>;
}

/** Estados en que una corrida sigue usando su issue y su branch (`runs_active_flow_subject`). */
const LIVE = ["queued", "running", "waiting", "parked", "paused"] as const;
/** La línea que `republish-pr` agrega al cuerpo del PR nuevo. */
const REPLACES = /^Reemplaza a #\d+\s*$/m;

const Pull = z.object({
  title: z.string(),
  body: z.string().nullable(),
  state: z.enum(["open", "closed"]),
  draft: z.boolean(),
  commits: z.int().nonnegative().default(0),
  head: z.object({ ref: z.string(), sha: z.string() }),
  base: z.object({ ref: z.string() }),
});

type PrRow = typeof pullRequests.$inferSelect;

export function createPrRepublisher(deps: PrRepublisherDeps): PrRepublisher {
  const { store, flows } = deps;
  const pollMs = deps.pollMs ?? 1000;

  return {
    async republish({ projectId, prs: numbers = [], dryRun = false, draftOnly = false }) {
      const rows = store.db
        .select()
        .from(pullRequests)
        .where(and(eq(pullRequests.state, "open"), eq(pullRequests.owned, true)))
        .all()
        .filter((row) => row.issueId !== null && (!draftOnly || row.isDraft) && (numbers.length === 0 || numbers.includes(row.number)));
      const results: PrRepublish[] = [];
      /** Qué pasó con cada PR del lote: sus hijos lo consultan. */
      const done = new Map<string, { branch: string } | { skipped: string }>();
      const reserved = new Map<string, Set<string>>();
      const fetched = new Set<string>();

      for (const row of inStackOrder(store, rows)) {
        const issue = deps.issues.get(row.issueId as IssueId);
        if (!issue) {
          results.push({ repo: row.repoId, number: row.number, status: "skipped", reason: "la issue no está en el caché" });
          continue;
        }
        if (projectId !== undefined && issue.projectId !== projectId) continue;
        const base = { repo: row.repoId, number: row.number };
        const skip = (reason: string): void => {
          done.set(row.id, { skipped: reason });
          results.push({ ...base, status: "skipped", reason });
        };

        const parent = parentsOf(store, row).map((p) => ({ row: p, outcome: done.get(p.id) })).find((p) => p.outcome && "skipped" in p.outcome);
        if (parent) {
          skip(`su padre #${parent.row.number} no se rehízo (${(parent.outcome as { skipped: string }).skipped})`);
          continue;
        }
        const live = liveRun(store, row);
        if (live) {
          skip(`la corrida ${live} sigue viva`);
          continue;
        }
        const config = deps.repos.config(row.repoId);
        if (!config.remote) {
          skip("el repo no tiene remoto de GitHub");
          continue;
        }
        const { account, repo } = config.remote;
        const [owner = "", name = ""] = repo.split("/");

        try {
          const pull = await readPull(deps, account, owner, name, row.number);
          if (pull.state !== "open") {
            skip("el PR ya no está abierto en GitHub");
            continue;
          }
          if (draftOnly && !pull.draft) {
            skip("ya no está en draft");
            continue;
          }
          if (REPLACES.test(pull.body ?? "")) {
            skip("ya es un PR republicado");
            continue;
          }
          if (parentsOf(store, row).length > 1) {
            skip("tiene base combinada (varios padres): no se rehace");
            continue;
          }
          const lost = await lostContext(deps, { account, repo, number: row.number });
          if (lost) {
            skip(lost);
            continue;
          }

          if (!fetched.has(row.repoId)) {
            if ((await deps.fetchRepo(row.repoId)) === "unauthorized") throw new Error(`GitHub rechazó el token de ${account}: reconecta la cuenta.`);
            fetched.add(row.repoId);
          }
          const names = reserved.get(row.repoId) ?? new Set<string>();
          reserved.set(row.repoId, names);
          const branch = await freshIssueBranch(store, issue, config.path, names);
          names.add(branch);
          const newBase = baseFor(store, row, pull.base.ref, done);
          done.set(row.id, { branch });

          if (dryRun) {
            results.push({ ...base, status: "planned", branch, base: newBase, commits: pull.commits });
            continue;
          }
          const project = deps.projects.get(issue.projectId);
          const runId = flows.start(
            "republish-pr",
            { type: "issue", id: issue.id },
            {
              repo: row.repoId,
              base: newBase,
              branch,
              head: pull.head.sha,
              oldNumber: row.number,
              oldHead: pull.head.ref,
              oldBase: pull.base.ref,
              title: pull.title,
              body: [(pull.body ?? "").trim(), `Reemplaza a #${row.number}`].filter(Boolean).join("\n\n"),
              draft: pull.draft,
            },
            { projectId: issue.projectId, repoId: row.repoId, profile: project?.defaultProfileId ?? undefined },
          );
          const result = await finish(runId);
          if (result.status === "failed") done.set(row.id, { skipped: `falló: ${result.reason}` });
          const commits = result.newNumber === undefined ? undefined : (await readPull(deps, account, owner, name, result.newNumber).catch(() => undefined))?.commits;
          results.push({ ...base, branch, base: newBase, ...result, ...(commits !== undefined && { commits }) });
        } catch (error) {
          if (error instanceof RequestError && error.status === 401) deps.connections.markRevoked("github", account, "core");
          const reason = error instanceof Error ? error.message : String(error);
          done.set(row.id, { skipped: `falló: ${reason}` });
          results.push({ ...base, status: "failed", reason });
        }
      }
      return results;
    },
  };

  /** Espera a que la corrida termine (o quede estacionada) y dice qué pasó con el PR nuevo, si llegó a abrirse. */
  async function finish(runId: RunId): Promise<Pick<PrRepublish, "status" | "newNumber" | "reason">> {
    let run = flows.getRun(runId);
    while (run.status === "queued" || run.status === "running" || run.status === "waiting" || run.status === "paused") {
      await new Promise((resolve) => setTimeout(resolve, pollMs));
      run = flows.getRun(runId);
    }
    const fresh = store.db.select().from(pullRequests).where(and(eq(pullRequests.runId, runId), eq(pullRequests.owned, true))).get();
    const ended = run.status === "parked" ? `la corrida ${runId} quedó estacionada: mira la Bandeja` : run.outcome === "done" ? undefined : `la corrida ${runId} terminó ${run.outcome ?? run.status}`;
    if (fresh) {
      return { status: "republished", newNumber: fresh.number, ...(ended && { reason: `el PR nuevo existe, pero ${ended}` }) };
    }
    const failed = run.steps.find((s) => s.status === "failed" && s.error);
    return { status: "failed", reason: failed?.error ?? ended ?? `la corrida ${runId} terminó sin abrir el PR` };
  }
}

async function readPull(deps: PrRepublisherDeps, account: string, owner: string, repo: string, number: number): Promise<z.infer<typeof Pull>> {
  const { data } = await deps.connections.githubClient(account).request("GET /repos/{owner}/{repo}/pulls/{pull_number}", { owner, repo, pull_number: number });
  return Pull.parse(data);
}

/** Por qué rehacer el PR perdería contexto de una persona (o del council); `undefined` si no hay nada que perder. */
async function lostContext(deps: PrRepublisherDeps, ref: PrRef): Promise<string | undefined> {
  const { threads, talk } = await deps.prs.get(ref);
  // Los threads de bots se vuelven a abrir solos en el PR nuevo; solo se pierde el contexto de personas o del council.
  const open = threads.humanOpen + threads.councilOpen.length;
  if (open > 0) return `tiene ${open} threads sin resolver (humanos o council): rehacerlo perdería ese contexto`;
  if (talk.length > 0) return "tiene comentarios o reviews de humanos: rehacerlo perdería ese contexto";
  return undefined;
}

/** La corrida viva que usa la issue del PR o lo tiene tomado. */
function liveRun(store: Store, row: PrRow): RunId | undefined {
  return store.db
    .select({ id: runs.id })
    .from(runs)
    .where(and(inArray(runs.status, LIVE), or(and(eq(runs.subjectType, "issue"), eq(runs.subjectId, row.issueId ?? "")), eq(runs.claimedPrId, row.id))))
    .get()?.id;
}

/** Los PRs de los que cuelga `row` (`pr_parents`), todos los que el core conoce, abiertos o no. */
function parentsOf(store: Store, row: PrRow): PrRow[] {
  const ids = store.db.select({ id: prParents.parentId }).from(prParents).where(eq(prParents.childId, row.id)).all();
  return ids.length === 0 ? [] : store.db.select().from(pullRequests).where(inArray(pullRequests.id, ids.map((p) => p.id))).all();
}

/** Los padres antes que los hijos; entre los que no se relacionan, por número. */
function inStackOrder(store: Store, rows: PrRow[]): PrRow[] {
  const byId = new Map(rows.map((row) => [row.id, row]));
  const ordered: PrRow[] = [];
  const seen = new Set<string>();
  const visit = (row: PrRow) => {
    if (seen.has(row.id)) return;
    seen.add(row.id);
    for (const parent of parentsOf(store, row)) {
      const inBatch = byId.get(parent.id);
      if (inBatch) visit(inBatch);
    }
    ordered.push(row);
  };
  for (const row of [...rows].sort((a, b) => a.repoId.localeCompare(b.repoId) || a.number - b.number)) visit(row);
  return ordered;
}

/**
 * Sobre qué branch sale el PR nuevo: la nueva de su padre si ese se rehízo en esta llamada o en una anterior (el core
 * ya sigue al PR nuevo del padre), o la base que GitHub dice que tiene hoy.
 */
function baseFor(store: Store, row: PrRow, base: string, done: Map<string, { branch: string } | { skipped: string }>): string {
  for (const parent of parentsOf(store, row)) {
    const outcome = done.get(parent.id);
    if (outcome && "branch" in outcome) return outcome.branch;
    if (parent.state === "open" && parent.headRef !== base) return parent.headRef;
  }
  return base;
}

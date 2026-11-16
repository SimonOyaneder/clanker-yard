import { randomUUID } from "node:crypto";
import type { IssueId, Origin, PrRef, PrRepublish, RepoId, RepublishInput, RepublishProgress, RunId } from "@clanker/api";
import { and, eq, inArray, or } from "drizzle-orm";
import * as z from "zod";
import type { Connections } from "../../connections/connections";
import type { Engine } from "../../flows/engine";
import type { FetchOutcome } from "../../git/remote";
import { freshIssueBranch } from "../../projects/branch-name";
import { PrCommandError } from "./pr-commands";
import type { Projects } from "../../projects/projects";
import { prParents, pullRequests, runs } from "../../store/schema";
import type { Store } from "../../store/store";
import type { Issues } from "../../tracker/issues";
import type { Repos } from "../../repos/repos";
import type { Prs } from "../prs";
import { messageOf } from "../../errors/format";

export interface PrRepublisherDeps {
  store: Store;
  repos: Pick<Repos, "config">;
  issues: Pick<Issues, "get">;
  projects: Pick<Projects, "get">;
  flows: Pick<Engine, "start" | "getRun">;
  connections: Pick<Connections, "githubClient">;
  prs: Pick<Prs, "get">;
  /** `workspaces.fetch`: trae las branches del remoto, que `pr.replay` y los nombres nuevos necesitan al día. */
  fetchRepo(repoId: RepoId): Promise<FetchOutcome>;
}

export interface PrRepublisher {
  /**
   * `prs.republish`: por cada PR abierto del sistema (`owned` y de una issue), en orden de stack (un padre antes que sus
   * hijos), lanza el flujo `republish-pr` y vuelve sin esperarlo. Así, con la implementación intacta, el PR sale de
   * nuevo con la branch de hoy (`freshIssueBranch`; creada sobre la branch nueva del padre si estaba apilado), los commits
   * que corta el committer con las reglas vigentes y el autor del repo; el viejo queda cerrado con "Reemplazado por #n".
   *
   * Un hijo espera (`pending`) a que su padre haya publicado su PR nuevo y cerrado el viejo, no a que termine su feedback:
   * `progress` lo lanza en cuanto puede. Quien llama (la CLI) consulta `progress` hasta que `done`; el core no mantiene
   * nada corriendo por su cuenta, y ninguna llamada dura lo que dura una corrida.
   *
   * Un PR se salta, con su razón, si la issue tiene una corrida viva, si GitHub ya no lo tiene abierto, si tiene threads
   * sin resolver de council o de humanos (o humanos que comentaron: rehacerlo perdería ese contexto), si tiene base
   * combinada (varios padres) o si ya es un PR republicado ("Reemplaza a #n"). Un padre que no se rehízo (salteado o
   * fallido) salta a sus hijos; los errores son por PR y no frenan a los demás. Con `dryRun` solo se leen GitHub y el
   * caché: no se lanza ninguna corrida, no cuesta nada, `done` ya viene `true` y `commits` es lo que tiene hoy el PR viejo.
   */
  republish(input: RepublishInput, by: Origin): Promise<RepublishProgress>;
  /** `prs.republishProgress`: lanza lo que ya puede salir del lote `id` y dice cómo va cada PR. Lanza `PrCommandError` si no lo conoce (el core se reinició). */
  progress(id: string): Promise<RepublishProgress>;
}

/** Estados en que una corrida sigue usando su issue y su branch (`runs_active_flow_subject`). */
const LIVE = ["queued", "running", "waiting", "parked", "paused"] as const;
/** Las corridas que siguen avanzando solas: una `parked` espera a una persona y para el lote ya terminó. */
const MOVING = ["queued", "running", "waiting", "paused"] as const;
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

/** Un PR del lote: espera a su padre, corre su flujo o ya tiene su resultado final. */
interface Entry {
  row: PrRow;
  /** Los padres del PR viejo cuando arrancó el lote: al republicarse uno, `pr.supersede` repunta `pr_parents` al nuevo. */
  parents: string[];
  /** La branch nueva y su base, desde que se decidieron. */
  branch?: string;
  base?: string;
  runId?: RunId;
  /** Dónde pedirle a GitHub el PR nuevo. */
  target?: { account: string; owner: string; repo: string };
  /** Solo cuando ya no cambia. */
  final?: PrRepublish;
}

interface Batch {
  id: string;
  input: RepublishInput;
  /** Quién pidió la republicación: lo llevan las corridas que lanza el lote. */
  by: Origin;
  entries: Entry[];
  reserved: Map<RepoId, Set<string>>;
  fetched: Set<RepoId>;
  /** Un avance a la vez: dos `progress` seguidos no lanzarían dos veces al mismo PR. */
  tail: Promise<unknown>;
}

const parentEntry = (batch: Batch, id: string) => batch.entries.find((e) => e.row.id === id);

export function createPrRepublisher(deps: PrRepublisherDeps): PrRepublisher {
  const { store, flows } = deps;
  const batches = new Map<string, Batch>();

  const resultOf = ({ row }: Entry): Pick<PrRepublish, "repo" | "number"> => ({ repo: row.repoId, number: row.number });
  const finish = (e: Entry, result: Omit<PrRepublish, "repo" | "number">): void => {
    e.final = { ...resultOf(e), ...result };
  };
  /** Un padre ya dejó su PR nuevo y cerró el viejo (`pr.supersede` lo marca cerrado en el caché), o solo se planeó. */
  const published = (batch: Batch, e: Entry): boolean => {
    if (e.final) return e.final.status === "planned" || e.final.status === "republished";
    if (e.runId === undefined) return false;
    return store.db.select({ state: pullRequests.state }).from(pullRequests).where(eq(pullRequests.id, e.row.id)).get()?.state === "closed";
  };

  return {
    async republish(input, by) {
      const { projectId, prs: numbers = [], draftOnly = false } = input;
      const rows = store.db
        .select()
        .from(pullRequests)
        .where(and(eq(pullRequests.state, "open"), eq(pullRequests.owned, true)))
        .all()
        .filter((row) => row.issueId !== null && (!draftOnly || row.isDraft) && (numbers.length === 0 || numbers.includes(row.number)));
      const entries: Entry[] = [];
      for (const row of inStackOrder(store, rows)) {
        const entry: Entry = { row, parents: parentsOf(store, row).map((p) => p.id) };
        const issue = deps.issues.get(row.issueId as IssueId);
        if (!issue) finish(entry, { status: "skipped", reason: "la issue no está en el caché" });
        else if (projectId !== undefined && issue.projectId !== projectId) continue;
        entries.push(entry);
      }
      // Los lotes ya terminados no se consultan más: se sueltan al empezar otro.
      for (const [id, old] of batches) if (old.entries.every((e) => e.final)) batches.delete(id);
      const batch: Batch = { id: randomUUID(), input, by, entries, reserved: new Map(), fetched: new Set(), tail: Promise.resolve() };
      batches.set(batch.id, batch);
      return advanceSerially(batch);
    },

    async progress(id) {
      const batch = batches.get(id);
      if (!batch) throw new PrCommandError(`No hay una republicación ${id}: el core se reinició o ya terminó. Vuelve a correr prs republish.`);
      return advanceSerially(batch);
    },
  };

  function advanceSerially(batch: Batch): Promise<RepublishProgress> {
    const next = batch.tail.then(() => advance(batch));
    batch.tail = next.catch(() => undefined);
    return next;
  }

  /** Cierra las corridas que terminaron y lanza los PRs que ya pueden salir, en orden de stack. */
  async function advance(batch: Batch): Promise<RepublishProgress> {
    for (const entry of batch.entries) {
      if (entry.final) continue;
      if (entry.runId !== undefined) await settle(entry);
      else await launch(batch, entry);
    }
    return {
      id: batch.id,
      done: batch.entries.every((e) => e.final),
      results: batch.entries.map((e) => e.final ?? interim(e)),
    };
  }

  function interim(e: Entry): PrRepublish {
    if (e.runId === undefined) return { ...resultOf(e), status: "pending" };
    const fresh = store.db.select({ number: pullRequests.number }).from(pullRequests).where(and(eq(pullRequests.runId, e.runId), eq(pullRequests.owned, true))).get();
    return { ...resultOf(e), status: "running", branch: e.branch, base: e.base, ...(fresh && { newNumber: fresh.number }) };
  }

  /** Decide qué pasa con un PR que aún no tiene corrida: espera a su padre, se salta, se planea (`dryRun`) o lanza su flujo. */
  async function launch(batch: Batch, e: Entry): Promise<void> {
    const { row } = e;
    const issue = deps.issues.get(row.issueId as IssueId)!;
    const skip = (reason: string): void => finish(e, { status: "skipped", reason });

    const parents = e.parents.flatMap((id) => parentEntry(batch, id) ?? []);
    const lost = parents.find((p) => p.final && (p.final.status === "skipped" || p.final.status === "failed"));
    if (lost?.final) {
      const why = lost.final.status === "failed" ? `falló: ${lost.final.reason}` : lost.final.reason;
      return skip(`su padre #${lost.row.number} no se rehízo (${why})`);
    }
    if (parents.some((p) => !published(batch, p))) return;

    const live = liveRun(store, row);
    if (live) return skip(`la corrida ${live} sigue viva`);
    const config = deps.repos.config(row.repoId);
    if (!config.remote) return skip("el repo no tiene remoto de GitHub");
    const { account, repo } = config.remote;
    const [owner = "", name = ""] = repo.split("/");
    e.target = { account, owner, repo: name };

    try {
      const pull = await readPull(deps, account, owner, name, row.number);
      if (pull.state !== "open") return skip("el PR ya no está abierto en GitHub");
      if (batch.input.draftOnly && !pull.draft) return skip("ya no está en draft");
      if (REPLACES.test(pull.body ?? "")) return skip("ya es un PR republicado");
      if (parentsOf(store, row).length > 1) return skip("tiene base combinada (varios padres): no se rehace");
      const context = await lostContext(deps, { account, repo, number: row.number });
      if (context) return skip(context);

      if (!batch.fetched.has(row.repoId)) {
        if ((await deps.fetchRepo(row.repoId)) === "unauthorized") throw new Error(`GitHub rechazó el token de ${account}: reconecta la cuenta.`);
        batch.fetched.add(row.repoId);
      }
      const names = batch.reserved.get(row.repoId) ?? new Set<string>();
      batch.reserved.set(row.repoId, names);
      const branch = await freshIssueBranch(store, issue, config.path, names);
      names.add(branch);
      const newBase = baseFor(store, e, pull.base.ref, batch);
      e.branch = branch;
      e.base = newBase;

      if (batch.input.dryRun) return finish(e, { status: "planned", branch, base: newBase, commits: pull.commits });
      const project = deps.projects.get(issue.projectId);
      e.runId = flows.start(
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
        { projectId: issue.projectId, repoId: row.repoId, profile: project?.defaultProfileId ?? undefined, by: batch.by },
      );
    } catch (error) {
      finish(e, { status: "failed", reason: messageOf(error) });
    }
  }

  /** Si la corrida terminó (o quedó estacionada) fija el resultado del PR; mientras avance sola no hace nada. */
  async function settle(e: Entry): Promise<void> {
    const runId = e.runId!;
    const run = flows.getRun(runId);
    if ((MOVING as readonly string[]).includes(run.status)) return;
    const fresh = store.db.select().from(pullRequests).where(and(eq(pullRequests.runId, runId), eq(pullRequests.owned, true))).get();
    const ended = run.status === "parked" ? `la corrida ${runId} quedó estacionada: mira la Bandeja` : run.outcome === "done" ? undefined : `la corrida ${runId} terminó ${run.outcome ?? run.status}`;
    const where = { branch: e.branch, base: e.base };
    if (!fresh) {
      const failed = run.steps.find((s) => (s.status === "failed" || s.outcome === "error") && s.error);
      return finish(e, { status: "failed", ...where, reason: failed?.error ?? ended ?? `la corrida ${runId} terminó sin abrir el PR` });
    }
    const { account, owner, repo } = e.target!;
    const commits = (await readPull(deps, account, owner, repo, fresh.number).catch(() => undefined))?.commits;
    finish(e, { status: "republished", ...where, newNumber: fresh.number, ...(ended && { reason: `el PR nuevo existe, pero ${ended}` }), ...(commits !== undefined && { commits }) });
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
 * Sobre qué branch sale el PR nuevo: la nueva de su padre si ese se rehízo en este lote (o en uno anterior: el core ya
 * sigue al PR nuevo del padre), o la base que GitHub dice que tiene hoy.
 */
function baseFor(store: Store, e: Entry, base: string, batch: Batch): string {
  for (const id of e.parents) {
    const branch = parentEntry(batch, id)?.branch;
    if (branch !== undefined) return branch;
  }
  for (const parent of parentsOf(store, e.row)) {
    if (parent.state === "open" && parent.headRef !== base) return parent.headRef;
  }
  return base;
}

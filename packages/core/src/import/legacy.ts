import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  type FlowBody,
  type IssueId,
  type LegacyImportCounts,
  type LegacyImportResult,
  type LegacyMetricsRow,
  type ProjectId,
  type RepoId,
  type RunId,
  type StatusCategory,
  parseLegacyMetrics,
} from "@clanker/api";
import { and, eq, isNotNull, sql } from "drizzle-orm";
import type * as z from "zod";
import type { Defs } from "../defs/defs";
import { newId, usdToMicros } from "../store/conventions";
import { issues, projectRepos, projects, pullRequests, repos, runMetrics, runRoleCosts, runs } from "../store/schema";
import type { Store } from "../store/store";
import { type LegacyHistoryRow, type LegacyState, parseLegacyState } from "./legacy-state";

/** La carpeta no es el estado de un clanker-loop o una fila no cumple su formato: el mensaje dice cuál. Nada se escribió. */
export class LegacyImportError extends Error {}

export interface LegacyImporter {
  /** Lee `from` (`~/.local/share/clanker-loop`) sin tocarlo y escribe lo que falte; con `dryRun`, solo cuenta. */
  run(input: { from: string; dryRun: boolean }): LegacyImportResult;
}

/** El flujo al que cuelgan las corridas importadas: existe solo para cumplir la FK, archivado para que nadie lo lance. */
const LEGACY_FLOW_SLUG = "legacy-clanker-loop";
const LEGACY_FLOW: z.input<typeof FlowBody> = {
  schema: 1,
  id: LEGACY_FLOW_SLUG,
  name: "Clanker-loop (historial importado)",
  trigger: { type: "manual" },
  start: "historico",
  nodes: {
    historico: {
      type: "gate",
      question: "Corrida importada del clanker-loop: ya terminó y no se puede lanzar.",
      options: [{ id: "done", label: "Listo" }],
      on: { done: "@done" },
    },
  },
};

/** El proyecto de las filas de `metrics.jsonl` que no dicen cuál es. */
const NO_PROJECT_SLUG = "sin-proyecto";

type NewRun = Omit<typeof runs.$inferInsert, "flowDefId" | "flowVersion">;

/** Todo lo que falta escribir, calculado sin tocar la base: `dryRun` lo cuenta y la importación real lo inserta. */
interface Plan {
  projects: (typeof projects.$inferInsert)[];
  projectRepos: (typeof projectRepos.$inferInsert)[];
  issues: (typeof issues.$inferInsert)[];
  runs: NewRun[];
  runMetrics: (typeof runMetrics.$inferInsert)[];
  runRoleCosts: (typeof runRoleCosts.$inferInsert)[];
  pullRequests: (typeof pullRequests.$inferInsert)[];
  unresolvedRepos: Set<string>;
  /** Por proyecto, lo que `run_metrics` debe sumar al terminar (también lo de importaciones anteriores). */
  expected: Map<string, { runs: number; costMicros: number }>;
}

interface Source {
  metrics: LegacyMetricsRow[];
  /** Por la carpeta del proyecto (que es el `project` de `metrics.jsonl`). */
  states: Map<string, LegacyState>;
}

export function createLegacyImporter({ store, defs }: { store: Store; defs: Pick<Defs, "save" | "list" | "archive"> }): LegacyImporter {
  return {
    run({ from, dryRun }) {
      const plan = planImport(store, readSource(from));
      const created = countOf(plan);
      if (!dryRun) apply(store, legacyFlow(defs), plan, from, created);
      return { dryRun, created, unresolvedRepos: [...plan.unresolvedRepos].sort() };
    },
  };
}

function readSource(from: string): Source {
  const metricsPath = join(from, "metrics.jsonl");
  if (!existsSync(metricsPath)) {
    throw new LegacyImportError(`No hay metrics.jsonl en ${from}: --from debe ser la carpeta del clanker-loop (~/.local/share/clanker-loop).`);
  }
  try {
    const states = new Map<string, LegacyState>();
    const projectsDir = join(from, "projects");
    const dirs = existsSync(projectsDir) ? readdirSync(projectsDir, { withFileTypes: true }) : [];
    for (const dir of dirs.filter((d) => d.isDirectory()).sort((a, b) => a.name.localeCompare(b.name))) {
      const statePath = join(projectsDir, dir.name, "state.md");
      if (!existsSync(statePath)) continue;
      try {
        states.set(dir.name, parseLegacyState(readFileSync(statePath, "utf8")));
      } catch (error) {
        throw new Error(`${statePath}: ${(error as Error).message}`);
      }
    }
    return { metrics: parseLegacyMetrics(readFileSync(metricsPath, "utf8")), states };
  } catch (error) {
    throw new LegacyImportError((error as Error).message);
  }
}

/** El `fallo` de las primeras corridas es el mismo `falló` de las demás. */
const normalizeResult = (result: string) => (result === "fallo" ? "falló" : result);

/** El outcome del core (`done`, `blocked`, `failed`) de un resultado del loop viejo. */
function outcomeOf(result: string): "done" | "blocked" | "failed" {
  switch (normalizeResult(result)) {
    case "listo":
    case "council-listo":
    case "sin-lgtm":
      return "done";
    case "pendientes":
    case "necesita-humano":
    case "bloqueada":
      return "blocked";
    case "falló":
      return "failed";
    default:
      throw new LegacyImportError(`metrics.jsonl: el resultado "${result}" no tiene outcome del core: agrégalo a outcomeOf (import/legacy.ts).`);
  }
}

/** `https://linear.app/acme/project/soporte-0ab` → `soporte-0ab`: lo que `trackerRef` guarda hasta que el sync lo cambie por el id de Linear. */
const trackerRefOf = (state: LegacyState | undefined, slug: string) => state?.trackerUrl?.split("/project/")[1]?.split(/[/?#]/)[0] || slug;

function planImport(store: Store, { metrics, states }: Source): Plan {
  const { db } = store;
  const plan: Plan = {
    projects: [],
    projectRepos: [],
    issues: [],
    runs: [],
    runMetrics: [],
    runRoleCosts: [],
    pullRequests: [],
    unresolvedRepos: new Set(),
    expected: new Map(),
  };

  const knownProjects = new Map(db.select({ slug: projects.slug, id: projects.id }).from(projects).all().map((p) => [p.slug, p.id]));
  const knownRepos = db.select().from(repos).all();
  const linked = new Set(db.select().from(projectRepos).all().map((r) => `${r.projectId}:${r.repoId}`));
  const nextOrd = new Map<ProjectId, number>();
  for (const { projectId } of db.select().from(projectRepos).all()) nextOrd.set(projectId, (nextOrd.get(projectId) ?? 0) + 1);
  const knownIssues = new Map(
    db.select({ key: issues.trackerId, id: issues.id }).from(issues).where(eq(issues.tracker, "linear")).all().map((i) => [i.key, i.id]),
  );
  const knownRuns = new Map(db.select({ key: runs.sourceKey, id: runs.id }).from(runs).where(isNotNull(runs.sourceKey)).all().map((r) => [r.key!, r.id]));
  const knownPulls = new Set(db.select({ repoId: pullRequests.repoId, number: pullRequests.number }).from(pullRequests).all().map((p) => `${p.repoId}#${p.number}`));

  const slugOf = (row: LegacyMetricsRow) => row.project ?? NO_PROJECT_SLUG;
  const slugs = [...new Set([...states.keys(), ...metrics.map(slugOf)])];
  const linearBase = [...states.values()].map((s) => s.trackerUrl).find(Boolean)?.replace(/^(https?:\/\/[^/]+\/[^/]+)\/.*$/, "$1") ?? "https://linear.app";

  // Un repo se resuelve por la ruta de la cabecera y, si no, por el nombre. Nunca se crea uno: no se sabe su rama ni su remoto.
  function resolveRepo(name: string, path?: string): RepoId | undefined {
    const byPath = path === undefined ? undefined : knownRepos.find((r) => r.path === path);
    if (byPath) return byPath.id;
    const byName = knownRepos.filter((r) => r.name === name);
    if (byName.length === 1) return byName[0]!.id;
    plan.unresolvedRepos.add(name);
    return undefined;
  }

  const plannedRuns = new Map<string, { id: RunId; endedAt: number; pr?: { repo: string; number: number } }[]>();
  const issueIdOf = (slug: string, key: string, status: StatusCategory, rawStatus: string, trackerRef: string, remoteUpdatedAt: number): IssueId => {
    const known = knownIssues.get(key);
    if (known) return known;
    const id = newId("iss");
    knownIssues.set(key, id);
    plan.issues.push({
      id,
      tracker: "linear",
      trackerId: key,
      key,
      url: `${linearBase}/issue/${key}`,
      projectId: knownProjects.get(slug)!,
      trackerProject: trackerRef,
      title: key,
      body: "",
      status,
      rawStatus,
      priority: 0,
      labels: [],
      relations: { blocks: [], blockedBy: [], related: [] },
      remoteUpdatedAt,
    });
    return id;
  };

  // Primero los proyectos: issues y runs necesitan el id.
  for (const slug of slugs) {
    if (knownProjects.has(slug)) continue;
    const state = states.get(slug);
    const id = newId("prj");
    knownProjects.set(slug, id);
    plan.projects.push({
      id,
      slug,
      name: state?.name ?? slug,
      tracker: "linear",
      trackerRef: trackerRefOf(state, slug),
      parallel: state?.parallel ?? 1,
      // Pausado: el trackerRef es un placeholder y la cola no debe tomar issues hasta que se revise.
      status: "paused",
      flowParams: {},
    });
  }

  for (const slug of slugs) {
    const projectId = knownProjects.get(slug)!;
    const state = states.get(slug);
    const trackerRef = trackerRefOf(state, slug);
    const rows = metrics.filter((row) => slugOf(row) === slug);

    // Las issues del historial primero: su estado manda sobre el que se deduce del resultado de la última corrida.
    const rowOf = (key: string) => state?.history.find((h) => h.key === key && h.variant === undefined) ?? state?.history.find((h) => h.key === key);
    for (const key of new Set(state?.history.map((h) => h.key))) {
      const h = rowOf(key)!;
      issueIdOf(slug, key, issueStatusOf(h), h.status, trackerRef, 0);
    }

    // Las corridas, con su clave de origen: `issue + ts` es única en la práctica y no cambia si el loop agrega líneas.
    const lastRunOf = new Map<string, LegacyMetricsRow>();
    for (const row of rows) {
      const prev = lastRunOf.get(row.issue);
      if (!prev || (row.ts ?? "") >= (prev.ts ?? "")) lastRunOf.set(row.issue, row);
    }
    const expected = { runs: 0, costMicros: 0 };
    plan.expected.set(slug, expected);
    const seen = new Set<string>();
    for (const row of rows) {
      if (row.ts === undefined || Number.isNaN(Date.parse(row.ts))) {
        throw new LegacyImportError(`metrics.jsonl: la fila de ${row.issue} (${slug}) no tiene un ts válido: sin él no hay clave de origen.`);
      }
      const sourceKey = `legacy:metrics:${slug}:${row.issue}:${row.ts}`;
      // La misma línea repetida en el archivo es una sola corrida.
      if (seen.has(sourceKey)) continue;
      seen.add(sourceKey);
      const roleCosts = Object.entries(row.por_rol ?? {});
      const costMicros = usdToMicros(row.usd ?? roleCosts.reduce((sum, [, c]) => sum + (c.usd ?? 0), 0));
      const outcome = outcomeOf(row.result);
      const endedAt = Date.parse(row.ts);
      const known = knownRuns.get(sourceKey);
      const id = known ?? newId("run");
      const pr = row.pr ? /github\.com\/[^/]+\/([^/]+)\/pull\/(\d+)/.exec(row.pr) : null;
      const issueRuns = plannedRuns.get(`${slug}:${row.issue}`) ?? [];
      plannedRuns.set(`${slug}:${row.issue}`, issueRuns);
      issueRuns.push({ id, endedAt, ...(pr ? { pr: { repo: pr[1]!, number: Number(pr[2]) } } : {}) });
      expected.runs++;
      expected.costMicros += costMicros;
      if (known) continue;
      knownRuns.set(sourceKey, id);

      const last = lastRunOf.get(row.issue)!;
      const issueId = issueIdOf(slug, row.issue, outcomeOf(last.result) === "done" ? "in_review" : "in_progress", normalizeResult(last.result), trackerRef, Date.parse(last.ts!));
      const minutes = row.minutes ?? 0;
      plan.runs.push({
        id,
        projectId,
        subjectType: "issue",
        subjectId: issueId,
        roles: {},
        lane: "dev",
        status: outcome === "done" ? "done" : "failed",
        outcome,
        writes: false,
        params: {
          legacy: {
            result: normalizeResult(row.result),
            mode: row.mode,
            profile: row.profile,
            repo: row.repo,
            pr: row.pr,
            estimate: row.estimate,
          },
        },
        rounds: counters(row),
        costMicros,
        sourceKey,
        startedAt: endedAt - minutes * 60_000,
        endedAt,
      });
      plan.runMetrics.push({
        runId: id,
        result: outcome,
        minutes,
        rounds: counters(row),
        outcomes: botOutcomes(row),
        costMicros,
      });
      for (const [role, cost] of roleCosts) {
        plan.runRoleCosts.push({
          runId: id,
          role,
          model: cost.modelo ?? "desconocido",
          effort: cost.effort ?? null,
          tokens: cost.tokens ?? 0,
          costMicros: usdToMicros(cost.usd ?? 0),
        });
      }
    }

    if (!state) continue;

    // Repos del proyecto: la cabecera, luego los que aparecen en PRs y corridas.
    const names = new Map<string, string | undefined>(state.repos.map((r) => [r.name, r.path]));
    for (const h of state.history) if (h.pr?.repo) names.set(h.pr.repo, names.get(h.pr.repo));
    for (const { repo } of rows) if (repo) names.set(repo, names.get(repo));
    const repoIds = new Map<string, RepoId>();
    for (const [name, path] of names) {
      // Un repo de la cabecera sin ruta ni PRs es un nombre de grupo (`sdks`): no se busca.
      const used = path !== undefined || state.history.some((h) => h.pr?.repo === name) || rows.some((r) => r.repo === name);
      const repoId = used ? resolveRepo(name, path) : undefined;
      if (!repoId) continue;
      repoIds.set(name, repoId);
      const link = `${projectId}:${repoId}`;
      if (linked.has(link)) continue;
      linked.add(link);
      const ord = nextOrd.get(projectId) ?? 0;
      nextOrd.set(projectId, ord + 1);
      plan.projectRepos.push({ projectId, repoId, ord, labels: [] });
    }

    // Los PRs del historial, enlazados a la corrida del mismo PR o, si no la hay, a la última de la issue.
    const defaultRepo = state.repos[0]?.name;
    for (const h of state.history) {
      if (!h.pr) continue;
      const repoName = h.pr.repo ?? defaultRepo;
      const repoId = repoName === undefined ? undefined : repoIds.get(repoName);
      if (!repoId || knownPulls.has(`${repoId}#${h.pr.number}`)) continue;
      knownPulls.add(`${repoId}#${h.pr.number}`);
      const candidates = plannedRuns.get(`${slug}:${h.key}`) ?? [];
      const run =
        candidates.find((c) => c.pr?.number === h.pr!.number && c.pr.repo === repoName) ??
        candidates.reduce<(typeof candidates)[number] | undefined>((last, c) => (!last || c.endedAt >= last.endedAt ? c : last), undefined);
      // Lo que GitHub sabe (nodo, SHA, base) queda vacío hasta que Watch sincronice el PR. `owned` es falso: no lo abrió Clanker Yard.
      plan.pullRequests.push({
        id: newId("pr"),
        repoId,
        number: h.pr.number,
        nodeId: "",
        headRef: h.branch ?? "",
        baseRef: "",
        headSha: "",
        state: h.state === "mergeado" ? "merged" : h.state === "cerrado" ? "closed" : "open",
        isDraft: false,
        issueId: knownIssues.get(h.key) ?? null,
        runId: run?.id ?? null,
        owned: false,
      });
    }
  }
  return plan;
}

/** `review`, `bot` y `ci` son los contadores del flujo `techlead-clasico`: así `projects.summary` suma lo importado con lo nuevo. */
function counters(row: LegacyMetricsRow): Record<string, number> {
  const rounds: Record<string, number> = {};
  if (row["review-rounds"] !== undefined) rounds.review = row["review-rounds"];
  if (row["bot-rounds"] !== undefined) rounds.bot = row["bot-rounds"];
  if (row["ci-fails"] !== undefined) rounds.ci = row["ci-fails"];
  return rounds;
}

/** Los hallazgos del bot no son una ronda de un nodo: van como outcomes de un nodo `bot` (válidos y falsos positivos). */
function botOutcomes(row: LegacyMetricsRow): Record<string, Record<string, number>> {
  const outcomes: Record<string, number> = {};
  if (row["bot-valid"] !== undefined) outcomes.valid = row["bot-valid"];
  if (row["bot-fp"] !== undefined) outcomes.false_positive = row["bot-fp"];
  return Object.keys(outcomes).length === 0 ? {} : { bot: outcomes };
}

function issueStatusOf({ state }: LegacyHistoryRow): StatusCategory {
  return state === "mergeado" ? "done" : state === "cerrado" ? "canceled" : "in_review";
}

function countOf(plan: Plan): LegacyImportCounts {
  return {
    projects: plan.projects.length,
    issues: plan.issues.length,
    pullRequests: plan.pullRequests.length,
    runs: plan.runs.length,
    runRoleCosts: plan.runRoleCosts.length,
  };
}

/** El flujo histórico (creado una vez y archivado). Va fuera de la tx del import: `defs.save` abre la suya. */
function legacyFlow(defs: Pick<Defs, "save" | "list" | "archive">): { id: string; version: number } {
  const found = defs.list("flow", { includeArchived: true }).find((d) => d.slug === LEGACY_FLOW_SLUG && d.scope === "user");
  const { id, version } = found ? { id: found.id, version: found.currentVersion } : defs.save({ kind: "flow", slug: LEGACY_FLOW_SLUG, scope: "user", body: LEGACY_FLOW, source: "import" });
  if (found?.archivedAt == null) defs.archive("flow", id, "import");
  return { id, version };
}

/** Inserta el plan en una sola tx. Si los totales de algún proyecto no cuadran con `metrics.jsonl`, la tx se deshace. */
function apply(store: Store, flow: { id: string; version: number }, plan: Plan, from: string, created: LegacyImportCounts): void {
  store.tx((tx) => {
    const { db } = tx;
    if (plan.projects.length > 0) db.insert(projects).values(plan.projects).run();
    if (plan.projectRepos.length > 0) db.insert(projectRepos).values(plan.projectRepos).run();
    if (plan.issues.length > 0) db.insert(issues).values(plan.issues).run();
    if (plan.runs.length > 0) db.insert(runs).values(plan.runs.map((run) => ({ ...run, flowDefId: flow.id, flowVersion: flow.version }))).run();
    if (plan.runMetrics.length > 0) db.insert(runMetrics).values(plan.runMetrics).run();
    if (plan.runRoleCosts.length > 0) db.insert(runRoleCosts).values(plan.runRoleCosts).run();
    if (plan.pullRequests.length > 0) db.insert(pullRequests).values(plan.pullRequests).run();

    // Paridad (`docs/design.html#d-data`): lo que quedó en la base suma lo mismo que el archivo de origen.
    for (const [slug, expected] of plan.expected) {
      const prefix = `legacy:metrics:${slug}:`;
      const actual = db
        .select({ runs: sql<number>`count(*)`.mapWith(Number), costMicros: sql<number>`coalesce(sum(${runMetrics.costMicros}), 0)`.mapWith(Number) })
        .from(runMetrics)
        .innerJoin(runs, eq(runs.id, runMetrics.runId))
        .where(and(isNotNull(runs.sourceKey), sql`substr(${runs.sourceKey}, 1, ${prefix.length}) = ${prefix}`))
        .get()!;
      if (actual.runs !== expected.runs || actual.costMicros !== expected.costMicros) {
        throw new LegacyImportError(
          `La importación de "${slug}" no cuadra con metrics.jsonl: ${actual.runs} corridas y ${actual.costMicros} micros en la base, ${expected.runs} y ${expected.costMicros} en el archivo. No se escribió nada.`,
        );
      }
    }
    tx.emit({ type: "import.completed", origin: "import", payload: { source: from, counts: created } });
  });
}

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  type ArtifactKind,
  type FlowBody,
  type IssueId,
  type LegacyImportCounts,
  type LegacyImportResult,
  type LegacyMetricsRow,
  type ProjectId,
  type RepoId,
  type RunId,
  type StatusCategory,
  type SubjectRef,
  Profile,
  parseLegacyMetrics,
} from "@clanker/api";
import { and, eq, inArray, isNotNull } from "drizzle-orm";
import * as z from "zod";
import { type Artifacts, hashOf } from "../artifacts/artifacts";
import type { Defs } from "../defs/defs";
import { proposeLearning } from "../learnings/learnings";
import { createMetrics } from "../metrics/metrics";
import { newId, usdToMicros } from "../store/conventions";
import {
  artifactRefs,
  decisions,
  issues,
  learnings,
  modelPrices,
  projectRepos,
  projects,
  pullRequests,
  repos,
  runMetrics,
  runRoleCosts,
  runs,
} from "../store/schema";
import type { Store } from "../store/store";
import { type LegacyPrice, type LegacyProfile, parseLegacyProfiles } from "./legacy-profiles";
import { type LegacyHistoryRow, type LegacyState, parseLegacyState } from "./legacy-state";
import { BadRequestError } from "../errors/domain";
import { messageOf } from "../errors/format";

/** La carpeta no es el estado de un clanker-loop o una fila no cumple su formato: el mensaje dice cuál. Nada se escribió. */
export class LegacyImportError extends BadRequestError {}

/**
 * `clanker import legacy`: lee la carpeta del clanker-loop (`~/.local/share/clanker-loop`) sin tocarla y escribe lo que falte;
 * con `dryRun`, solo cuenta. Repetirlo no duplica nada.
 *
 * Importa (`docs/design.html#d-data`, "Migración desde el clanker-loop"):
 * - de `metrics.jsonl` y el `## Historial` de cada `state.md`: proyectos, issues, PRs, corridas y sus métricas;
 * - de `## Decisiones y aprendizajes`: un learning `proposed` por viñeta (decisión 19: muchos hablan del CLI y el guard del
 *   loop viejo y hay que triarlos en la bandeja antes de que lleguen a un brief);
 * - de `## Decisiones a revisar`: una `review_note` pendiente por viñeta, y de `## Omitidas`: una `note` aceptada. Si la viñeta
 *   nombra un PR (`ENG-9105 (#4193): ...`) la decisión cuelga de él (`subject`) y Watch la expira cuando se mergea;
 *   si no, de su issue. El PR de una viñeta que el historial no tiene entra como `open` sin detalle hasta que Watch lo lea;
 * - de `issues/*.md`: `<KEY>.md` es el checkpoint (`legacy`) y `<KEY>-pr*.md` el body del PR (`pr_body`); el resto de los
 *   `.md` es `legacy`. Cuelgan de la última corrida importada de la issue (role `legacy:<sufijo>`), y de la issue si no tiene
 *   corrida; sin ninguna de las dos se omiten. El `## Brief` de cada proyecto es un artefacto `legacy` suyo (role `legacy:brief`);
 * - de `profiles.json`: una def `profile` de usuario por perfil que aún no la tenga, sin el rol `techlead` y sobre los roles del
 *   perfil de la plantilla con ese slug (así `triage` y `plan-check` no se pierden), y los precios que falten en `model_prices`.
 *
 * No importa `queue.json`, `watch.json`, `control.json`, `sessions/`, las secciones vivas (`## En curso`, `## Council pendiente`,
 * `## Rebase pendiente`, `## Bot pendiente`), el brief como `conventions` del proyecto, ni `default` y `judge` de `profiles.json`.
 */
export interface LegacyImporter {
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
  learnings: { projectId: ProjectId; text: string }[];
  decisions: (typeof decisions.$inferInsert)[];
  /** Solo los que cambian algo: un archivo que el loop no tocó desde la última importación no está. */
  artifacts: PlannedArtifact[];
  profiles: { slug: string; body: Profile }[];
  modelPrices: (typeof modelPrices.$inferInsert)[];
  unresolvedRepos: Set<string>;
  /** Por proyecto, lo que `projects.summary` debe dar al terminar (también con lo de importaciones anteriores). */
  expected: Map<string, ExpectedTotals>;
}

/** Lo que Clanker Control suma de un proyecto: corridas, costo, costo por rol y rondas por contador. */
interface ExpectedTotals {
  projectId: ProjectId;
  runs: number;
  costMicros: number;
  roleMicros: Map<string, number>;
  rounds: Map<string, number>;
}

/** Un artefacto por escribir con su dueño: el contenido va a `artifacts.put` y el dueño a `artifact_refs`. */
interface PlannedArtifact {
  owner: { type: "run" | "issue" | "project"; id: string; role: string };
  kind: ArtifactKind;
  content: string;
  hash: string;
}

interface Source {
  metrics: LegacyMetricsRow[];
  /** Por la carpeta del proyecto (que es el `project` de `metrics.jsonl`). */
  states: Map<string, LegacyState>;
  /** Los `.md` de `issues/` de cada proyecto, por su carpeta. */
  issueFiles: Map<string, { name: string; content: string }[]>;
  /** `undefined` si la carpeta no tiene `profiles.json`. */
  profiles?: { profiles: LegacyProfile[]; prices: LegacyPrice[] };
}

export function createLegacyImporter({
  store,
  defs,
  artifacts,
}: {
  store: Store;
  defs: Pick<Defs, "save" | "list" | "archive" | "resolve">;
  artifacts: Pick<Artifacts, "put">;
}): LegacyImporter {
  return {
    run({ from, dryRun }) {
      const plan = planImport(store, defs, readSource(from));
      const created = countOf(plan);
      if (!dryRun) apply({ store, defs, artifacts }, plan, from, created);
      return { dryRun, created, unresolvedRepos: [...plan.unresolvedRepos].sort() };
    },
  };
}

function readSource(from: string): Source {
  const metricsPath = join(from, "metrics.jsonl");
  if (!existsSync(metricsPath)) {
    throw new LegacyImportError(`No hay metrics.jsonl en ${from}: --from debe ser la carpeta del clanker-loop (~/.local/share/clanker-loop).`);
  }
  // Solo lo que no se puede leer como el loop lo escribe es un `LegacyImportError` (con el archivo); otro fallo es un bug.
  const parsing = <T>(path: string, parse: () => T): T => {
    try {
      return parse();
    } catch (error) {
      throw new LegacyImportError(`${path}: ${messageOf(error)}`, { cause: error });
    }
  };
  const states = new Map<string, LegacyState>();
  const issueFiles = new Map<string, { name: string; content: string }[]>();
  const projectsDir = join(from, "projects");
  const dirs = existsSync(projectsDir) ? readdirSync(projectsDir, { withFileTypes: true }) : [];
  for (const dir of dirs.filter((d) => d.isDirectory()).sort((a, b) => a.name.localeCompare(b.name))) {
    const statePath = join(projectsDir, dir.name, "state.md");
    if (!existsSync(statePath)) continue;
    states.set(dir.name, parsing(statePath, () => parseLegacyState(readFileSync(statePath, "utf8"))));
    const issuesDir = join(projectsDir, dir.name, "issues");
    if (existsSync(issuesDir)) {
      const files = readdirSync(issuesDir).filter((name) => name.endsWith(".md")).sort();
      issueFiles.set(dir.name, files.map((name) => ({ name, content: readFileSync(join(issuesDir, name), "utf8") })));
    }
  }
  const profilesPath = join(from, "profiles.json");
  const profiles = existsSync(profilesPath) ? parsing(profilesPath, () => parseLegacyProfiles(readFileSync(profilesPath, "utf8"))) : undefined;
  const metrics = parsing(metricsPath, () => parseLegacyMetrics(readFileSync(metricsPath, "utf8")));
  return { metrics, states, issueFiles, profiles };
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

function planImport(store: Store, defs: Pick<Defs, "list" | "resolve">, { metrics, states, issueFiles, profiles }: Source): Plan {
  const { db } = store;
  const plan: Plan = {
    projects: [],
    projectRepos: [],
    issues: [],
    runs: [],
    runMetrics: [],
    runRoleCosts: [],
    pullRequests: [],
    learnings: [],
    decisions: [],
    artifacts: [],
    profiles: [],
    modelPrices: [],
    unresolvedRepos: new Set(),
    expected: new Map(),
  };
  const at = Date.now();

  const knownProjects = new Map(db.select({ slug: projects.slug, id: projects.id }).from(projects).all().map((p) => [p.slug, p.id]));
  const knownRepos = db.select().from(repos).all();
  const linked = new Set(db.select().from(projectRepos).all().map((r) => `${r.projectId}:${r.repoId}`));
  const nextOrd = new Map<ProjectId, number>();
  for (const { projectId } of db.select().from(projectRepos).all()) nextOrd.set(projectId, (nextOrd.get(projectId) ?? 0) + 1);
  const knownIssues = new Map(
    db.select({ key: issues.trackerId, id: issues.id }).from(issues).where(eq(issues.tracker, "linear")).all().map((i) => [i.key, i.id]),
  );
  const knownRuns = new Map(db.select({ key: runs.sourceKey, id: runs.id }).from(runs).where(isNotNull(runs.sourceKey)).all().map((r) => [r.key!, r.id]));
  /** `repoId#número` → id de la fila de `pull_requests`, la que ya estaba o la que este plan agrega. */
  const pullIds = new Map(db.select({ id: pullRequests.id, repoId: pullRequests.repoId, number: pullRequests.number }).from(pullRequests).all().map((p) => [`${p.repoId}#${p.number}`, p.id]));
  const knownLearnings = new Set(db.select({ projectId: learnings.projectId, text: learnings.text }).from(learnings).where(isNotNull(learnings.projectId)).all().map((l) => `${l.projectId}\0${l.text}`));
  const knownNotes = new Set(
    db.select({ projectId: decisions.projectId, kind: decisions.kind, body: decisions.body }).from(decisions).where(isNotNull(decisions.projectId)).all().map((d) => `${d.projectId}\0${d.kind}\0${d.body}`),
  );
  const artifactCandidates: PlannedArtifact[] = [];
  const afterProjects: (() => void)[] = [];

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
    const expected: ExpectedTotals = { projectId, runs: 0, costMicros: 0, roleMicros: new Map(), rounds: new Map() };
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
      for (const [role, cost] of roleCosts) expected.roleMicros.set(role, (expected.roleMicros.get(role) ?? 0) + usdToMicros(cost.usd ?? 0));
      for (const [counter, n] of Object.entries(counters(row))) expected.rounds.set(counter, (expected.rounds.get(counter) ?? 0) + n);
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
      if (!repoId || pullIds.has(`${repoId}#${h.pr.number}`)) continue;
      const pullId = newId("pr");
      pullIds.set(`${repoId}#${h.pr.number}`, pullId);
      const candidates = plannedRuns.get(`${slug}:${h.key}`) ?? [];
      const run =
        candidates.find((c) => c.pr?.number === h.pr!.number && c.pr.repo === repoName) ??
        candidates.reduce<(typeof candidates)[number] | undefined>((last, c) => (!last || c.endedAt >= last.endedAt ? c : last), undefined);
      // Lo que GitHub sabe (nodo, SHA, base) queda vacío hasta que Watch sincronice el PR. `owned` es falso: no lo abrió Clanker Yard.
      plan.pullRequests.push({
        id: pullId,
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

    // Los PRs de una viñeta que el historial no tiene entran abiertos y sin detalle: Watch los lee y fija su estado.
    const prRepo = prRepoByNumber(state, rows);
    const onlyRepo = repoIds.size === 1 ? [...repoIds.values()][0] : undefined;
    const subjectOf = (text: string): SubjectRef | undefined => {
      const head = noteHead(text);
      const key = /^([A-Z][A-Z0-9]*-\d+)\b/.exec(head)?.[1];
      const number = /#(\d+)/.exec(head)?.[1];
      // Sin repo conocido para el número, solo hay a quién atribuírselo si el proyecto tiene un único repo.
      const repoName = number === undefined ? undefined : prRepo.get(Number(number));
      const repoId = number === undefined || repoName === null ? undefined : repoName === undefined ? onlyRepo : repoIds.get(repoName);
      if (number !== undefined && repoId !== undefined) {
        const pullKey = `${repoId}#${number}`;
        if (!pullIds.has(pullKey)) {
          const id = newId("pr");
          pullIds.set(pullKey, id);
          plan.pullRequests.push({
            id,
            repoId,
            number: Number(number),
            nodeId: "",
            headRef: "",
            baseRef: "",
            headSha: "",
            state: "open",
            isDraft: false,
            issueId: key === undefined ? null : (knownIssues.get(key) ?? null),
            runId: null,
            owned: false,
          });
        }
        return { type: "pr", id: pullIds.get(pullKey)! };
      }
      const issueId = key === undefined ? undefined : knownIssues.get(key);
      return issueId === undefined ? undefined : { type: "issue", id: issueId };
    };

    for (const text of state.learnings) {
      const learningKey = `${projectId}\0${text}`;
      if (knownLearnings.has(learningKey)) continue;
      knownLearnings.add(learningKey);
      plan.learnings.push({ projectId, text });
    }
    const notes = [
      { kind: "review_note", status: "pending", texts: state.reviewNotes },
      { kind: "note", status: "accepted", texts: state.skipped },
    ] as const;
    // Una viñeta puede nombrar una issue que otro proyecto creó después: el sujeto se busca cuando ya están todas.
    afterProjects.push(() => {
      for (const { kind, status, texts } of notes) {
        for (const text of texts) {
          const noteKey = `${projectId}\0${kind}\0${text}`;
          if (knownNotes.has(noteKey)) continue;
          knownNotes.add(noteKey);
          const subject = subjectOf(text);
          plan.decisions.push({
            id: newId("dec"),
            projectId,
            ...(subject && { subject }),
            kind,
            title: titleOf(text),
            body: text,
            options: [],
            status,
            ...(status === "accepted" && { resolvedBy: "import", resolvedAt: at }),
            createdAt: at,
          });
        }
      }
    });

    if (state.brief !== undefined) artifactCandidates.push(artifactOf({ type: "project", id: projectId, role: "legacy:brief" }, "legacy", state.brief));
  }

  for (const resolve of afterProjects) resolve();

  // Los archivos de issues/ cuelgan de la última corrida importada de la issue o, sin corrida, de la issue. Va después de
  // todos los proyectos por lo mismo: una issue que otro proyecto creó tiene que estar antes de buscarle dueño.
  for (const [slug, files] of issueFiles) {
    for (const { name, content } of files) {
      const file = /^([A-Z][A-Z0-9]*-\d+)(?:-(.+))?\.md$/.exec(name);
      if (!file) continue;
      const key = file[1]!;
      const suffix = file[2];
      const lastRun = (plannedRuns.get(`${slug}:${key}`) ?? []).reduce<{ id: RunId; endedAt: number } | undefined>((last, r) => (!last || r.endedAt >= last.endedAt ? r : last), undefined);
      const issueId = knownIssues.get(key);
      const owner = lastRun ? { type: "run" as const, id: lastRun.id } : issueId ? { type: "issue" as const, id: issueId } : undefined;
      if (!owner) continue;
      const kind: ArtifactKind = suffix?.startsWith("pr") ? "pr_body" : "legacy";
      artifactCandidates.push(artifactOf({ ...owner, role: `legacy:${suffix ?? "checkpoint"}` }, kind, content));
    }
  }

  // Un artefacto cuyo dueño ya tiene ese contenido en ese role no cambia nada; uno que cambió reemplaza al anterior.
  const owners = [...new Set(artifactCandidates.map((a) => a.owner.id))];
  const existingRefs = new Map(
    owners.length === 0
      ? []
      : db
          .select()
          .from(artifactRefs)
          .where(inArray(artifactRefs.ownerId, owners))
          .all()
          .map((r) => [`${r.ownerType}:${r.ownerId}:${r.role}`, r.hash]),
  );
  plan.artifacts = artifactCandidates.filter((a) => existingRefs.get(`${a.owner.type}:${a.owner.id}:${a.owner.role}`) !== a.hash);

  if (profiles) {
    const existing = new Set(defs.list("profile", { includeArchived: true }).filter((d) => d.scope === "user").map((d) => d.slug));
    for (const { slug, roles } of profiles.profiles) {
      // Un perfil que la persona ya tiene (o editó) no se pisa.
      if (existing.has(slug)) continue;
      // La def de usuario tapa a la de la plantilla entera: los roles que el loop viejo no conocía (`triage`) se heredan de ella.
      const inherited = defs.resolve("profile", slug);
      const parsed = Profile.safeParse({ roles: { ...(inherited ? Profile.parse(inherited.body).roles : {}), ...roles } });
      if (!parsed.success) throw new LegacyImportError(`profiles.json: el perfil "${slug}" no es válido:\n${z.prettifyError(parsed.error)}`);
      plan.profiles.push({ slug, body: parsed.data });
    }
    const priced = new Set(db.select({ model: modelPrices.model }).from(modelPrices).where(eq(modelPrices.validFrom, 0)).all().map((p) => p.model));
    plan.modelPrices = profiles.prices.filter((p) => !priced.has(p.model)).map((p) => ({ ...p, validFrom: 0 }));
  }
  return plan;
}

const artifactOf = (owner: PlannedArtifact["owner"], kind: ArtifactKind, content: string): PlannedArtifact => ({
  owner,
  kind,
  content,
  hash: hashOf(Buffer.from(content, "utf8")),
});

/** Lo que una viñeta dice de sí antes del `:` (`ENG-9105 (#4193)`), o sus primeros 80 caracteres si no hay. */
function noteHead(text: string): string {
  const colon = text.indexOf(":");
  return text.slice(0, colon > 0 && colon <= 80 ? colon : 80);
}

/** El título de una decisión importada: la viñeta, cortada en una palabra si pasa de 100 caracteres. */
function titleOf(text: string): string {
  const oneLine = text.replace(/\s+/g, " ");
  if (oneLine.length <= 100) return oneLine;
  return `${oneLine.slice(0, 100).replace(/\s+\S*$/, "")}…`;
}

/** De qué repo es cada número de PR que el proyecto conoce (historial y `metrics.jsonl`); `null` si dos repos lo usan. */
function prRepoByNumber(state: LegacyState, rows: LegacyMetricsRow[]): Map<number, string | null> {
  const found = new Map<number, string | null>();
  const add = (number: number, repo: string | undefined) => {
    if (repo === undefined) return;
    found.set(number, found.has(number) && found.get(number) !== repo ? null : repo);
  };
  for (const h of state.history) if (h.pr) add(h.pr.number, h.pr.repo ?? state.repos[0]?.name);
  for (const { pr } of rows) {
    const match = pr && /github\.com\/[^/]+\/([^/]+)\/pull\/(\d+)/.exec(pr);
    if (match) add(Number(match[2]), match[1]);
  }
  return found;
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
    learnings: plan.learnings.length,
    decisions: plan.decisions.length,
    artifacts: plan.artifacts.length,
    profiles: plan.profiles.length,
    modelPrices: plan.modelPrices.length,
  };
}

/** El flujo histórico (creado una vez y archivado). Va fuera de la tx del import: `defs.save` abre la suya. */
function legacyFlow(defs: Pick<Defs, "save" | "list" | "archive">): { id: string; version: number } {
  const found = defs.list("flow", { includeArchived: true }).find((d) => d.slug === LEGACY_FLOW_SLUG && d.scope === "user");
  const { id, version } = found ? { id: found.id, version: found.currentVersion } : defs.save({ kind: "flow", slug: LEGACY_FLOW_SLUG, scope: "user", body: LEGACY_FLOW, source: "import" });
  if (found?.archivedAt == null) defs.archive("flow", id, "import");
  return { id, version };
}

const diff = (what: string, actual: number, expected: number) => (actual === expected ? [] : [`${what} ${actual} frente a ${expected}`]);

function diffMaps(what: string, actual: Map<string, number>, expected: Map<string, number>): string[] {
  return [...new Set([...actual.keys(), ...expected.keys()])].sort().flatMap((key) => diff(`${what} ${key}`, actual.get(key) ?? 0, expected.get(key) ?? 0));
}

/**
 * Inserta el plan en una sola tx. Si los totales de algún proyecto no cuadran con `metrics.jsonl`, la tx se deshace.
 * Lo que abre su propia tx (el flujo histórico, el contenido de los artefactos y las defs de perfil) va fuera: el flujo
 * antes, porque las corridas lo necesitan, y los perfiles después, para que una importación que falla no deje nada.
 */
function apply(
  { store, defs, artifacts }: { store: Store; defs: Pick<Defs, "save" | "list" | "archive">; artifacts: Pick<Artifacts, "put"> },
  plan: Plan,
  from: string,
  created: LegacyImportCounts,
): void {
  const flow = legacyFlow(defs);
  // Sin refs, el GC se lleva el contenido de un artefacto si la tx falla.
  for (const { content, kind } of plan.artifacts) artifacts.put(content, kind, { mime: "text/markdown; charset=utf-8" });
  store.tx((tx) => {
    const { db } = tx;
    if (plan.projects.length > 0) db.insert(projects).values(plan.projects).run();
    if (plan.projectRepos.length > 0) db.insert(projectRepos).values(plan.projectRepos).run();
    if (plan.issues.length > 0) db.insert(issues).values(plan.issues).run();
    if (plan.runs.length > 0) db.insert(runs).values(plan.runs.map((run) => ({ ...run, flowDefId: flow.id, flowVersion: flow.version }))).run();
    if (plan.runMetrics.length > 0) db.insert(runMetrics).values(plan.runMetrics).run();
    if (plan.runRoleCosts.length > 0) db.insert(runRoleCosts).values(plan.runRoleCosts).run();
    if (plan.pullRequests.length > 0) db.insert(pullRequests).values(plan.pullRequests).run();
    // Los learnings entran `proposed` (decisión 19) y `proposeLearning` no repite un texto del mismo alcance.
    for (const { projectId, text } of plan.learnings) proposeLearning(tx, { projectId, text, source: "import", origin: "import" });
    if (plan.decisions.length > 0) db.insert(decisions).values(plan.decisions).run();
    if (plan.modelPrices.length > 0) db.insert(modelPrices).values(plan.modelPrices).onConflictDoNothing().run();
    for (const { owner, hash } of plan.artifacts) {
      // Lo que el loop reescribió desde la última importación reemplaza a lo anterior en ese role.
      db.delete(artifactRefs).where(and(eq(artifactRefs.ownerType, owner.type), eq(artifactRefs.ownerId, owner.id), eq(artifactRefs.role, owner.role))).run();
      db.insert(artifactRefs).values({ hash, ownerType: owner.type, ownerId: owner.id, role: owner.role }).run();
    }

    // Paridad (`docs/design.html#d-data`): `projects.summary`, lo que muestra la app, suma lo mismo que el archivo de origen
    // (corridas, costo, costo por rol y rondas, las cifras del LoopSummary de Control).
    const summaries = createMetrics({ store: tx });
    for (const [slug, expected] of plan.expected) {
      const actual = summaries.summary(expected.projectId, { imported: true });
      const differences = [
        ...diff("corridas", actual.runs, expected.runs),
        ...diff("micros de costo", actual.costMicros, expected.costMicros),
        ...diffMaps("micros del rol", new Map(actual.byRole.map((r) => [r.role, r.costMicros])), expected.roleMicros),
        ...diffMaps("rondas", new Map(actual.rounds.map((r) => [r.counter, r.total])), expected.rounds),
      ];
      if (differences.length > 0) {
        throw new LegacyImportError(
          `La importación de "${slug}" no cuadra con metrics.jsonl (base frente a archivo): ${differences.join("; ")}. No se escribió nada.`,
        );
      }
    }
    tx.emit({ type: "import.completed", origin: "import", payload: { source: from, counts: created } });
  });
  for (const { slug, body } of plan.profiles) defs.save({ kind: "profile", slug, scope: "user", body, source: "import" });
}

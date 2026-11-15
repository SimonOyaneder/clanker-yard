import type {
  CachedIssue,
  ClankerProject,
  IssueRef,
  Person,
  QueueBase,
  QueueEntry,
  QueuePr,
  RunStatus,
  StatusCategory,
  TrackerCapabilities,
} from "@clanker/api";
import { repoOf } from "../projects/repo-of";
import { matchesIssueFilter } from "../tracker/tracker";

/** Una corrida raíz del carril dev sobre una issue. */
export interface QueueRun {
  issueId: string;
  status: RunStatus;
  /** El `@fin` con que terminó el flujo (`done`, `blocked`, `failed`); `null` mientras vive. */
  outcome: string | null;
}

/** Un PR abierto (draft o no) que el sistema abrió para una issue. */
export interface QueuePrFact {
  issueId: string;
  repoId: string;
  /** `repo#número`. */
  key: string;
  headRef: string;
  baseRef: string;
  /** Solo se lee con `stackOn: "ci_green"`; `unread` es que GitHub no se pudo consultar (`ciError` dice por qué). */
  ci: "green" | "not_green" | "unread";
  ciError?: string;
}

export interface TickDevInput {
  project: Pick<ClankerProject, "id" | "queueFilter" | "stackOn" | "repos">;
  /** La persona del tracker: sus issues y las sin dueño son elegibles. */
  me: Person;
  capabilities: TrackerCapabilities;
  /** Todo el caché de issues, no solo el del proyecto: bloqueantes y sub-issues pueden ser de otro. */
  issues: readonly CachedIssue[];
  runs: readonly QueueRun[];
  prs: readonly QueuePrFact[];
  /** Ids de issues que el usuario pidió no lanzar (`projects.skipIssue`): quedan en la cola como `blocked`. */
  skipped?: ReadonlySet<string>;
}

const LIVE: ReadonlySet<RunStatus> = new Set(["queued", "running", "waiting", "parked", "paused"]);
const CLOSED: ReadonlySet<StatusCategory> = new Set(["done", "canceled"]);

/**
 * La cola de un proyecto (`tickDev` de `docs/design.html#d-ops`): las issues elegibles, ordenadas y
 * clasificadas. Es una función pura del estado que recibe, sin I/O. Primero salen las `ready` (en el
 * orden en que se lanzarían), luego las `waiting` y las `blocked`.
 *
 * Elegible: su estado está en `queueFilter.status` (default `todo`), calza `queueFilter.labels`, no tiene
 * ninguno de `excludeLabels` (default `no-clanker`), no tiene dueño o es `me`, no tiene sub-issues abiertas
 * y ninguna corrida del carril dev la tomó (viva o terminada: una issue terminada no vuelve a la cola).
 *
 * Una issue que el usuario saltó (`skipped`) sale `blocked` con ese motivo.
 *
 * Orden: prioridad (0 al final), milestone (el que vence antes, luego el que no tiene fecha, luego
 * sin milestone), la que bloquea a más issues, estimate menor (sin estimate al final) y la más antigua.
 */
export function tickDev(input: TickDevInput): QueueEntry[] {
  const { project, me, capabilities, issues } = input;
  const filter = {
    ...project.queueFilter,
    status: project.queueFilter.status ?? ["todo"],
    excludeLabels: project.queueFilter.excludeLabels ?? ["no-clanker"],
  };
  const byRef = new Map(issues.map((issue) => [refKey(issue.ref), issue]));
  const runsOf = groupBy(input.runs, (run) => run.issueId);
  const prsOf = groupBy(input.prs, (pr) => pr.issueId);
  const childrenOf = groupBy(
    capabilities.subIssues ? issues.filter((issue) => issue.parent !== undefined) : [],
    (issue) => refKey(issue.parent!),
  );

  const eligible = issues
    .filter(
      (issue) =>
        issue.projectId === project.id &&
        matchesIssueFilter(issue, filter) &&
        (issue.assignee === undefined || issue.assignee.id === me.id) &&
        !(childrenOf.get(refKey(issue.ref)) ?? []).some((child) => !CLOSED.has(child.status)) &&
        !runsOf.has(issue.id),
    )
    .sort(byQueueOrder);

  const world: World = { project, me, byRef, runsOf, prsOf };
  const entries = eligible.map(
    (issue): QueueEntry =>
      input.skipped?.has(issue.id)
        ? { issue, state: "blocked", reason: "saltada a mano: el usuario pidió que el Scheduler no la lance (projects.skipIssue)" }
        : classify(issue, capabilities.relations ? issue.relations.blockedBy : [], world),
  );
  return [...entries.filter((e) => e.state === "ready"), ...entries.filter((e) => e.state === "waiting"), ...entries.filter((e) => e.state === "blocked")];
}

interface World {
  project: TickDevInput["project"];
  me: Person;
  byRef: ReadonlyMap<string, CachedIssue>;
  runsOf: ReadonlyMap<string, QueueRun[]>;
  prsOf: ReadonlyMap<string, QueuePrFact[]>;
}

/** Lo que una issue bloqueante le deja a la bloqueada: nada, PRs sobre los que apilarse o depender, o esperar. */
type Verdict =
  | { kind: "free" }
  | { kind: "pr"; stack: QueuePrFact[]; cross: QueuePrFact[] }
  | { kind: "waiting" | "blocked"; reason: string };

function classify(issue: CachedIssue, blockers: readonly IssueRef[], world: World): QueueEntry {
  const repo = repoOf(world.project, issue.labels);
  const verdicts = blockers.map((ref) => judge(ref, repo, world));

  const blocked = verdicts.flatMap((v) => (v.kind === "blocked" ? [v.reason] : []));
  if (blocked.length > 0) return { issue, state: "blocked", reason: blocked.join("; ") };
  const waiting = verdicts.flatMap((v) => (v.kind === "waiting" ? [v.reason] : []));
  if (waiting.length > 0) return { issue, state: "waiting", reason: waiting.join("; ") };

  const prs = verdicts.filter((v) => v.kind === "pr");
  const stack = uniqueByKey(prs.flatMap((v) => v.stack));
  const dependsOn = uniqueByKey(prs.flatMap((v) => v.cross)).map((pr) => pr.key);
  const base = baseOf(stack);
  const parts = [
    base.kind === "default"
      ? "lista sobre la branch por defecto"
      : base.kind === "stacked"
        ? `apilada sobre ${base.parent.key}`
        : `base combinada de ${base.parents.map((p) => p.key).join(" y ")}`,
    ...(dependsOn.length > 0 ? [`depende de ${dependsOn.join(", ")}`] : []),
  ];
  return { issue, state: "ready", reason: parts.join(", "), base, dependsOn };
}

/** La tabla de bloqueantes de `docs/design.html#d-ops`, para un bloqueante. */
function judge(ref: IssueRef, repo: string | undefined, world: World): Verdict {
  const blocker = world.byRef.get(refKey(ref));
  if (blocker === undefined) {
    return { kind: "blocked", reason: `bloqueada por ${ref.key}, que no está en el caché de issues (¿otro proyecto sin sincronizar?)` };
  }
  if (CLOSED.has(blocker.status)) return { kind: "free" };

  const open = world.prsOf.get(blocker.id) ?? [];
  const runs = world.runsOf.get(blocker.id) ?? [];
  const stack = open.filter((pr) => pr.repoId === repo && stacksOn(pr, runs, world.project.stackOn));
  const cross = open.filter((pr) => pr.repoId !== repo);
  if (stack.length > 0 || cross.length > 0) return { kind: "pr", stack, cross };

  const parked = open.filter((pr) => !stack.includes(pr));
  const pending = parked.map((pr) => pendingReason(pr, world.project.stackOn)).join(" y ");
  if (runs.some((run) => LIVE.has(run.status))) {
    return { kind: "waiting", reason: pending === "" ? `espera a ${blocker.ref.key}, en curso` : `espera a ${blocker.ref.key}: ${pending}` };
  }
  const owner = blocker.assignee !== undefined && blocker.assignee.id !== world.me.id ? `, de ${blocker.assignee.name}` : "";
  const why = pending === "" ? `no tiene PR abierto ni corrida en curso` : `${pending} y su corrida ya terminó`;
  return { kind: "blocked", reason: `bloqueada por ${blocker.ref.key} (${blocker.rawStatus}${owner}): ${why}` };
}

/** Si el PR deja que otra issue se apile sobre él, según el `stackOn` del proyecto. */
function stacksOn(pr: QueuePrFact, blockerRuns: readonly QueueRun[], stackOn: TickDevInput["project"]["stackOn"]): boolean {
  switch (stackOn) {
    case "any_open":
      return true;
    case "ci_green":
      return pr.ci === "green";
    case "ready":
      return blockerRuns.some((run) => run.status === "done" && run.outcome === "done");
  }
}

function pendingReason(pr: QueuePrFact, stackOn: TickDevInput["project"]["stackOn"]): string {
  if (stackOn === "ci_green" && pr.ci === "unread") return `no se pudo leer el CI de ${pr.key} (${pr.ciError ?? "sin detalle"})`;
  return `el PR ${pr.key} todavía no cumple stackOn ${stackOn}`;
}

/**
 * La base de una issue con estos PRs de su mismo repo como padres: la branch por defecto sin padres, el
 * PR si hay uno, el de más arriba si todos están en una misma cadena de stack, y si no una base combinada.
 */
function baseOf(parents: readonly QueuePrFact[]): QueueBase {
  const asPr = (pr: QueuePrFact): QueuePr => ({ key: pr.key, branch: pr.headRef });
  // Las puntas de las cadenas: un PR del que ningún otro padre cuelga.
  const tops = parents.filter((pr) => !parents.some((other) => other.baseRef === pr.headRef));
  const [top, second, ...rest] = tops;
  if (top === undefined) return { kind: "default" };
  if (second === undefined) return { kind: "stacked", parent: asPr(top) };
  return { kind: "combined", parents: [asPr(top), asPr(second), ...rest.map(asPr)] };
}

/** Prioridad, milestone, bloquea a otras, estimate y antigüedad (el id del caché es un ULID: se ordena por creación). */
function byQueueOrder(a: CachedIssue, b: CachedIssue): number {
  return (
    priorityRank(a) - priorityRank(b) ||
    milestoneRank(a) - milestoneRank(b) ||
    (a.milestone?.due ?? "").localeCompare(b.milestone?.due ?? "") ||
    (a.milestone?.name ?? "").localeCompare(b.milestone?.name ?? "") ||
    b.relations.blocks.length - a.relations.blocks.length ||
    (a.estimate ?? Infinity) - (b.estimate ?? Infinity) ||
    a.id.localeCompare(b.id)
  );
}

/** 1 urgente ... 4 baja, y 0 (sin prioridad) después de la 4. */
const priorityRank = (issue: CachedIssue) => (issue.priority === 0 ? 5 : issue.priority);

/** Con fecha de entrega primero, luego el milestone sin fecha y al final las issues sin milestone. */
const milestoneRank = (issue: CachedIssue) => (issue.milestone === undefined ? 2 : issue.milestone.due === undefined ? 1 : 0);

const refKey = (ref: IssueRef) => `${ref.tracker}:${ref.id}`;

function groupBy<T, K>(items: readonly T[], key: (item: T) => K): Map<K, T[]> {
  const groups = new Map<K, T[]>();
  for (const item of items) {
    const group = groups.get(key(item));
    if (group) group.push(item);
    else groups.set(key(item), [item]);
  }
  return groups;
}

function uniqueByKey(prs: readonly QueuePrFact[]): QueuePrFact[] {
  return [...new Map(prs.map((pr) => [pr.key, pr])).values()];
}

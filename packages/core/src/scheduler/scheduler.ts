import type { CachedIssue, ClankerProject, IssueId, Origin, ProjectId, QueueEntry } from "@clanker/api";
import { and, eq, inArray, isNull } from "drizzle-orm";
import type { RuntimeId } from "../agents/runtime";
import type { Breakers as AllBreakers } from "../breakers/breakers";
import { openDecision } from "../decisions/decisions";
import type { Engine } from "../flows/engine";
import { hasRoom } from "../flows/lanes";
import type { Projects } from "../projects/projects";
import { ProjectNotFoundError } from "../projects/projects";
import { askWhichRepo, issuePlan } from "../projects/repo-question";
import type { RunStarter } from "../projects/start-run";
import { issueBoosts, issueSkips, issues as issuesTable, runs } from "../store/schema";
import type { Store, Tx } from "../store/store";
import type { Issues } from "../tracker/issues";
import { storedBinding, type ProjectBindings } from "../tracker/tracker-projects";
import type { Trackers } from "../tracker/trackers";
import type { Repos } from "../repos/repos";
import { combinedBaseBranch, type Workspaces } from "../workspaces/workspaces";
import { messageOf } from "../errors/format";
import { createErrorReporter, type ErrorReporter } from "../errors/reporter";
import type { LaneSettings } from "./lanes";
import type { ProjectQueue } from "./project-queue";

/** El tick periódico del diseño (`docs/design.html#d-ops`, "Scheduler: la cola"), además de los eventos que lo disparan. */
export const SCHEDULER_TICK_MS = 5 * 60_000;
/** El `scope` de los eventos `error` de un tick, uno por proyecto. */
const TICK_SCOPE = "scheduler.tick";

/** Lo que cambia lo que el Scheduler puede lanzar: el resto de los momentos del tick (boot y cada 5 min) los pone `start`. */
const TRIGGERS = [
  "run.finished",
  "run.parked",
  "decision.resolved",
  "issue.synced",
  "issue.queued",
  "pr.merged",
  "breaker.closed",
  "project.created",
  "project.updated",
  "project.resumed",
] as const;

/** Los estados en que una corrida de dev sobre una issue sigue en vuelo. */
const IN_FLIGHT = ["queued", "running", "waiting", "parked", "paused"] as const;

/**
 * Los circuit breakers por causa (`docs/design.html#d-ops`, `breakers/`): el Scheduler no lanza issues de un
 * `repo:<id>` ni del `runtime:<id>` pausados. El breaker `github` solo frena a quien publica, no el lanzamiento.
 */
export type Breakers = Pick<AllBreakers, "openReason">;

export interface SchedulerDeps {
  store: Store;
  projects: Projects;
  issues: Issues;
  repos: Repos;
  /** Los adapters que este core conoce, por id de tracker: el tick trae de ahí lo que cambió antes de leer la cola. */
  trackers: Trackers;
  /** De dónde sale la cola de un proyecto (`TrackerProjects.binding`); sin él, su `trackerRef` guardado. */
  binding?: ProjectBindings;
  flows: Pick<Engine, "wake">;
  /** `runs.start`: reclama la issue y lanza el flujo. */
  runs: Pick<RunStarter, "start">;
  /** La cola sin las marcas del Scheduler (`createProjectQueue`). */
  queue: ProjectQueue;
  /** Arma (y disuelve) la base combinada de una issue con varios padres antes de lanzar su corrida. */
  workspaces: Pick<Workspaces, "combineBase" | "dissolveBase">;
  lanes: LaneSettings;
  /** El runtime con que corren los agentes de este core: su breaker pausa todos los lanzamientos. */
  runtime: RuntimeId;
  /** Sin él nada está pausado. */
  breakers?: Breakers;
  /** Dónde se anota lo que falla en un tick; por defecto uno propio sobre `store`. */
  errors?: ErrorReporter;
  tickMs?: number;
}

export interface Scheduler {
  /**
   * Un tick del Scheduler: admite las corridas que esperan cupo (mantenimiento primero) y, proyecto por
   * proyecto, trae del tracker lo que cambió (`issues.sync`) y lanza las issues `ready` de su cola mientras
   * haya cupo en dev. Si ya hay uno en curso no
   * corre otro en paralelo: pide uno más al terminar. Nunca lanza: lo que falla queda en un evento. Resuelve
   * cuando el Scheduler ya no tiene nada pendiente.
   */
  tick(): Promise<void>;
  /**
   * `projects.queue` con lo que el último tick no pudo lanzar: una issue `ready` que se saltó (reclamo
   * perdido, relacionada con una corrida en vuelo, repo o runtime en pausa, padres de una base combinada que
   * chocan) sale `waiting` con ese motivo.
   */
  queue: ProjectQueue;
  /** Pide (o devuelve) que el Scheduler no lance la issue. Lanza `ProjectNotFoundError` o `IssueNotInProjectError`. */
  skipIssue(input: { projectId: ProjectId; issueId: IssueId; skipped: boolean }, origin: Origin): void;
  /** Sube la issue al principio de la cola (o la devuelve a su lugar con `boosted: false`) y emite `issue.queued`. */
  boostIssue(input: { projectId: ProjectId; issueId: IssueId; boosted: boolean }, origin: Origin): void;
  /** Hace el tick de arranque y deja los demás en sus momentos: los eventos de `TRIGGERS` y cada 5 min. */
  start(): void;
  /** Deja de lanzar y espera al tick en curso. Antes de apagar el motor, para que el cierre no abra corridas nuevas. */
  close(): Promise<void>;
}

/** La issue no existe o no es del proyecto. */
export class IssueNotInProjectError extends Error {}

export function createScheduler(deps: SchedulerDeps): Scheduler {
  const { store, projects, issues, repos, lanes, breakers } = deps;
  const errors = deps.errors ?? createErrorReporter(store);
  /** Lo que el último tick no pudo lanzar de cada proyecto, con su motivo. */
  const skipped = new Map<ProjectId, Map<IssueId, string>>();
  let running: Promise<void> | undefined;
  let again = false;
  let closed = false;
  let timer: NodeJS.Timeout | undefined;
  let unsubscribe: (() => void) | undefined;

  function tick(): Promise<void> {
    if (running) {
      again = true;
      return running;
    }
    running = loop();
    return running;
  }

  /** Corre ticks mientras alguien haya pedido otro; `running` se limpia en el mismo turno en que el último termina, así ningún disparo se pierde. */
  async function loop(): Promise<void> {
    // Que `running` ya esté asignado antes de que `pass` (y el `wake` del motor, que emite eventos) corra.
    await Promise.resolve();
    try {
      do {
        again = false;
        try {
          await pass();
        } catch (error) {
          // Un tick corre desde timers y eventos: un throw tumbaría el core.
          console.error("El tick del Scheduler falló:", error);
        }
      } while (again && !closed);
    } finally {
      running = undefined;
    }
  }

  async function pass(): Promise<void> {
    if (closed) return;
    // Primero lo que ya tiene dueño de cupo: el mantenimiento y las corridas que vuelven de estacionadas van antes que las issues nuevas.
    deps.flows.wake();
    for (const project of projects.list()) {
      if (closed) return;
      if (project.status !== "active") continue;
      try {
        await launch(project);
        errors.clear(TICK_SCOPE, { projectId: project.id });
      } catch (error) {
        errors.report(TICK_SCOPE, error, { projectId: project.id });
      }
    }
  }

  /** Lanza las issues `ready` de la cola del proyecto, en orden, mientras su carril dev tenga cupo. */
  async function launch(project: ClankerProject): Promise<void> {
    const tracker = deps.trackers(project);
    if (tracker) await issues.sync(tracker, await (deps.binding ?? storedBinding)(project), "core");
    const entries = await deps.queue.of(project.id);
    const cache = issues.list();
    const inFlight = issuesInFlight();
    const marks = new Map<IssueId, string>();
    try {
      for (const entry of entries) {
        if (entry.state === "blocked" && !entry.skipped && issuePlan(store, repos, project, entry.issue).kind === "ambiguous") {
          askWhichRepo(store, repos, project, entry.issue);
        }
        if (entry.state !== "ready") continue;
        const { issue } = entry;
        if (closed || !hasRoom(store.db, lanes.capacity(), { lane: "dev", projectId: project.id })) break;

        const held = holdBack(project, issue, cache, inFlight);
        if (held !== undefined) {
          marks.set(issue.id, held);
          continue;
        }
        try {
          const resolved = await baseParams(project, issue, entry.base);
          if (resolved.held !== undefined) {
            marks.set(issue.id, resolved.held);
            continue;
          }
          const params = { ...resolved.params, ...(entry.dependsOn.length > 0 ? { dependsOn: entry.dependsOn } : {}) };
          await deps.runs.start({ projectId: project.id, issueId: issue.id, params }, "core");
          inFlight.add(issue.id);
        } catch (error) {
          // Un claim perdido, un flujo que falta: esta issue queda con su motivo y sigue la siguiente.
          marks.set(issue.id, messageOf(error));
        }
      }
    } finally {
      remember(project.id, marks);
    }
  }

  /** Por qué esta issue `ready` no se lanza ahora (relacionada con algo en vuelo, repo o runtime en pausa), o `undefined`. */
  function holdBack(project: ClankerProject, issue: CachedIssue, cache: readonly CachedIssue[], inFlight: ReadonlySet<string>): string | undefined {
    const related = conflictsWithRunning(issue, cache, inFlight);
    if (related !== undefined) return `relacionada con ${related.ref.key}, que está en vuelo: no corren a la vez`;
    const repoId = repoOfIssue(project, issue);
    const paused = (repoId === undefined ? undefined : pausedBecause(`repo:${repoId}`)) ?? pausedBecause(`runtime:${deps.runtime}`);
    return paused;
  }

  /** El repo donde correrá la issue, si ya se sabe (ver `issuePlan`). */
  function repoOfIssue(project: ClankerProject, issue: CachedIssue): string | undefined {
    const plan = issuePlan(store, repos, project, issue);
    return plan.kind === "repos" ? plan.next?.repoId : undefined;
  }

  /**
   * Los params de la corrida para la base de la cola. Una base combinada se arma aquí, antes de lanzar: la corrida
   * sale de su branch sintética. Si los padres chocan la issue no se lanza (`held` con el motivo) y, la primera vez,
   * queda una nota no bloqueante; espera a que se mergee un padre. Una base que ya no es combinada disuelve la que
   * hubiera quedado de un intento anterior.
   */
  async function baseParams(
    project: ClankerProject,
    issue: CachedIssue,
    base: Extract<QueueEntry, { state: "ready" }>["base"],
  ): Promise<{ params: Record<string, unknown>; held?: undefined } | { held: string }> {
    const repo = repoOfIssue(project, issue);
    const branch = combinedBaseBranch(issue.ref.key);
    if (base.kind !== "combined") {
      if (repo !== undefined) await deps.workspaces.dissolveBase(repo, branch);
      return { params: base.kind === "stacked" ? { base: base.parent.branch } : {} };
    }
    const parents = base.parents.map((p) => p.key).join(" y ");
    if (repo === undefined) return { held: `su base combinada de ${parents} necesita un repo y el proyecto no tiene ninguno para esta issue` };
    const combined = await deps.workspaces.combineBase({ repo, issueId: issue.id, branch, parents: base.parents });
    if (combined.outcome === "combined") return { params: { base: combined.branch } };
    const clash = `${combined.parent} choca con la branch por defecto${combined.merged.length > 0 ? ` y ${combined.merged.join(", ")}` : ""} en ${combined.files.join(", ")}`;
    if (combined.changed) {
      store.tx((tx) =>
        openDecision(tx, {
          kind: "note",
          title: `${issue.ref.key} espera: los padres de su base combinada chocan`,
          body: `No se lanza ${issue.ref.key} sobre ${parents}: ${clash}. No hace falta hacer nada; se vuelve a intentar sola cuando se mergee un padre.`,
          projectId: project.id,
          subject: { type: "issue", id: issue.id },
        }),
      );
    }
    return { held: `los padres de su base combinada (${parents}) chocan, ${clash}: espera a que se mergee un padre` };
  }

  function pausedBecause(scope: string): string | undefined {
    const reason = breakers?.openReason(scope);
    return reason === undefined ? undefined : `${scope} en pausa: ${reason}`;
  }

  /** Las issues con una corrida de dev viva (también estacionada: conserva su rama y su worktree). */
  function issuesInFlight(): Set<string> {
    return new Set(
      store.db
        .select({ issueId: runs.subjectId })
        .from(runs)
        .where(and(eq(runs.subjectType, "issue"), eq(runs.lane, "dev"), isNull(runs.parentRunId), inArray(runs.status, IN_FLIGHT)))
        .all()
        .map((row) => row.issueId),
    );
  }

  /** Deja el motivo de lo que no se lanzó y avisa (`issue.skipped`) solo cuando el motivo cambió. */
  function remember(projectId: ProjectId, marks: Map<IssueId, string>): void {
    const before = skipped.get(projectId);
    skipped.set(projectId, marks);
    for (const [issueId, reason] of marks) {
      if (before?.get(issueId) === reason) continue;
      store.tx((tx) =>
        tx.emit({ type: "issue.skipped", origin: "core", projectId, subject: { type: "issue", id: issueId }, payload: { issueId, reason } }),
      );
    }
  }

  /** El sujeto de la issue, que debe ser del proyecto. */
  function subjectOf(tx: Tx, projectId: ProjectId, issueId: IssueId) {
    if (!projects.get(projectId)) throw new ProjectNotFoundError(projectId);
    const issue = tx.db.select({ projectId: issuesTable.projectId }).from(issuesTable).where(eq(issuesTable.id, issueId)).get();
    if (issue?.projectId !== projectId) throw new IssueNotInProjectError(`La issue ${issueId} no es del proyecto ${projectId}.`);
    return { type: "issue", id: issueId } as const;
  }

  const queue: ProjectQueue = {
    async of(projectId) {
      const entries = await deps.queue.of(projectId);
      const marks = skipped.get(projectId);
      if (!marks || marks.size === 0) return entries;
      const marked = entries.map((entry): QueueEntry => {
        const reason = marks.get(entry.issue.id);
        return entry.state === "ready" && reason !== undefined ? { issue: entry.issue, state: "waiting", reason } : entry;
      });
      return [...marked.filter((e) => e.state === "ready"), ...marked.filter((e) => e.state === "waiting"), ...marked.filter((e) => e.state === "blocked")];
    },
  };

  return {
    tick,
    queue,

    skipIssue({ projectId, issueId, skipped: skip }, origin) {
      store.tx((tx) => {
        const subject = subjectOf(tx, projectId, issueId);
        if (skip) {
          tx.db.insert(issueSkips).values({ issueId, createdAt: Date.now() }).onConflictDoNothing().run();
          tx.emit({ type: "issue.skipped", origin, projectId, subject, payload: { issueId, reason: "saltada a mano" } });
        } else {
          tx.db.delete(issueSkips).where(eq(issueSkips.issueId, issueId)).run();
          tx.emit({ type: "issue.queued", origin, projectId, subject, payload: { issueId } });
        }
      });
    },

    boostIssue({ projectId, issueId, boosted }, origin) {
      store.tx((tx) => {
        const subject = subjectOf(tx, projectId, issueId);
        if (boosted) {
          // Subirla otra vez la deja arriba de todas: gana la subida más reciente.
          const createdAt = Date.now();
          tx.db.insert(issueBoosts).values({ issueId, createdAt }).onConflictDoUpdate({ target: issueBoosts.issueId, set: { createdAt } }).run();
        } else {
          tx.db.delete(issueBoosts).where(eq(issueBoosts.issueId, issueId)).run();
        }
        tx.emit({ type: "issue.queued", origin, projectId, subject, payload: { issueId } });
      });
    },

    start() {
      unsubscribe = store.events.subscribe(
        ({ type }) => {
          // Los `issue.synced` que provoca el propio tick (el sync tras cada claim) no piden otro tick.
          if (type === "issue.synced" && running) return;
          void tick();
        },
        { types: [...TRIGGERS] },
      );
      timer = setInterval(() => void tick(), deps.tickMs ?? SCHEDULER_TICK_MS).unref();
      void tick();
    },

    async close() {
      closed = true;
      clearInterval(timer);
      unsubscribe?.();
      await running;
    },
  };
}

/**
 * Si `issue` es una de dos relacionadas (`blocks` o `related`, en cualquiera de los dos sentidos) y la otra
 * está en vuelo: nunca corren a la vez. Una issue bloqueada por otra en vuelo no entra aquí: la cola ya la
 * dejó `ready` solo si puede apilarse sobre el PR de su bloqueante (`docs/design.html#d-ops`).
 */
function conflictsWithRunning(issue: CachedIssue, cache: readonly CachedIssue[], inFlight: ReadonlySet<string>): CachedIssue | undefined {
  const key = (ref: { tracker: string; id: string }) => `${ref.tracker}:${ref.id}`;
  const mine = key(issue.ref);
  const named = new Set([...issue.relations.blocks, ...issue.relations.related].map(key));
  return cache.find(
    (other) =>
      other.id !== issue.id &&
      inFlight.has(other.id) &&
      (named.has(key(other.ref)) || other.relations.blockedBy.some((ref) => key(ref) === mine) || other.relations.related.some((ref) => key(ref) === mine)),
  );
}


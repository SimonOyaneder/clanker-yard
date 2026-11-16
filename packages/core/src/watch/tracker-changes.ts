import type { Issues } from "../tracker/issues";
import { storedBinding, type ProjectBindings } from "../tracker/tracker-projects";
import type { Trackers } from "../tracker/trackers";
import type { Projects } from "../projects/projects";
import type { ErrorReporter } from "../errors/reporter";

/** Cada cuánto se le pregunta a cada tracker si cambió algo, sin esperar al tick de 5 min del Scheduler. */
export const TRACKER_EVERY_MS = 60_000;

export interface TrackerChangesDeps {
  projects: Pick<Projects, "list">;
  /** Los adapters que este core conoce, por id de tracker. */
  trackers: Trackers;
  issues: Pick<Issues, "hasChanges">;
  /** De dónde sale la cola de un proyecto (`TrackerProjects.binding`); sin él, su `trackerRef` guardado. */
  binding?: ProjectBindings;
  /** Hay issues nuevas o modificadas que traer: el Scheduler hace tick (`tick()` trae lo que cambió y lanza). */
  onChanges(): void;
  errors: ErrorReporter;
}

export interface TrackerChanges {
  /** Pregunta a los trackers de los proyectos activos que ya tocan; un tracker caído se anota y no frena a los demás. */
  poll(at: number): Promise<void>;
}

/** Los cambios de Linear (`Tracker.changesSince`) despiertan al Scheduler (`docs/design.html#d-ops`, "Scheduler: la cola"). */
export function createTrackerChanges({ projects, trackers, issues, binding = storedBinding, onChanges, errors }: TrackerChangesDeps): TrackerChanges {
  const lastPoll = new Map<string, number>();
  return {
    async poll(at) {
      for (const project of projects.list()) {
        if (project.status !== "active" || at - (lastPoll.get(project.id) ?? Number.NEGATIVE_INFINITY) < TRACKER_EVERY_MS) continue;
        const scope = `tracker ${project.slug}`;
        try {
          const tracker = trackers(project);
          if (!tracker) continue;
          lastPoll.set(project.id, at);
          if (await issues.hasChanges(tracker, await binding(project))) onChanges();
          errors.clear(scope);
        } catch (error) {
          errors.report(scope, error);
        }
      }
    },
  };
}

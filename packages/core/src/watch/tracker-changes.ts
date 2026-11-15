import type { Issues } from "../tracker/issues";
import type { Tracker } from "../tracker/tracker";
import type { Projects } from "../projects/projects";
import type { ErrorReporter } from "./report";

/** Cada cuánto se le pregunta a cada tracker si cambió algo, sin esperar al tick de 5 min del Scheduler. */
export const TRACKER_EVERY_MS = 60_000;

export interface TrackerChangesDeps {
  projects: Pick<Projects, "list">;
  /** Los adapters que este core conoce, por id de tracker. */
  trackers: Readonly<Record<string, Tracker>>;
  issues: Pick<Issues, "hasChanges">;
  /** Hay issues nuevas o modificadas que traer: el Scheduler hace tick (`tick()` trae lo que cambió y lanza). */
  onChanges(): void;
  errors: ErrorReporter;
}

export interface TrackerChanges {
  /** Pregunta a los trackers de los proyectos activos que ya tocan; un tracker caído se anota y no frena a los demás. */
  poll(at: number): Promise<void>;
}

/** Los cambios de Linear (`Tracker.changesSince`) despiertan al Scheduler (`docs/design.html#d-ops`, "Scheduler: la cola"). */
export function createTrackerChanges({ projects, trackers, issues, onChanges, errors }: TrackerChangesDeps): TrackerChanges {
  const lastPoll = new Map<string, number>();
  return {
    async poll(at) {
      for (const project of projects.list()) {
        const tracker = trackers[project.tracker];
        if (project.status !== "active" || !tracker || at - (lastPoll.get(project.id) ?? Number.NEGATIVE_INFINITY) < TRACKER_EVERY_MS) continue;
        lastPoll.set(project.id, at);
        const scope = `tracker ${project.slug}`;
        try {
          if (await issues.hasChanges(tracker, { projectId: project.id, project: { tracker: project.tracker, id: project.trackerRef } })) onChanges();
          errors.clear(scope);
        } catch (error) {
          errors.report(scope, error);
        }
      }
    },
  };
}

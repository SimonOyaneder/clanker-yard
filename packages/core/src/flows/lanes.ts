import type { ProjectId } from "@clanker/api";
import { and, count, eq, inArray, isNull } from "drizzle-orm";
import { projects, runs } from "../store/schema";
import type { Store } from "../store/store";

// Los carriles de `docs/design.html#nunca-se-congela` (regla B): cada uno tiene su propia capacidad y
// uno nunca usa ni espera el cupo del otro.

/** Cuántas corridas pueden estar activas a la vez en cada carril de la máquina. */
export interface LaneCapacity {
  /** Tope global del carril dev; cada proyecto además tiene su `parallel`. */
  dev: number;
  maintenance: number;
}

type RunRow = typeof runs.$inferSelect;

/** Una corrida ocupa un cupo mientras corre o espera dentro de su carril: `parked` (conserva su worktree, no su cupo) y `queued` no. */
const ACTIVE = ["running", "waiting", "paused"] as const;

/** Las corridas raíz activas del carril, o solo las de un proyecto. Las hijas de un subflujo corren dentro del cupo de su raíz. */
export function activeRuns(db: Store["db"], lane: RunRow["lane"], projectId?: ProjectId): number {
  const row = db
    .select({ n: count() })
    .from(runs)
    .where(
      and(
        eq(runs.lane, lane),
        inArray(runs.status, ACTIVE),
        isNull(runs.parentRunId),
        projectId === undefined ? undefined : eq(runs.projectId, projectId),
      ),
    )
    .get();
  return row?.n ?? 0;
}

/**
 * Si el carril de `run` tiene un cupo libre: el tope de la máquina y, en dev, el `parallel` de su proyecto.
 * Una corrida sin proyecto (un bench, una a mano) solo mira el tope de la máquina.
 */
export function hasRoom(db: Store["db"], capacity: LaneCapacity, run: Pick<RunRow, "lane" | "projectId">): boolean {
  if (activeRuns(db, run.lane) >= capacity[run.lane]) return false;
  if (run.projectId === null) return true;
  const project = db.select({ parallel: projects.parallel, maintenancePaused: projects.maintenancePaused }).from(projects).where(eq(projects.id, run.projectId)).get();
  if (run.lane === "maintenance") return !project?.maintenancePaused;
  return project === undefined || activeRuns(db, "dev", run.projectId) < project.parallel;
}

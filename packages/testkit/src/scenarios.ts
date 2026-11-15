import type { ProjectId, RunId, StepRunId } from "@clanker/api";
import type { Store } from "@clanker/core";

// Ids fijos con ULID: el store rechaza un `run_1` aunque pase el tipo.
const projectId: ProjectId = "prj_00000000000000000000000001";
const runId: RunId = "run_00000000000000000000000001";
const stepRunId: StepRunId = "stp_00000000000000000000000001";

/**
 * Escenarios de base sembrada. Cada uno deja el Store como lo dejaría la app en ese momento;
 * se escriben con `store.tx`, así quedan con sus eventos igual que en producción.
 * Se amplían a medida que el schema gana tablas (runs, issues, PRs).
 */
export const scenarios = {
  /** Base recién migrada, sin datos. */
  empty: () => {},

  /** Un run con un paso en curso. */
  "loop-running": (store) => {
    store.tx((tx) => {
      tx.emit({ type: "run.started", origin: "core", projectId, runId });
      tx.emit({
        type: "step.started",
        origin: "core",
        projectId,
        runId,
        stepRunId,
        payload: { step: "implement" },
      });
    });
  },

  /** Un run estacionado esperando que se resuelva su bloqueo. */
  "issue-blocked": (store) => {
    store.tx((tx) => {
      tx.emit({ type: "run.started", origin: "core", projectId, runId });
      tx.emit({
        type: "run.parked",
        origin: "core",
        projectId,
        runId,
        subject: { type: "issue", id: "CLA-1" },
        payload: { reason: "depende de CLA-2" },
      });
    });
  },
} satisfies Record<string, (store: Store) => void>;

export type Scenario = keyof typeof scenarios;

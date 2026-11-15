import type { Store } from "@clanker/core";

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
      tx.emit({ type: "run.started", origin: "core", projectId: "prj_demo", runId: "run_1" });
      tx.emit({
        type: "step.started",
        origin: "core",
        projectId: "prj_demo",
        runId: "run_1",
        stepRunId: "stp_1",
        payload: { step: "implement" },
      });
    });
  },

  /** Un run estacionado esperando que se resuelva su bloqueo. */
  "issue-blocked": (store) => {
    store.tx((tx) => {
      tx.emit({ type: "run.started", origin: "core", projectId: "prj_demo", runId: "run_1" });
      tx.emit({
        type: "run.parked",
        origin: "core",
        projectId: "prj_demo",
        runId: "run_1",
        subject: { type: "issue", id: "CLA-1" },
        payload: { reason: "depende de CLA-2" },
      });
    });
  },
} satisfies Record<string, (store: Store) => void>;

export type Scenario = keyof typeof scenarios;

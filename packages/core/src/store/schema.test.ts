import { DecisionKind, DecisionStatus, Lane, LearningSource, LearningStatus, ParkReason, RunStatus, StepStatus } from "@clanker/api";
import { expect, test } from "vitest";
import { DECISION_KINDS, DECISION_STATUSES, LANES, LEARNING_SOURCES, LEARNING_STATUSES, PARK_REASONS, RUN_STATUSES, STEP_STATUSES } from "./schema";

// El schema no importa valores de la API (drizzle-kit lo carga solo): este test los mantiene iguales.
test("los estados de runs y step_runs son los mismos que expone la API", () => {
  expect(RunStatus.options).toEqual(RUN_STATUSES);
  expect(ParkReason.options).toEqual(PARK_REASONS);
  expect(Lane.options).toEqual(LANES);
  expect(StepStatus.options).toEqual(STEP_STATUSES);
});

test("los kinds y estados de decisions son los mismos que expone la API", () => {
  expect(DecisionKind.options).toEqual(DECISION_KINDS);
  expect(DecisionStatus.options).toEqual(DECISION_STATUSES);
});

test("los estados y orígenes de learnings son los mismos que expone la API", () => {
  expect(LearningStatus.options).toEqual(LEARNING_STATUSES);
  expect(LearningSource.options).toEqual(LEARNING_SOURCES);
});

import { Lane, ParkReason, RunStatus, StepStatus } from "@clanker/api";
import { expect, test } from "vitest";
import { LANES, PARK_REASONS, RUN_STATUSES, STEP_STATUSES } from "./schema";

// El schema no importa valores de la API (drizzle-kit lo carga solo): este test los mantiene iguales.
test("los estados de runs y step_runs son los mismos que expone la API", () => {
  expect(RunStatus.options).toEqual(RUN_STATUSES);
  expect(ParkReason.options).toEqual(PARK_REASONS);
  expect(Lane.options).toEqual(LANES);
  expect(StepStatus.options).toEqual(STEP_STATUSES);
});

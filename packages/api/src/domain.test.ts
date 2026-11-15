import { describe, expect, test } from "vitest";
import * as z from "zod";
import { Event, EventFilter, RunId, StepRunId, SubjectRef } from "./index";

const ULID = "01J0000000000000000000000A";

describe("ids con prefijo", () => {
  test("aceptan el prefijo y un ULID", () => {
    expect(RunId.parse(`run_${ULID}`)).toBe(`run_${ULID}`);
    expect(StepRunId.parse(`stp_${ULID}`)).toBe(`stp_${ULID}`);
  });

  test("rechazan otro prefijo o un sufijo que no es ULID", () => {
    expect(RunId.safeParse(`stp_${ULID}`).success).toBe(false);
    expect(RunId.safeParse("run_123").success).toBe(false);
    expect(RunId.safeParse(ULID).success).toBe(false);
  });

  test("se pueden volcar a JSON Schema para los archivos de .clanker", () => {
    expect(z.toJSONSchema(RunId)).toMatchObject({ type: "string", pattern: "^run_[0-9A-HJKMNP-TV-Z]{26}$" });
  });
});

test("SubjectRef solo acepta issue o pr", () => {
  expect(SubjectRef.parse({ type: "pr", id: "42" })).toEqual({ type: "pr", id: "42" });
  expect(SubjectRef.safeParse({ type: "run", id: "42" }).success).toBe(false);
});

describe("Event", () => {
  const event = { seq: 1, ts: 1_700_000_000_000, type: "run.started", origin: "core", payload: {} };

  test("acepta un evento mínimo y uno con ids", () => {
    expect(Event.parse(event)).toEqual(event);
    const full = { ...event, runId: `run_${ULID}`, subject: { type: "issue", id: "CLA-8" } };
    expect(Event.parse(full)).toEqual(full);
  });

  test("rechaza tipos fuera de la taxonomía y orígenes desconocidos", () => {
    expect(Event.safeParse({ ...event, type: "run.exploded" }).success).toBe(false);
    expect(Event.safeParse({ ...event, origin: "slack" }).success).toBe(false);
  });
});

test("EventFilter no admite una lista de tipos vacía", () => {
  expect(EventFilter.safeParse({ types: [] }).success).toBe(false);
  expect(EventFilter.parse({})).toEqual({});
});

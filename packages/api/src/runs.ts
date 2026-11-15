import * as z from "zod";
import { ArtifactHash, IssueId, ProjectId, RunId, StepRunId, SubjectRef } from "./domain";

export const RunStatus = z.enum([
  "queued",
  "running",
  "waiting",
  "parked",
  "paused",
  "done",
  "failed",
  "canceled",
]);
export type RunStatus = z.infer<typeof RunStatus>;

export const ParkReason = z.enum(["gate", "needs_human", "limit"]);
export type ParkReason = z.infer<typeof ParkReason>;

export const Lane = z.enum(["dev", "maintenance"]);
export type Lane = z.infer<typeof Lane>;

export const StepStatus = z.enum(["pending", "leased", "running", "waiting", "done", "failed", "canceled"]);
export type StepStatus = z.infer<typeof StepStatus>;

/** Un paso de una corrida, con el outcome que dio y lo que costó. */
export const Step = z.object({
  id: StepRunId,
  nodeId: z.string(),
  visit: z.int().positive(),
  round: z.int().nonnegative(),
  attempt: z.int().nonnegative(),
  status: StepStatus,
  outcome: z.string().nullable(),
  outputHash: ArtifactHash.nullable(),
  error: z.string().nullable(),
  /** ms epoch: con backoff pendiente, no se despacha antes. */
  notBefore: z.int().nonnegative().nullable(),
  costMicros: z.int().nonnegative(),
});
export type Step = z.infer<typeof Step>;

/** Una corrida de un flujo sobre un sujeto, sin sus pasos. */
export const Run = z.object({
  id: RunId,
  projectId: ProjectId.nullable(),
  flow: z.object({ slug: z.string(), version: z.int().positive() }),
  subject: SubjectRef,
  lane: Lane,
  status: RunStatus,
  parkReason: ParkReason.nullable(),
  /** `done`, `blocked` o `failed` cuando la corrida terminó. */
  outcome: z.string().nullable(),
  params: z.record(z.string(), z.unknown()),
  /** Contador de rondas → veces que se tomó. */
  rounds: z.record(z.string(), z.int().nonnegative()),
  costMicros: z.int().nonnegative(),
  /** ms epoch */
  startedAt: z.int().nonnegative(),
  endedAt: z.int().nonnegative().nullable(),
});
export type Run = z.infer<typeof Run>;

/** La corrida con sus pasos, en el orden en que se crearon. */
export const RunDetail = Run.extend({ steps: z.array(Step) });
export type RunDetail = z.infer<typeof RunDetail>;

export const RunFilter = z.object({
  projectId: ProjectId.optional(),
  /** Cualquiera de estos estados. */
  status: z.array(RunStatus).min(1).optional(),
});
export type RunFilter = z.infer<typeof RunFilter>;

export const StartRun = z.object({
  projectId: ProjectId,
  issueId: IssueId,
  /** Slug del flujo; sin él, el `defaultFlowId` del proyecto. */
  flow: z.string().min(1).optional(),
  /** Pisan a `flowParams` del proyecto, que a su vez pisa los defaults del flujo. */
  params: z.record(z.string(), z.unknown()).default({}),
});
export type StartRun = z.input<typeof StartRun>;

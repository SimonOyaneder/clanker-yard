import * as z from "zod";
import { DecisionId, ProjectId, RunId, StepRunId, SubjectRef } from "./domain";

export const DecisionKind = z.enum(["gate", "needs_human", "question", "review_note", "note", "alert"]);
export type DecisionKind = z.infer<typeof DecisionKind>;

export const DecisionStatus = z.enum(["pending", "accepted", "rejected", "answered", "expired", "superseded"]);
export type DecisionStatus = z.infer<typeof DecisionStatus>;

/**
 * Una entrada de la bandeja. Un `review_note` o un `note` no bloquea nada: el flujo siguió cuando se
 * abrió. Un `gate` o un `needs_human` estaciona solo la corrida de `runId` (`docs/design.html#d-flows`).
 */
/**
 * Cómo se cerró una decisión: la opción que se eligió (`null` si venció sin una por defecto), o por qué se cerró sola
 * (`reason`, por ejemplo `pr_merged`). Las que se reemplazan (`superseded`) no tienen.
 */
export const DecisionResolution = z.object({ option: z.string().nullable().optional(), reason: z.string().optional() });
export type DecisionResolution = z.infer<typeof DecisionResolution>;

export const Decision = z.object({
  id: DecisionId,
  projectId: ProjectId.nullable(),
  runId: RunId.nullable(),
  stepRunId: StepRunId.nullable(),
  subject: SubjectRef.nullable(),
  kind: DecisionKind,
  title: z.string(),
  body: z.string(),
  /** Lo que se puede elegir para resolverla; vacío si no hay nada que elegir. */
  options: z.array(z.string()),
  status: DecisionStatus,
  /** Lo que se eligió o respondió; `null` mientras está `pending`. */
  resolution: DecisionResolution.nullable(),
  resolvedBy: z.string().nullable(),
  /** ms epoch */
  createdAt: z.int().nonnegative(),
  /** ms epoch */
  resolvedAt: z.int().nonnegative().nullable(),
});
export type Decision = z.infer<typeof Decision>;

/** Los campos presentes se combinan con AND; cada lista acepta cualquiera de sus valores. */
export const DecisionFilter = z.object({
  projectId: ProjectId.optional(),
  runId: RunId.optional(),
  status: z.array(DecisionStatus).min(1).optional(),
  kind: z.array(DecisionKind).min(1).optional(),
});
export type DecisionFilter = z.infer<typeof DecisionFilter>;

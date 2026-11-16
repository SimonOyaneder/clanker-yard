import * as z from "zod";
import { LearningId, ProjectId, RepoId, RunId } from "./domain";

export const LearningStatus = z.enum(["proposed", "approved", "rejected", "archived"]);
export type LearningStatus = z.infer<typeof LearningStatus>;

/** Quién lo escribió: un agente en su reporte, una persona o la importación del clanker-loop. */
export const LearningSource = z.enum(["agent", "human", "import"]);
export type LearningSource = z.infer<typeof LearningSource>;

/**
 * Algo que un agente futuro necesita saber, en una línea. Solo los `approved` entran a los briefs
 * (`docs/design.html#d-data`). Aplica al proyecto o al repo que dice su alcance, y a los roles de
 * `roles` (vacío: a todos).
 */
export const Learning = z.object({
  id: LearningId,
  /** El alcance es el proyecto o el repo, uno de los dos. */
  projectId: ProjectId.nullable(),
  repoId: RepoId.nullable(),
  text: z.string(),
  /** Slugs de rol; vacío es todos los roles. */
  roles: z.array(z.string()),
  tags: z.array(z.string()),
  status: LearningStatus,
  source: LearningSource,
  /** La corrida cuyo reporte lo propuso; solo con `source: "agent"`. */
  sourceRunId: RunId.nullable(),
  /** ms epoch */
  createdAt: z.int().nonnegative(),
});
export type Learning = z.infer<typeof Learning>;

/** Los campos presentes se combinan con AND; `status` acepta cualquiera de sus valores. */
export const LearningFilter = z.object({
  projectId: ProjectId.optional(),
  repoId: RepoId.optional(),
  status: z.array(LearningStatus).min(1).optional(),
});
export type LearningFilter = z.infer<typeof LearningFilter>;

const LearningText = z.string().trim().min(1);
const Slugs = z.array(z.string().min(1));

/** Un learning nuevo: lo escribe una persona y queda `proposed` hasta que se apruebe. */
export const NewLearning = z
  .object({
    projectId: ProjectId.optional(),
    repoId: RepoId.optional(),
    text: LearningText,
    roles: Slugs.default([]),
    tags: Slugs.default([]),
  })
  .refine((l) => (l.projectId === undefined) !== (l.repoId === undefined), {
    message: "un learning aplica a un proyecto o a un repo: pasa uno de projectId o repoId",
  });
export type NewLearning = z.input<typeof NewLearning>;

/** Lo que `update` cambia; el alcance y el estado no se editan. */
export const LearningPatch = z.object({
  id: LearningId,
  text: LearningText.optional(),
  roles: Slugs.optional(),
  tags: Slugs.optional(),
});
export type LearningPatch = z.infer<typeof LearningPatch>;

/** Lo que el filtro con el criterio decide de un propuesto: `keep: false` es archivarlo, con la razón. */
export const LearningVerdict = z.object({ id: LearningId, keep: z.boolean(), reason: z.string() });
export type LearningVerdict = z.infer<typeof LearningVerdict>;

/** Lo que el modelo devuelve; el core lo completa con los que no juzgó. */
export const LearningVerdicts = z.object({ verdicts: z.array(LearningVerdict) });

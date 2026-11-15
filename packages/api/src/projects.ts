import * as z from "zod";
import { ProjectId } from "./domain";
import { TrackerId } from "./tracker";

export const ProjectStatus = z.enum(["active", "paused", "archived"]);
export type ProjectStatus = z.infer<typeof ProjectStatus>;

/**
 * Un proyecto de Clanker: una cola de issues de un tracker y el flujo con que se trabajan
 * (`docs/design.html#d-data`, tabla `projects`). No confundir con `Project` de `tracker.ts`, que es el
 * proyecto dentro del tracker.
 */
export const ClankerProject = z.object({
  id: ProjectId,
  /** Único, para nombrarlo en la CLI y en el MCP. */
  slug: z.string().min(1),
  name: z.string().min(1),
  tracker: TrackerId,
  /** Con `local` es el id del propio proyecto: así lo llama `issues.createLocal`. */
  trackerRef: z.string().min(1),
  /** Slug del flujo con que corre `runs.start` si no se pide otro. */
  defaultFlowId: z.string().min(1).nullable(),
  /** Slug del perfil con que corren los pasos agent. */
  defaultProfileId: z.string().min(1).nullable(),
  /** Cupo del carril dev. */
  parallel: z.int().positive(),
  status: ProjectStatus,
  /** Pisa los defaults de `params` del flujo (por ejemplo `reviewRounds`) sin crear una versión del flujo. */
  flowParams: z.record(z.string(), z.unknown()),
});
export type ClankerProject = z.infer<typeof ClankerProject>;

const slug = z
  .string()
  .regex(/^[a-z0-9][a-z0-9-]*$/, "usa minúsculas, números y guiones (por ejemplo `mi-proyecto`)");

/** Con tracker `local` el core pone `trackerRef` (es el id del proyecto); con otro tracker es obligatorio. */
export const NewProject = z
  .object({
    slug,
    name: z.string().min(1),
    tracker: TrackerId,
    trackerRef: z.string().min(1).optional(),
    defaultFlowId: z.string().min(1).optional(),
    defaultProfileId: z.string().min(1).optional(),
    parallel: z.int().positive().default(1),
    flowParams: z.record(z.string(), z.unknown()).default({}),
  })
  .superRefine((project, ctx) => {
    const isLocal = project.tracker === "local";
    if (isLocal && project.trackerRef !== undefined) {
      ctx.addIssue({
        code: "custom",
        path: ["trackerRef"],
        message: "un proyecto local no lleva trackerRef: es el id del proyecto",
      });
    }
    if (!isLocal && project.trackerRef === undefined) {
      ctx.addIssue({
        code: "custom",
        path: ["trackerRef"],
        message: `falta trackerRef: el proyecto de ${project.tracker} del que sale la cola`,
      });
    }
  });
export type NewProject = z.input<typeof NewProject>;

/** Lo que `projects.update` puede cambiar. `null` borra el flujo o el perfil por defecto. */
export const ProjectPatch = z.object({
  name: z.string().min(1).optional(),
  defaultFlowId: z.string().min(1).nullable().optional(),
  defaultProfileId: z.string().min(1).nullable().optional(),
  parallel: z.int().positive().optional(),
  status: ProjectStatus.optional(),
  flowParams: z.record(z.string(), z.unknown()).optional(),
});
export type ProjectPatch = z.infer<typeof ProjectPatch>;

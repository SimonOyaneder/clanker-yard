import * as z from "zod";
import { ProjectId, RepoId } from "./domain";
import { Conventions } from "./pack";
import { IssueFilter, StatusCategory, TrackerId } from "./tracker";

export const ProjectStatus = z.enum(["active", "paused", "archived"]);
export type ProjectStatus = z.infer<typeof ProjectStatus>;

/**
 * Un repo del proyecto. `runs.start` elige el repo de una issue por sus labels: el primero de la lista
 * que tenga alguno de los labels de la issue; si ninguno calza, el primero de la lista.
 */
export const ProjectRepo = z.object({
  repoId: RepoId,
  /** Los labels de issue que mandan al repo. Un label no puede estar en dos repos del mismo proyecto. */
  labels: z.array(z.string().min(1)).default([]),
});
export type ProjectRepo = z.infer<typeof ProjectRepo>;

/**
 * Cuándo el PR de una issue bloqueante deja que la siguiente se apile sobre él (`docs/design.html#d-ops`):
 * `ready` cuando su flujo terminó ok, `ci_green` cuando está abierto (draft o no) con el CI verde aunque
 * falte el LGTM, `any_open` apenas hay un PR abierto.
 */
export const StackOn = z.enum(["ready", "ci_green", "any_open"]);
export type StackOn = z.infer<typeof StackOn>;

/**
 * Los estados del tracker (`rawStatus`, por nombre) a los que el proyecto les cambia la categoría. Un estado que
 * no nombra sigue el mapeo por defecto del adapter. Hoy lo aplica el adapter de Linear.
 */
export const StatusMapping = z.record(z.string().min(1), StatusCategory);
export type StatusMapping = z.infer<typeof StatusMapping>;

const ProjectRepos = z.array(ProjectRepo);
const MaxCostUsd = z.number().positive().nullable();

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
  /** En orden: el primero es el repo por defecto. */
  repos: ProjectRepos,
  /** Qué issues entran a la cola. */
  queueFilter: IssueFilter,
  /** Reglas del proyecto para el brief y los PRs; pisan a las del pack. */
  conventions: Conventions,
  /** Cupo del carril dev. */
  parallel: z.int().positive(),
  /** Cuándo una issue se apila sobre el PR de su bloqueante. */
  stackOn: StackOn,
  /** Categorías que el proyecto ajusta a mano sobre las del adapter. */
  statusMapping: StatusMapping,
  status: ProjectStatus,
  /** Pisa los defaults de `params` del flujo (por ejemplo `reviewRounds`) sin crear una versión del flujo. */
  flowParams: z.record(z.string(), z.unknown()),
  /** Tope de gasto por corrida; `null` es sin tope. */
  maxCostUsd: MaxCostUsd,
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
    repos: ProjectRepos.default([]),
    queueFilter: IssueFilter.default({}),
    conventions: Conventions.default({}),
    parallel: z.int().positive().default(1),
    stackOn: StackOn.default("ci_green"),
    statusMapping: StatusMapping.default({}),
    flowParams: z.record(z.string(), z.unknown()).default({}),
    maxCostUsd: MaxCostUsd.default(null),
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
  /** Reemplaza la lista entera. */
  repos: ProjectRepos.optional(),
  queueFilter: IssueFilter.optional(),
  conventions: Conventions.optional(),
  parallel: z.int().positive().optional(),
  stackOn: StackOn.optional(),
  /** Reemplaza el mapeo entero; cambiarlo hace que la próxima sincronización relea todas las issues del proyecto. */
  statusMapping: StatusMapping.optional(),
  status: ProjectStatus.optional(),
  flowParams: z.record(z.string(), z.unknown()).optional(),
  maxCostUsd: MaxCostUsd.optional(),
});
export type ProjectPatch = z.infer<typeof ProjectPatch>;

import * as z from "zod";
import { DefChange, DefIssue } from "./defs";
import { ProjectId, RepoId } from "./domain";
import { Conventions } from "./pack";
import { RepoRemote } from "./repos";
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
 * Dónde se abren los PRs apilados del proyecto: `remote` los abre en GitHub apenas están listos; `local` solo abre el
 * de la base del stack y deja el resto en la máquina hasta que se mergea su base.
 */
export const StackMode = z.enum(["local", "remote"]);
export type StackMode = z.infer<typeof StackMode>;

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
  /**
   * La cuenta del tracker de la que sale la cola (en Linear, el `urlKey` del workspace, que es el nombre de la cuenta en
   * `connections`). `null` en `local` y en un proyecto que aún no la fijó: entonces se usa la única cuenta conectada.
   */
  trackerAccount: z.string().min(1).nullable(),
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
  /** Si los PRs apilados se abren en GitHub o quedan locales hasta que se mergea su base. */
  stackMode: StackMode,
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
    /** La cuenta (workspace) del tracker a la que pertenece `trackerRef`; sin ella se usa la única conectada. */
    trackerAccount: z.string().min(1).optional(),
    /** Sin valor rige el default de Ajustes. */
    defaultFlowId: z.string().min(1).optional(),
    defaultProfileId: z.string().min(1).optional(),
    repos: ProjectRepos.default([]),
    queueFilter: IssueFilter.default({}),
    conventions: Conventions.default({}),
    /** Sin valor rige el default de proyectos nuevos de Ajustes (`ProjectDefaults`). */
    parallel: z.int().positive().optional(),
    stackOn: StackOn.default("ci_green"),
    stackMode: StackMode.default("local"),
    statusMapping: StatusMapping.default({}),
    flowParams: z.record(z.string(), z.unknown()).default({}),
    /** Sin valor rige el default de Ajustes; `null` es sin tope. */
    maxCostUsd: MaxCostUsd.optional(),
  })
  .superRefine((project, ctx) => {
    const isLocal = project.tracker === "local";
    if (isLocal && project.trackerAccount !== undefined) {
      ctx.addIssue({ code: "custom", path: ["trackerAccount"], message: "un proyecto local no lleva trackerAccount" });
    }
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

function unknownFieldMessage(issue: z.core.$ZodRawIssue): string | undefined {
  if (issue.code !== "unrecognized_keys") return undefined;
  const keys = issue.keys.map((k) => `"${k}"`).join(", ");
  return `projects.update no tiene ${issue.keys.length === 1 ? "el campo" : "los campos"} ${keys}: los campos a cambiar van planos junto a id, sin objeto patch. Acepta: ${Object.keys(patchShape).join(", ")}.`;
}

const patchShape = {
  name: z.string().min(1).optional(),
  /** Solo en un proyecto de un tracker externo y mientras no tenga issues en el caché; el core lo normaliza como en `create`. */
  trackerRef: z.string().min(1).optional(),
  /** La cuenta (workspace) del tracker; va junto con `trackerRef` al cambiar de proyecto, con las mismas condiciones. */
  trackerAccount: z.string().min(1).optional(),
  defaultFlowId: z.string().min(1).nullable().optional(),
  defaultProfileId: z.string().min(1).nullable().optional(),
  /** Reemplaza la lista entera. */
  repos: ProjectRepos.optional(),
  queueFilter: IssueFilter.optional(),
  conventions: Conventions.optional(),
  parallel: z.int().positive().optional(),
  stackOn: StackOn.optional(),
  stackMode: StackMode.optional(),
  /** Reemplaza el mapeo entero; cambiarlo hace que la próxima sincronización relea todas las issues del proyecto. */
  statusMapping: StatusMapping.optional(),
  status: ProjectStatus.optional(),
  flowParams: z.record(z.string(), z.unknown()).optional(),
  maxCostUsd: MaxCostUsd.optional(),
};

/**
 * Lo que `projects.update` puede cambiar, plano junto al `id` (no dentro de un `patch`). `null` borra el
 * flujo o el perfil por defecto. Un campo que no existe es un error: ignorarlo dejaba un update que no hace nada.
 */
export const ProjectPatch = z.strictObject(patchShape, { error: unknownFieldMessage });
export type ProjectPatch = z.infer<typeof ProjectPatch>;

/** La entrada de `projects.update`: el `id` y los campos de `ProjectPatch`. */
export const ProjectUpdate = z.strictObject({ ...patchShape, id: ProjectId }, { error: unknownFieldMessage });

/**
 * Lo que un proyecto nuevo toma cuando quien lo crea no dice otra cosa (Ajustes de la app). Cambiarlo no toca los
 * proyectos que ya existen.
 */
export const ProjectDefaults = z.object({
  defaultFlowId: z.string().min(1).nullable(),
  defaultProfileId: z.string().min(1).nullable(),
  parallel: z.int().positive(),
  maxCostUsd: MaxCostUsd,
});
export type ProjectDefaults = z.infer<typeof ProjectDefaults>;

/** Los campos de `ProjectDefaults` a cambiar; lo que no se pasa no cambia. */
export const ProjectDefaultsPatch = ProjectDefaults.partial();
export type ProjectDefaultsPatch = z.infer<typeof ProjectDefaultsPatch>;

/**
 * La configuración de un proyecto como archivo para llevarla a otra máquina o proyecto (`projects.exportConfig`,
 * `projects.importConfig`). Los repos van por nombre y remoto de GitHub, no por id: el id es de esta máquina. El
 * nombre, el tracker, su proyecto y su cuenta son informativos: importar no los cambia.
 */
export const ProjectConfig = z.strictObject({
  /** La versión del formato. */
  clankerProjectConfig: z.literal(1),
  name: z.string().min(1),
  tracker: TrackerId,
  trackerRef: z.string().min(1),
  /** La cuenta (workspace) del tracker de la que sale la cola; informativa como `trackerRef`. */
  trackerAccount: z.string().min(1).nullable().default(null),
  defaultFlowId: z.string().min(1).nullable().default(null),
  defaultProfileId: z.string().min(1).nullable().default(null),
  repos: z
    .array(z.strictObject({ name: z.string().min(1), remote: RepoRemote.nullable(), labels: z.array(z.string().min(1)).default([]) }))
    .default([]),
  queueFilter: IssueFilter.default({}),
  conventions: Conventions.default({}),
  parallel: z.int().positive().default(1),
  stackOn: StackOn.default("ci_green"),
  /** Sin valor, importar no lo cambia. */
  stackMode: StackMode.optional(),
  statusMapping: StatusMapping.default({}),
  flowParams: z.record(z.string(), z.unknown()).default({}),
  maxCostUsd: MaxCostUsd.default(null),
});
export type ProjectConfig = z.infer<typeof ProjectConfig>;

/**
 * Lo que devuelve `projects.importConfig`. `errors` impide importar (el archivo no es una configuración válida o
 * choca: nada se escribe); `unmapped` es lo que no se pudo llevar a esta máquina (un repo no registrado, un flujo o
 * perfil que no existe) y se omite sin impedir el resto; `changes` es lo que cambia en el proyecto. `applied` es
 * verdadero solo si se escribió.
 */
export const ProjectImportResult = z.object({
  applied: z.boolean(),
  errors: z.array(DefIssue),
  unmapped: z.array(DefIssue),
  changes: z.array(DefChange),
});
export type ProjectImportResult = z.infer<typeof ProjectImportResult>;

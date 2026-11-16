import * as z from "zod";
import { DefKind, RepoId } from "./domain";

export const DefScope = z.enum(["builtin", "pack", "repo", "user"]);
export type DefScope = z.infer<typeof DefScope>;

/** Una def (flujo, rol, perfil, receta, pack) con el contenido de una de sus versiones. */
export const DefRecord = z.object({
  id: z.string(),
  kind: DefKind,
  slug: z.string(),
  scope: DefScope,
  repoId: RepoId.nullable(),
  /** ms epoch; `null` si está vigente. */
  archivedAt: z.int().nonnegative().nullable(),
  currentVersion: z.int().positive(),
  /** La versión de `body`: la vigente salvo que se haya pedido otra. */
  version: z.int().positive(),
  /** Lo valida el esquema de su kind (`MCP_KIND_SCHEMAS`). */
  body: z.unknown(),
  source: z.string(),
  /** ms epoch de la versión. */
  createdAt: z.int().nonnegative(),
});
export type DefRecord = z.infer<typeof DefRecord>;

export const DefFilter = z.object({
  kind: DefKind,
  includeArchived: z.boolean().default(false),
});
export type DefFilter = z.infer<typeof DefFilter>;

export const DefRef = z.object({
  kind: DefKind,
  id: z.string().min(1),
  /** Sin ella, la versión vigente. */
  version: z.int().positive().optional(),
});
export type DefRef = z.infer<typeof DefRef>;

/** Los kinds que `create`, `update` y `archive` escriben: lo que una persona o un agente autora (los demás los siembra o sincroniza el core). */
export const DEF_WRITE_KINDS = ["flow", "role", "profile"] as const;
export const DefWriteKind = z.enum(DEF_WRITE_KINDS);
export type DefWriteKind = z.infer<typeof DefWriteKind>;

const BODY_DOC = "El contenido del kind; su esquema está en el resource clanker://schema/<kind>.";
const DRY_RUN_DOC = "Valida y devuelve los errores o el diff sin guardar nada.";

export const DefCreate = z.object({
  kind: DefWriteKind,
  /** Para un `flow` es el `id` del body (y si se da, debe coincidir). */
  slug: z.string().min(1).optional(),
  /** `user` pisa a la def `builtin` o de un pack con el mismo slug; `repo` solo vale en ese repo. */
  scope: z.enum(["user", "repo"]).default("user"),
  /** Obligatorio con scope `repo`, y solo ahí. */
  repoId: RepoId.optional(),
  body: z.unknown().describe(BODY_DOC),
  dryRun: z.boolean().default(false).describe(DRY_RUN_DOC),
});
export type DefCreate = z.infer<typeof DefCreate>;

export const DefUpdate = z.object({
  kind: DefWriteKind,
  /** El id `def_...` o el slug (la def que gana para ese slug; una de scope `repo` solo por su id). */
  id: z.string().min(1),
  /** Reemplaza el body entero y crea una versión nueva; las corridas en curso siguen con la suya. */
  body: z.unknown().describe(BODY_DOC),
  dryRun: z.boolean().default(false).describe(DRY_RUN_DOC),
});
export type DefUpdate = z.infer<typeof DefUpdate>;

export const DefArchive = z.object({ kind: DefWriteKind, id: z.string().min(1) });
export type DefArchive = z.infer<typeof DefArchive>;

/** Un problema del body; `path` es la ruta dentro de él (`nodes.sync.on.conflict`), vacía si es de la def entera. */
export const DefIssue = z.object({ path: z.string(), message: z.string() });
export type DefIssue = z.infer<typeof DefIssue>;

/** Un cambio de una hoja del body; `before` falta en lo que se agrega y `after` en lo que se quita. */
export const DefChange = z.object({ path: z.string(), before: z.unknown().optional(), after: z.unknown().optional() });
export type DefChange = z.infer<typeof DefChange>;

/**
 * Lo que devuelven `create` y `update`. Con `dryRun` no se guarda nada: `errors` dice por qué no se
 * podría guardar (y `diff` va vacío), y `def` es `null`. Sin `dryRun` los errores son un `BAD_REQUEST`, así
 * que `errors` va vacío y `def` es la def como quedó. `changed` es falso si el body es el mismo y no hay versión nueva.
 */
export const DefWrite = z.object({
  dryRun: z.boolean(),
  errors: z.array(DefIssue),
  /** No impiden guardar (los de `flows.validate`). */
  warnings: z.array(DefIssue),
  changed: z.boolean(),
  diff: z.array(DefChange),
  def: DefRecord.nullable(),
});
export type DefWrite = z.infer<typeof DefWrite>;

/** `defs.exportToRepo`: una def propia (scope `user`) y el repo registrado a cuyo `.clanker/` va. */
export const DefExportToRepo = z.object({ kind: DefWriteKind, id: z.string().min(1), repoId: RepoId });
export type DefExportToRepo = z.infer<typeof DefExportToRepo>;

/** El PR en draft que abrió `defs.exportToRepo`: `path` es el archivo que agrega o cambia, dentro del repo. */
export const DefExported = z.object({ url: z.string(), number: z.int().positive(), branch: z.string(), path: z.string() });
export type DefExported = z.infer<typeof DefExported>;

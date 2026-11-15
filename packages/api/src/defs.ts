import * as z from "zod";
import { DefKind } from "./domain";

export const DefScope = z.enum(["builtin", "pack", "repo", "user"]);
export type DefScope = z.infer<typeof DefScope>;

/** Una def (flujo, rol, perfil, receta, pack) con el contenido de una de sus versiones. */
export const DefRecord = z.object({
  id: z.string(),
  kind: DefKind,
  slug: z.string(),
  scope: DefScope,
  repoId: z.string().nullable(),
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

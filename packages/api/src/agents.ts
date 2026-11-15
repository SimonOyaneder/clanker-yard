import * as z from "zod";
import { RunId, SubjectRef } from "./domain";

/** Un JSON Schema como dato: así viaja un rol guardado en defs y así se le pasa al runtime. */
export const JsonSchema = z.record(z.string(), z.unknown());
export type JsonSchema = z.infer<typeof JsonSchema>;

/** El validador zod de un JSON Schema guardado como dato. Lanza si el esquema no se puede leer. */
export function compileJsonSchema(schema: JsonSchema): z.ZodType {
  return z.fromJSONSchema(schema as Parameters<typeof z.fromJSONSchema>[0]);
}

/** Un esquema que el core no sabe compilar no se puede validar: se rechaza al guardar el rol. */
const ValidatableJsonSchema = JsonSchema.superRefine((schema, ctx) => {
  try {
    compileJsonSchema(schema);
  } catch (error) {
    ctx.addIssue({
      code: "custom",
      message: `no es un JSON Schema que el core pueda validar: ${error instanceof Error ? error.message : String(error)}`,
    });
  }
});

export const Effort = z.enum(["low", "medium", "high", "xhigh", "max"]);
export type Effort = z.infer<typeof Effort>;

/** Tope opcional: sin él no hay límite de turnos ni de gasto. */
export const Budget = z.object({
  maxTurns: z.int().positive().optional(),
  maxUsd: z.number().positive().optional(),
});
export type Budget = z.infer<typeof Budget>;

/** `"all"` es libertad total (el default); `allow` y `deny` acotan, por ejemplo para un rol de solo lectura. */
export const ToolPolicy = z.union([
  z.literal("all"),
  z.object({ allow: z.array(z.string()).optional(), deny: z.array(z.string()).optional() }),
]);
export type ToolPolicy = z.infer<typeof ToolPolicy>;

/** De dónde saca contexto un rol. Los `pack` y los `file` son referencias, nunca copias. */
export const ContextSource = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("native"),
    sources: z.array(z.enum(["user", "project"])),
    skills: z.union([z.array(z.string()), z.literal("all")]),
  }),
  z.object({ kind: z.literal("pack"), id: z.string().min(1) }),
  z.object({ kind: z.literal("repo"), files: z.array(z.string().min(1)).min(1) }),
  z.object({ kind: z.literal("file"), path: z.string().min(1) }),
]);
export type ContextSource = z.infer<typeof ContextSource>;

export const SessionPolicy = z.enum(["new", "resume-if-warm", "resume"]);
export type SessionPolicy = z.infer<typeof SessionPolicy>;

export const RoleMode = z.object({
  /** Va en el mensaje del usuario, no en el prompt de sistema. */
  instructions: z.string().min(1),
  /** Lo propio del brief de este modo. Sin esquema, el payload no se valida. */
  payload: ValidatableJsonSchema.optional(),
  /** Lo propio del reporte de este modo: el core lo valida. */
  report: ValidatableJsonSchema,
  /** Lo que el modo puede devolver en `Report.outcome`. */
  outcomes: z.array(z.string().min(1)).min(1),
  session: SessionPolicy,
  budget: Budget.optional(),
});
export type RoleMode = z.infer<typeof RoleMode>;

/**
 * Body de una def de kind `role`. El id y la versión son los de la def (slug y versión), no
 * viven en el body.
 */
export const Role = z.object({
  /** Estático e igual en todos los modos: es el prefijo cacheable. */
  prompt: z.string().min(1),
  context: z.array(ContextSource),
  tools: ToolPolicy.optional(),
  /** Los hooks del usuario; apagados salvo que el rol los pida. */
  hooks: z.boolean().optional(),
  modes: z.record(z.string().min(1), RoleMode).refine((m) => Object.keys(m).length > 0, {
    message: "un rol necesita al menos un modo",
  }),
});
export type Role = z.infer<typeof Role>;

/** Lo que el perfil decide de un rol: modelo, effort y topes. */
export const ProfileRole = z.object({
  model: z.string().min(1),
  effort: Effort.optional(),
  cacheTtl: z.enum(["5m", "1h"]).optional(),
  budget: Budget.optional(),
});
export type ProfileRole = z.infer<typeof ProfileRole>;

/** Body de una def de kind `profile`: la clave es el slug del rol. */
export const Profile = z.object({
  roles: z.record(z.string().min(1), ProfileRole),
});
export type Profile = z.infer<typeof Profile>;

/** El sobre que el core arma para cualquier rol. */
export const Brief = z.object({
  run: z.object({
    id: RunId,
    subject: SubjectRef,
    round: z.int().nonnegative(),
    attempt: z.int().nonnegative(),
  }),
  issue: z
    .object({ key: z.string().min(1), title: z.string(), criteria: z.array(z.string()) })
    .optional(),
  worktree: z.string().min(1),
  base: z.string().min(1),
  mode: z.string().min(1),
  /** Rutas en `.clanker-run/`. */
  artifacts: z.record(z.string(), z.string()),
  /** Aprobados, ≤10 líneas. */
  learnings: z.array(z.string()).optional(),
  /** Lo valida `modes[mode].payload`. */
  payload: z.unknown(),
});
export type Brief = z.infer<typeof Brief>;

/** El sobre que devuelve cualquier agente. */
export const Report = z.object({
  /** Uno de `modes[mode].outcomes`. */
  outcome: z.string().min(1),
  summary: z.string(),
  /** Van a la bandeja como notas que no bloquean. */
  decisions: z.array(z.object({ title: z.string(), body: z.string() })).optional(),
  /** Propuestas: las aprueba una persona. */
  learnings: z.array(z.string()).optional(),
  /** Lo valida `modes[mode].report`. */
  payload: z.unknown(),
});
export type Report = z.infer<typeof Report>;

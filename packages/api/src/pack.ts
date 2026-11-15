import * as z from "zod";
import { ContextRef } from "./agents";
import { ProjectId } from "./domain";

// El formato de un pack de convenciones: `docs/design.html#packs` y `#d-ops` ("Packs: esquema y pack
// Acme"). Es declarativo: el core no tiene un solo `if` por organización, solo lee estas claves.
// Sin pack, cada clave toma el valor neutro de `PackSettings` (todo vacío o ausente).

const IDENTIFIER = /^[A-Za-z][\w-]*$/;

/** Un patrón que el core compila con `new RegExp`: uno roto se rechaza al cargar el pack, no al usarlo. */
const Pattern = z.string().min(1).superRefine((source, ctx) => {
  try {
    new RegExp(source);
  } catch (error) {
    ctx.addIssue({
      code: "custom",
      message: `no es una expresión regular válida: ${error instanceof Error ? error.message : String(error)}`,
    });
  }
});

/** Quién cuenta como humano: lo que `ignore` captura es un bot o una cuenta del sistema. */
const Actors = z.strictObject({
  ignore: Pattern.optional(),
  /** Cuerpo de review que no cuenta como comentario (un "LGTM" solo). Se evalúa sin distinguir mayúsculas. */
  silentReviewBody: Pattern.optional(),
});

const Tone = z.enum(["ok", "warn", "bad"]);

/** Un dato de un PR que el pack saca de sus labels y la UI muestra como chip, por ejemplo el riesgo del bot de review. */
const Signal = z
  .strictObject({
    id: z.string().regex(IDENTIFIER),
    source: z.literal("label"),
    match: z.string().min(1),
    /** Flags de la regex `match`, por ejemplo `i`. */
    flags: z.string().optional(),
    /** Valores del grupo capturado que significan otro nivel (`medium` es `mid`). */
    alias: z.record(z.string(), z.string()).optional(),
    /** Qué dice la UI cuando el PR no tiene la señal. */
    empty: z.string().optional(),
    levels: z
      .record(
        z.string().min(1),
        z.strictObject({ label: z.string().min(1), tone: Tone, hint: z.string().min(1) }),
      )
      .refine((levels) => Object.keys(levels).length > 0, { message: "una señal necesita al menos un nivel" }),
  })
  .superRefine((signal, ctx) => {
    try {
      new RegExp(signal.match, signal.flags);
    } catch (error) {
      ctx.addIssue({
        code: "custom",
        path: ["match"],
        message: `no es una expresión regular válida con las flags "${signal.flags ?? ""}": ${error instanceof Error ? error.message : String(error)}`,
      });
    }
  });
export type Signal = z.infer<typeof Signal>;

/** El bot de review del repo (en Acme, `review-bot`). */
const ReviewBot = z.strictObject({
  logins: z.array(z.string().min(1)).min(1),
  /** Cómo se le pide una review. */
  request: z.strictObject({ type: z.literal("comment"), body: z.string().min(1) }),
  /** Cuándo una review del bot es un LGTM. */
  lgtm: z.strictObject({
    reviewState: z.enum(["APPROVED", "COMMENTED", "CHANGES_REQUESTED"]),
    bodyMatch: Pattern.optional(),
    /** El LGTM solo vale si es sobre el head actual del PR. */
    sameSha: z.boolean().optional(),
  }),
  timeoutSec: z.number().positive().optional(),
  /** Autores cuyos threads el core puede resolver después de responderlos. */
  resolvableAuthors: z.array(z.string().min(1)).optional(),
});

const CheckState = z.enum(["SUCCESS", "SKIPPED", "NEUTRAL", "FAILURE", "ERROR", "PENDING"]);

/** Qué checks cuentan para "CI verde". Sin esto: los checks requeridos de la branch protection. */
const CiRules = z.strictObject({
  ignoreChecks: z.array(z.string().min(1)).optional(),
  okStates: z.array(CheckState).optional(),
  /** Checks que fallan sin culpa del cambio: el estado del PR los marca antes de que un agente los triagee. */
  knownFlaky: z.array(z.string().min(1)).optional(),
});

/** Condiciones que sabe evaluar el core. `offer` y `auto` pueden apoyarse en la lista anterior (`ready`, `offer`). */
const MergeCondition = z.enum([
  "ready",
  "offer",
  "notDraft",
  "approved",
  "ciGreen",
  "baseIsDefault",
  "noConflict",
  "noHumanOpenThreads",
  "noHumanResolvedThreads",
  "notQueued",
  "humanApprover",
  "noHumanTalk",
  "noCouncilOpen",
  "noCouncilEver",
  "notHold",
]);
const MergeReaction = z.enum(["gate", "act", "none"]);

/**
 * Cómo se mergea. Sin estrategia: el botón de GitHub, con una decisión que estaciona solo ese PR.
 * Con `comment` se mergea comentando `command` (en Acme, `/merge`).
 */
const MergeStrategy = z.strictObject({
  type: z.literal("comment"),
  command: z.string().min(1),
  /** El check que marca el PR como en cola (merge-queue). */
  queueCheck: z.string().min(1).optional(),
  /** La estrategia solo aplica en repos donde este check aparece en los commits de la branch por defecto. */
  appliesWhen: z.strictObject({ checkSeenOnDefault: z.string().min(1) }).optional(),
  ready: z.array(MergeCondition),
  offer: z.array(MergeCondition),
  auto: z.array(MergeCondition),
  /** Qué hace el core cuando se cumple `offer`: `gate` abre una decisión, `act` mergea, `none` nada. */
  onOffer: MergeReaction,
  onAuto: MergeReaction,
});

/** Las convenciones de un pack; un proyecto puede fijar las suyas (`ClankerProject.conventions`). */
export const Conventions = z.strictObject({
  commentPrefix: z.string().optional(),
  councilPrefix: z.string().optional(),
  commits: z.enum(["conventional"]).optional(),
  noAiAttribution: z.boolean().optional(),
  pr: z
    .strictObject({
      /** Ruta relativa al pack. */
      template: z.string().min(1).optional(),
      omitSections: z.array(z.string().min(1)).optional(),
    })
    .optional(),
  /** Contexto extra por rol (`*` es todos): `skill:commit`, `rule:git-safety`, `repo:AGENTS.md`. */
  context: z.record(z.string().min(1), z.array(ContextRef)).optional(),
});

/**
 * Lo que un pack decide. Con `PackSettings.parse({})` sale la configuración neutra de un repo sin pack:
 * sin señales, sin bot, sin reglas de CI propias y sin estrategia de merge.
 */
export const PackSettings = z.strictObject({
  actors: Actors.default({}),
  signals: z.array(Signal).default([]),
  reviewBot: ReviewBot.optional(),
  ciRules: CiRules.optional(),
  mergeStrategy: MergeStrategy.optional(),
  conventions: Conventions.default({}),
});
export type Conventions = z.infer<typeof Conventions>;
export type PackSettings = z.infer<typeof PackSettings>;

/** Una ruta `.json` dentro de la carpeta del pack: nunca absoluta y nunca fuera de ella. */
const PackFile = z
  .string()
  .refine((path) => path.endsWith(".json"), { message: "debe ser un archivo .json" })
  .refine((path) => !path.startsWith("/") && !path.split(/[\\/]/).includes(".."), {
    message: "debe ser una ruta relativa dentro de la carpeta del pack",
  });

/** Dónde se activa el pack. Un repo o proyecto fuera de este alcance recibe los defaults neutros. */
const Activate = z
  .strictObject({
    githubOrgs: z.array(z.string().min(1)).optional(),
    trackerWorkspaces: z.array(z.string().min(1)).optional(),
    projects: z.array(ProjectId).optional(),
  })
  .refine((a) => [a.githubOrgs, a.trackerWorkspaces, a.projects].some((list) => list && list.length > 0), {
    message: "un pack sin alcance nunca se activaría: lista al menos una org de GitHub, un workspace del tracker o un proyecto",
  });

/** El `pack.json`: el contenido del pack es JSON y los flujos y roles son archivos `.json` junto a él. */
export const Pack = PackSettings.extend({
  id: z.string().regex(/^[a-z][a-z0-9-]*$/, "debe ser minúsculas, números y guiones, empezando por una letra"),
  /** Versión del pack: se sube a propósito cuando cambia algo. */
  version: z.int().positive(),
  activate: Activate,
  /** Flujos (`FlowDef`) que el pack trae; entran como defs con scope `pack`. */
  flows: z.array(PackFile).default([]),
  /** Roles (`Role`) que el pack trae; el slug es el nombre del archivo sin `.json`. */
  roles: z.array(PackFile).default([]),
});
export type Pack = z.infer<typeof Pack>;

/** El JSON Schema del `pack.json` tal como se escribe (los defaults son opcionales). */
export const packJsonSchema = z.toJSONSchema(Pack, { io: "input" });

/** A quién se le pregunta por su pack: lo que se sabe de un repo o de un proyecto. */
export const PackScope = z.object({
  githubOrg: z.string().min(1).optional(),
  trackerWorkspace: z.string().min(1).optional(),
  projectId: ProjectId.optional(),
});
export type PackScope = z.infer<typeof PackScope>;

/** Lo que `packFor` entrega: la configuración y el pack del que sale (`null` si son los defaults neutros). */
export type ResolvedPack = PackSettings & { id: string | null };

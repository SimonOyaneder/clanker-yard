import * as z from "zod";
import { RepoId } from "./domain";

/** `owner/name` del remoto en GitHub. */
export const RepoRemote = z.string().regex(/^[^/\s]+\/[^/\s]+$/, "debe ser `owner/name`");
export type RepoRemote = z.infer<typeof RepoRemote>;

/** Un checkout de git registrado (`docs/design.html#d-data`, tabla `repos`). */
export const Repo = z.object({
  id: RepoId,
  name: z.string().min(1),
  /** Raíz del checkout, ya resuelta (sin symlinks): es única. */
  path: z.string().min(1),
  /** `null` si `origin` no apunta a GitHub. */
  remote: RepoRemote.nullable(),
  defaultBranch: z.string().min(1),
  /**
   * Pisa `appliesWhen` de la estrategia de merge del pack (decisión #33 del diseño): `on` la aplica aunque no
   * se vea merge-queue en la branch por defecto, `off` no la aplica nunca; `null` lo detecta.
   */
  mergeStrategy: z.enum(["on", "off"]).nullable(),
});
export type Repo = z.infer<typeof Repo>;

/** El nombre es la carpeta si no se da. */
export const NewRepo = z.object({
  path: z.string().min(1),
  name: z.string().min(1).optional(),
});
export type NewRepo = z.infer<typeof NewRepo>;

/** Qué hay de `.clanker/recipe.json` en un repo. */
export const RecipeStatus = z.discriminatedUnion("status", [
  z.object({ status: z.literal("found") }),
  z.object({ status: z.literal("missing") }),
  /** `message` dice qué campo falla y por qué. */
  z.object({ status: z.literal("invalid"), message: z.string() }),
]);
export type RecipeStatus = z.infer<typeof RecipeStatus>;

/** Un repo de git encontrado en una carpeta, registrado o no. */
export const DetectedRepo = z.object({
  path: z.string().min(1),
  name: z.string().min(1),
  remote: RepoRemote.nullable(),
  defaultBranch: z.string().min(1),
  /** El id si ya está registrado. */
  repoId: RepoId.nullable(),
  recipe: RecipeStatus,
});
export type DetectedRepo = z.infer<typeof DetectedRepo>;

export const RecipeTestPhase = z.enum(["requires", "guard", "setup.worktree", "setup.slot"]);
export type RecipeTestPhase = z.infer<typeof RecipeTestPhase>;

/** Un comando de la prueba de la receta. `extract` son las últimas líneas de su salida. */
export const RecipeTestStep = z.object({
  phase: RecipeTestPhase,
  /** El nombre del `requires`, o el comando ya con sus variables. */
  name: z.string(),
  ok: z.boolean(),
  exitCode: z.int(),
  extract: z.string(),
});
export type RecipeTestStep = z.infer<typeof RecipeTestStep>;

/** Se corta en el primer paso rojo, salvo `requires`, donde se prueban todos. */
export const RecipeTestResult = z.object({
  ok: z.boolean(),
  steps: z.array(RecipeTestStep),
});
export type RecipeTestResult = z.infer<typeof RecipeTestResult>;

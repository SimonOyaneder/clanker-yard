import * as z from "zod";
import { CachedIssue } from "./tracker";

/** Un PR de la cola como lo nombra el diseño: `repo#número`, por ejemplo `api#4251`, con su branch. */
export const QueuePr = z.object({
  key: z.string().min(1),
  branch: z.string().min(1),
});
export type QueuePr = z.infer<typeof QueuePr>;

/** Sobre qué base sale la branch de la issue cuando la corrida arranque. */
export const QueueBase = z.discriminatedUnion("kind", [
  /** La branch por defecto de su repo. */
  z.object({ kind: z.literal("default") }),
  /** La branch de un PR abierto del sistema, del mismo repo. */
  z.object({ kind: z.literal("stacked"), parent: QueuePr }),
  /** Dos o más PRs en ramas distintas: una base sintética que los junta (`workspace.combineBase`). */
  z.object({ kind: z.literal("combined"), parents: z.array(QueuePr).min(2) }),
]);
export type QueueBase = z.infer<typeof QueueBase>;

const common = { issue: CachedIssue, reason: z.string().min(1) };

/**
 * Una issue de la cola de un proyecto con su clasificación (`docs/design.html#d-ops`). `ready` se puede
 * lanzar ya sobre `base`; `waiting` se reevalúa sola en el próximo tick (un bloqueante en vuelo);
 * `blocked` necesita que alguien haga algo. `reason` lo dice con las claves de las issues y los PRs.
 */
export const QueueEntry = z.discriminatedUnion("state", [
  z.object({
    ...common,
    state: z.literal("ready"),
    base: QueueBase,
    /** PRs de otros repos de los que depende: van como "depende de repo#n" en el body del PR, nunca como base. */
    dependsOn: z.array(z.string()),
  }),
  z.object({ ...common, state: z.literal("waiting") }),
  z.object({ ...common, state: z.literal("blocked") }),
]);
export type QueueEntry = z.infer<typeof QueueEntry>;

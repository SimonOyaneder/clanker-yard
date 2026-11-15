import type { FlowDef, RunId } from "@clanker/api";
import type { infer as Infer, ZodType } from "zod";

// Lo que otros módulos (Workspaces, CodeHost, Tracker, packs, Agents) registran en Flows: la
// validación lee los nombres y outcomes, el motor ejecuta. `WaitDef` agrega `key`, `match` y
// `probe` cuando exista el nodo wait.

/** Cuántas veces se re-ejecuta tras una excepción y cuánto se espera: `backoffSec[n-1]` antes del reintento n, el último se repite. */
export interface RetryPolicy {
  max: number;
  backoffSec: number[];
}

export interface ActionCtx {
  runId: RunId;
  /** El paso (`step_runs.id`): el mismo en todos los reintentos. Nombra sus logs y es el dueño de sus artefactos. */
  stepId: string;
  /** `run:nodo:visita`. Los reintentos de una visita la comparten; una ronda nueva trae otra. */
  key: string;
  /** Se aborta al vencer `timeoutSec`. */
  signal: AbortSignal;
  /**
   * Corre `fn` una vez por (`key`, `stage`): si la acción se re-ejecuta, la etapa ya hecha devuelve
   * su resultado guardado sin volver a correr. `fn` debe devolver JSON. Si el proceso muere entre
   * `fn` y el guardado, `fn` vuelve a correr, así que sus efectos externos deben ser idempotentes.
   */
  once<T>(stage: string, fn: () => Promise<T>): Promise<T>;
}

export interface ActionResult {
  /** Uno de `ActionDef.outcomes`. Un outcome de negocio (tests rojos) es un resultado, no una excepción. */
  outcome: string;
  /** Lo que los demás nodos leen como `$nodo`. */
  output?: unknown;
}

export interface ActionDef<A extends ZodType = ZodType> {
  name: string;
  args: A;
  /** Si se da, el motor valida el output antes de guardarlo. */
  output?: ZodType;
  outcomes: string[];
  /** `remote`: publica (push, PR, comentarios, tracker). `effects: "local"` en un flujo la rechaza. */
  effects: "local" | "remote";
  /** Sin esto, la acción corre sin límite de tiempo. El nodo puede pisarlo. */
  timeoutSec?: number;
  /** Por defecto 3 reintentos con 10 s, 60 s y 5 min. El nodo puede pisarlo. */
  retry?: RetryPolicy;
  /**
   * Solo las excepciones se reintentan. `args` ya llegó validado por `args`.
   */
  run(args: Infer<A>, ctx: ActionCtx): Promise<ActionResult>;
}

export interface WaitDef {
  name: string;
  args: ZodType;
  outcomes: string[];
}

/** Lo que una rama del parallel dejó al cerrar: su outcome y su output. */
export interface BranchResult {
  outcome: string;
  output: unknown;
}

export interface ConsolidatorDef<A extends ZodType = ZodType> {
  name: string;
  /** Valida el `args` del `join` (ya con sus refs resueltos); sin esto no se validan. */
  args?: A;
  outcomes: string[];
  /**
   * Junta las ramas en un outcome y un output. Corre dentro de la transacción que cierra la última
   * rama: es síncrona y pura. Recibe solo las ramas que corrieron y no fallaron, por su id (en un
   * `forEach`, por su posición). Si lanza, el parallel termina en `error`.
   */
  run(byBranch: Record<string, BranchResult>, args: Infer<A>): { outcome: string; output: unknown };
}

/** Un rol visto desde un flujo: qué modos tiene, qué outcomes da cada uno y qué forma lleva su brief. */
export interface RoleInfo {
  modes: Record<string, { outcomes: string[]; payload?: ZodType }>;
}

export interface Catalog {
  action(name: string): ActionDef | undefined;
  wait(name: string): WaitDef | undefined;
  consolidator(name: string): ConsolidatorDef | undefined;
  role(id: string): RoleInfo | undefined;
  /** El flujo vigente con ese id, para validar llamadas entre flujos. */
  flow(id: string): FlowDef | undefined;
}

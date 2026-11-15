import { eventIterator, oc } from "@orpc/contract";
import * as z from "zod";
import { Connection } from "./connections";
import { Event, EventFilter } from "./domain";

/**
 * Convención `.meta({ mcp })` (`docs/design.html#d-data`, "Tools MCP desde el mismo contrato").
 * Un procedimiento que se expone como tool MCP lo declara aquí, en el contrato, con una de dos formas:
 *
 * - CRUD por kind de def: `.meta({ mcp: { tool: "list", kind: "flow" } })`. Las tools `list`, `get`,
 *   `create`, `update` y `delete` reciben `{ kind, id?, data?, dryRun? }` y despachan al procedimiento
 *   marcado para ese kind.
 * - Acción: `.meta({ mcp: { action: "retry_step", annotations: { idempotentHint: true } } })`. Una tool
 *   por acción, con el input zod del procedimiento tal cual.
 *
 * Regla de anotaciones: `list` y `get` van con `readOnlyHint`, `update` con `idempotentHint`, `delete` e
 * `interrupt_run` con `destructiveHint`, y todas con `openWorldHint: false` salvo las que publican en
 * GitHub o Linear. El generador (todavía no existe) debe fallar si un procedimiento con `meta.mcp` no
 * declara anotaciones.
 */
export type McpMeta =
  | {
      tool: "list" | "get" | "create" | "update" | "delete";
      kind: "flow" | "role" | "profile" | "recipe" | "context" | "pack";
    }
  | { action: string; annotations?: McpAnnotations };

export interface McpAnnotations {
  readOnlyHint?: boolean;
  idempotentHint?: boolean;
  destructiveHint?: boolean;
  openWorldHint?: boolean;
}

export interface ContractMeta {
  mcp?: McpMeta;
}

/**
 * Versión mayor de la API. Sube cuando el contrato cambia de forma incompatible; el core la
 * informa en `system.health` y la app, si difiere de la suya, relanza el core (`d-data`, "Handshake").
 */
export const API_MAJOR = 1;

const base = oc.$meta<ContractMeta>({});

const system = {
  /** Handshake de versión: la app lo compara con su `apiMajor` para decidir si relanza el core. */
  health: base.output(
    z.object({
      coreVersion: z.string(),
      apiMajor: z.int().nonnegative(),
      schemaVersion: z.int().nonnegative(),
      bootId: z.string(),
      activeRuns: z.int().nonnegative(),
    }),
  ),
  /** Datos del proceso del core; `health` solo lleva lo que necesita el handshake. */
  info: base.output(
    z.object({
      pid: z.int().positive(),
      /** ms epoch */
      startedAt: z.int().nonnegative(),
      dataDir: z.string(),
      platform: z.enum(["darwin", "linux", "win32"]),
    }),
  ),
  /** Con `drain` el core no toma pasos nuevos y espera las acciones en curso antes de salir. */
  shutdown: base.input(z.object({ drain: z.boolean() })),
};

const events = {
  /** Eventos con `seq > after`, en orden de `seq`. */
  list: base
    .input(
      z.object({
        after: z.int().nonnegative().default(0),
        limit: z.int().min(1).max(500).default(100),
        filter: EventFilter.default({}),
      }),
    )
    .output(z.array(Event)),
  /**
   * Rellena desde `after` (o desde el `Last-Event-ID` del reconectado) y sigue en vivo, sin
   * duplicados. El `id` de cada mensaje SSE es su `seq`.
   */
  stream: base
    .input(
      z.object({
        after: z.int().nonnegative().optional(),
        filter: EventFilter.default({}),
      }),
    )
    .output(eventIterator(Event)),
};

const connections = {
  /** Cuentas conectadas, sin sus tokens. */
  list: base.output(z.array(Connection)),
};

export const contract = { system, events, connections };
export type Contract = typeof contract;

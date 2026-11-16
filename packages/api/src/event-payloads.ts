import type { Event, EventType, RunId } from "./domain";
import type { BreakerCause } from "./runs";

/**
 * El payload de los eventos que el core consume en proceso: quien emite (`tx.emit`) y quien escucha
 * (`store.events.subscribe`) comparten esta declaración, así un campo que cambia de nombre no se rompe en
 * silencio. Los demás eventos llevan un registro libre; se suman aquí cuando alguien los lee en proceso.
 */
export interface EventPayloads {
  /** Una corrida devolvió el sujeto que pidió prestado: la dueña (`fromRunId`) relee su branch. */
  "run.returned": { runId: RunId; fromRunId: RunId };
  "breaker.opened": { scope: string; cause: BreakerCause; reason: string; retryAt: number };
  /** Se soltó el lease de un worktree o de un slot (`id`), con el token que tenía. */
  "lease.released": { resource: "workspace" | "slot"; id: string; token: number };
}

/** El payload de un evento de tipo `T`: el declarado en `EventPayloads` o un registro libre. */
export type PayloadOf<T extends EventType> = T extends keyof EventPayloads ? EventPayloads[T] : Record<string, unknown>;

/** Un evento de tipo `T` con su payload tipado. */
export type EventOf<T extends EventType> = Omit<Event, "type" | "payload"> & { type: T; payload: PayloadOf<T> };

import type { ConnectionProvider, ConnectionStatus, LoginFailure } from "./connections";
import type { DecisionKind, DecisionStatus } from "./decisions";
import type { ChatId, DecisionId, Event, EventType, RepoId, RunId } from "./domain";
import type { BreakerCause } from "./runs";

/**
 * El payload de los eventos que alguien lee (el core en proceso con `store.events.subscribe`, o la UI con su stream):
 * quien emite (`tx.emit`) y quien escucha comparten esta declaración, así un campo que cambia de nombre no se rompe en
 * silencio. Los demás eventos llevan un registro libre; se suman aquí cuando alguien los lee.
 */
export interface EventPayloads {
  "chat.message": { chatId: ChatId; prId: string };
  "chat.turn_started": { chatId: ChatId; prId: string };
  "chat.turn_finished": { chatId: ChatId; prId: string };
  "chat.proposal": { chatId: ChatId; prId: string };
  "chat.apply_started": { chatId: ChatId; prId: string };
  "chat.apply_finished": { chatId: ChatId; prId: string };
  "pr.saved_local": { repo: string; branch: string; base: string };
  /** Una corrida devolvió el sujeto que pidió prestado: la dueña (`fromRunId`) relee su branch. */
  "run.returned": { runId: RunId; fromRunId: RunId };
  "breaker.opened": { scope: string; cause: BreakerCause; reason: string; retryAt: number };
  /** Se soltó el lease de un worktree o de un slot (`id`), con el token que tenía. */
  "lease.released": { resource: "workspace" | "slot"; id: string; token: number };
  /** Una cuenta se conectó, venció, quedó revocada o se desconectó: abre o prueba su breaker. */
  "connection.changed": { provider: ConnectionProvider; account: string; status: ConnectionStatus | "disconnected" };
  /** Un device flow de GitHub falló sin tocar la cuenta: la UI lo muestra sin esperar a que venza el código. */
  "connection.login_failed": { provider: "github"; reason: LoginFailure; message: string };
  /** GitHub cortó las requests de la cuenta por cuota hasta `resetAt` (ms epoch). */
  "sync.rate_limited": { provider: "github"; account: string; resetAt: number };
  /** Watch vio el PR listo para ofrecer (o mergear solo) en el head `sha`. */
  "pr.mergeReady": { repo: string; number: number; sha: string; level: "offer" | "auto" };
  "decision.opened": { decisionId: DecisionId; kind: DecisionKind; title: string };
  "decision.resolved": { decisionId: DecisionId; status: DecisionStatus };
  /** Terminó la prueba de la receta de un repo (`repos.testRecipe`). */
  "recipe.test_finished": { repoId: RepoId; ok: boolean };
}

/** El payload de un evento de tipo `T`: el declarado en `EventPayloads` o un registro libre. */
export type PayloadOf<T extends EventType> = T extends keyof EventPayloads ? EventPayloads[T] : Record<string, unknown>;

/**
 * Un evento de tipo `T` con su payload tipado. Con varios tipos es una unión por `type`: un `if (event.type === ...)`
 * deja ver el payload de ese tipo.
 */
export type EventOf<T extends EventType> = T extends EventType ? Omit<Event, "type" | "payload"> & { type: T; payload: PayloadOf<T> } : never;

/** `event` es de tipo `type`, con el payload que declara `EventPayloads` (lo exige el `tx.emit` del core que lo escribió). */
export const isEventOf = <T extends EventType>(event: Event, type: T): event is Event & EventOf<T> => event.type === type;

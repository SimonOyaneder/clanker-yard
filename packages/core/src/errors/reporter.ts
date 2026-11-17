import type { ProjectId } from "@clanker/api";
import type { Store } from "../store/store";
import { messageOf } from "./format";

/** De qué es el error, además de su `scope`: el proyecto queda en el evento y separa el dedupe. */
export interface ErrorContext {
  projectId?: ProjectId;
}

export interface ErrorReporter {
  /**
   * Anota `error` como un evento `error` (`payload: { scope, message }`). Un mismo mensaje se anota una
   * sola vez por `scope` (y proyecto) hasta que `clear` diga que volvió a andar: si no, un error persistente
   * llenaría los eventos en cada vuelta. Nunca lanza: si no puede escribir el evento, lo deja en la consola.
   */
  report(scope: string, error: unknown, context?: ErrorContext): void;
  /** `scope` volvió a andar: su próximo error se anota aunque repita el mensaje. */
  clear(scope: string, context?: ErrorContext): void;
  /** El mismo reporter con `prefix.` delante de cada scope (`within("watch")` anota `watch.tick`), y el mismo dedupe. */
  within(prefix: string): ErrorReporter;
}

/**
 * Lo que usan los procesos largos del core (Watch, limpieza, sync de configuración, Scheduler, breakers) para
 * anotar lo que falla: un callback de timer o de evento no puede lanzar, porque tumbaría el core.
 */
export function createErrorReporter({ store }: { store: Store }): ErrorReporter {
  const last = new Map<string, string>();
  const keyOf = (scope: string, context: ErrorContext | undefined) => `${scope}\0${context?.projectId ?? ""}`;

  function reporter(prefix: string): ErrorReporter {
    const full = (scope: string) => `${prefix}${scope}`;
    return {
      report(scope, error, context) {
        const message = messageOf(error);
        const key = keyOf(full(scope), context);
        if (last.get(key) === message) return;
        last.set(key, message);
        try {
          store.tx((tx) => tx.emit({ type: "error", origin: "core", projectId: context?.projectId, payload: { scope: full(scope), message } }));
        } catch (cause) {
          console.error(`No se pudo anotar el error de ${full(scope)} (${message}):`, cause);
        }
      },
      clear(scope, context) {
        last.delete(keyOf(full(scope), context));
      },
      within: (inner) => reporter(`${prefix}${inner}.`),
    };
  }
  return reporter("");
}

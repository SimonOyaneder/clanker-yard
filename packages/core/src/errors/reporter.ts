import type { Store } from "../store/store";

/**
 * Anota los errores de Watch como eventos `error` (`scope: "watch.<scope>"`). Un callback de Watch no puede
 * lanzar: tumbaría el core. Un mismo mensaje se anota una sola vez por `scope`, hasta que `clear` diga que
 * volvió a andar; si no, un error persistente llenaría los eventos en cada despertar.
 */
export function createErrorReporter(store: Store) {
  const last = new Map<string, string>();
  return {
    report(scope: string, error: unknown): void {
      const message = error instanceof Error ? error.message : String(error);
      if (last.get(scope) === message) return;
      last.set(scope, message);
      try {
        store.tx((tx) => tx.emit({ type: "error", origin: "core", payload: { scope: `watch.${scope}`, message } }));
      } catch (cause) {
        console.error(`Watch no pudo anotar el error de ${scope}:`, cause);
      }
    },
    clear(scope: string): void {
      last.delete(scope);
    },
  };
}

export type ErrorReporter = ReturnType<typeof createErrorReporter>;

import type { ErrorReporter } from "../watch/report";
import type { Workspaces } from "./workspaces";

/** Cada cuánto corre sola: lo que no avisa nadie (el vencimiento de los 7 días) y lo que se haya escapado. */
export const CLEANUP_EVERY_MS = 60 * 60 * 1000;

export interface Cleanup {
  /** Pide una pasada de `workspaces.cleanup`. Las que llegan mientras otra corre se juntan en una más. */
  request(): void;
  /** Deja de correr sola y espera a la pasada en vuelo. */
  stop(): Promise<void>;
}

/**
 * Quien llama a `workspaces.cleanup` (`docs/design.html#d-ops`, estados del worktree): una pasada al arrancar,
 * cada `CLEANUP_EVERY_MS` y cada vez que `request` avisa que un PR terminó o que se soltó un worktree. Nunca
 * lanza: lo que falla se anota una vez con `errors` hasta que una pasada salga bien.
 */
export function startCleanup({ workspaces, errors, everyMs = CLEANUP_EVERY_MS }: { workspaces: Pick<Workspaces, "cleanup">; errors: ErrorReporter; everyMs?: number }): Cleanup {
  const scope = "workspaces.cleanup";
  let running: Promise<void> | undefined;
  let again = false;
  let stopped = false;

  function request(): void {
    if (stopped) return;
    if (running) {
      again = true;
      return;
    }
    running = workspaces
      .cleanup()
      .then(
        () => errors.clear(scope),
        (error: unknown) => errors.report(scope, error),
      )
      .finally(() => {
        running = undefined;
        if (again) {
          again = false;
          request();
        }
      });
  }

  const timer = setInterval(request, everyMs);
  timer.unref();
  request();

  return {
    request,
    async stop() {
      stopped = true;
      clearInterval(timer);
      await running;
    },
  };
}

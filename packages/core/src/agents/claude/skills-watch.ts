import { existsSync, watch, type FSWatcher } from "node:fs";
import { join } from "node:path";
import type { NativeContext } from "../runtime";

/** Una ráfaga de cambios (un editor escribe varias veces) cuenta como uno. */
export const SKILLS_DEBOUNCE_MS = 150;

/** Las carpetas de skills y comandos que Claude Code lee para estas `sources`. */
export function skillDirs(native: NativeContext | undefined, cwd: string, userDir: string): string[] {
  if (native === undefined || native.skills.length === 0) return [];
  return native.sources.flatMap((source) => {
    const root = source === "user" ? userDir : join(cwd, ".claude");
    return [join(root, "skills"), join(root, "commands")];
  });
}

/**
 * Llama a `onChange` cuando algo cambia bajo `dirs` (las que no existen se omiten), y a `onError` si un
 * observador falla: un callback de timer o de evento no puede lanzar. Devuelve cómo dejar de observar.
 */
export function watchDirs(dirs: string[], onChange: () => void, onError: (error: Error) => void): () => void {
  const watchers: FSWatcher[] = [];
  let timer: NodeJS.Timeout | undefined;
  const changed = () => {
    clearTimeout(timer);
    timer = setTimeout(onChange, SKILLS_DEBOUNCE_MS);
  };
  for (const dir of dirs.filter((d) => existsSync(d))) {
    try {
      watchers.push(watch(dir, { recursive: true }, changed).on("error", onError));
    } catch (error) {
      onError(error as Error);
    }
  }
  return () => {
    clearTimeout(timer);
    for (const watcher of watchers) watcher.close();
  };
}

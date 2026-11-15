import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

/** Preferencias de la app en un JSON (tema, posición de la ventana). Lo que falta o no se lee toma el valor por defecto. */
export interface Prefs {
  get<T>(key: string, fallback: T): T;
  set(key: string, value: unknown): void;
}

export function createPrefs(file: string): Prefs {
  let data: Record<string, unknown> = {};
  try {
    data = JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
  } catch (error) {
    // Sin archivo todavía es lo normal; uno corrupto se reescribe en el próximo set.
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") console.error(`prefs: no se pudo leer ${file}`, error);
  }
  return {
    get: <T>(key: string, fallback: T) => (data[key] as T | undefined) ?? fallback,
    set(key, value) {
      data[key] = value;
      mkdirSync(path.dirname(file), { recursive: true });
      writeFileSync(file, JSON.stringify(data));
    },
  };
}

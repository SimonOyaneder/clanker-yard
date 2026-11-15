import { isRef } from "@clanker/api";

/** `$plan.files` → `["plan", "files"]`. */
export function refPath(ref: string): string[] {
  return ref.slice(1).split(".");
}

/** Sigue `path` dentro de `root`; lo que no existe es `undefined`. */
export function navigate(root: unknown, path: string[]): unknown {
  let current = root;
  for (const key of path) {
    if (current === null || typeof current !== "object") return undefined;
    current = (current as Record<string, unknown>)[key];
  }
  return current;
}

/**
 * Reemplaza cada string que es un ref (el valor entero, sin interpolación) por lo que devuelve
 * `resolve`. Un ref que no apunta a nada queda `null`: un campo opcional ausente no es un error.
 */
export function resolveRefs(value: unknown, resolve: (ref: string) => unknown): unknown {
  if (typeof value === "string") return isRef(value) ? (resolve(value) ?? null) : value;
  if (Array.isArray(value)) return value.map((item) => resolveRefs(item, resolve));
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, resolveRefs(item, resolve)]));
  }
  return value;
}

/** `when`: un valor falso o una lista vacía salta el paso. */
export function isTruthy(value: unknown): boolean {
  return Array.isArray(value) ? value.length > 0 : Boolean(value);
}

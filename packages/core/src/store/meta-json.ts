import { eq } from "drizzle-orm";
import type { ZodType } from "zod";
import { meta } from "./schema";
import type { Store } from "./store";

/**
 * El JSON que el core guardó en `meta` bajo `key`, validado con `schema`. `undefined` si no hay nada o si lo
 * guardado ya no cumple el esquema (un formato de una versión anterior): quien lee cae a sus defaults en vez
 * de arrastrar una forma que el código ya no espera.
 */
export function readMetaJson<T>(db: Store["db"], key: string, schema: ZodType<T>): T | undefined {
  const saved = db.select().from(meta).where(eq(meta.key, key)).get();
  if (!saved) return undefined;
  let raw: unknown;
  try {
    raw = JSON.parse(saved.value);
  } catch {
    return undefined;
  }
  const parsed = schema.safeParse(raw);
  return parsed.success ? parsed.data : undefined;
}

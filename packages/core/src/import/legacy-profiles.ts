import * as z from "zod";

/** El `profiles.json` del clanker-loop: lo que usa `clanker import legacy` y nada más (`default` y `judge` no tienen lugar en el core). */
const LegacyProfilesFile = z.object({
  /** USD por millón de tokens: `[input, output, cache_read]`. Las claves con `_` son comentarios. */
  precios: z.record(z.string(), z.union([z.tuple([z.number(), z.number(), z.number()]), z.string()])),
  /** Por perfil, el `modelo:effort` de cada rol. */
  perfiles: z.record(z.string(), z.record(z.string(), z.string().min(1))),
});

/** El rol del loop viejo que ya no existe: los flujos del core lo reemplazan. */
const DROPPED_ROLE = "techlead";

export interface LegacyProfile {
  slug: string;
  roles: Record<string, { model: string; effort?: string }>;
}

/** Un precio como lo guarda `model_prices` (USD × 10⁶ por millón de tokens). */
export interface LegacyPrice {
  model: string;
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite5m: number;
  cacheWrite1h: number;
}

const toMicros = (usd: number) => Math.round(usd * 1_000_000);

/** Lee un `profiles.json`: los perfiles sin el techlead y los precios con la caché que el loop calculaba (1,25× la entrada a 5 min y 2× a 1 h). */
export function parseLegacyProfiles(text: string): { profiles: LegacyProfile[]; prices: LegacyPrice[] } {
  const file = LegacyProfilesFile.parse(JSON.parse(text));
  const profiles = Object.entries(file.perfiles).map(([slug, specs]) => ({
    slug,
    roles: Object.fromEntries(
      Object.entries(specs)
        .filter(([role]) => role !== DROPPED_ROLE)
        .map(([role, spec]) => {
          const [model = spec, effort] = spec.split(":");
          return [role, { model, ...(effort === undefined ? {} : { effort }) }];
        }),
    ),
  }));
  const prices = Object.entries(file.precios).flatMap(([model, price]) => {
    if (typeof price === "string") return [];
    const [input, output, cacheRead] = [toMicros(price[0]), toMicros(price[1]), toMicros(price[2])];
    return [{ model, input, output, cacheRead, cacheWrite5m: Math.round(input * 1.25), cacheWrite1h: input * 2 }];
  });
  return { profiles, prices };
}

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { usdToMicros } from "../../store/conventions";
import type { TokenUsage } from "./api";

/** USD por millón de tokens, como los da el catálogo de models.dev. */
interface Rates {
  input: number;
  output: number;
  cache_read?: number;
  cache_write?: number;
}

/** El precio de un modelo: sus tarifas base y las de los prompts más largos que `size` tokens. */
export interface ModelPrice extends Rates {
  tiers?: { size: number; rates: Rates }[];
}

/** El precio de `proveedor/modelo`, o `undefined` si el catálogo no lo tiene. */
export type PriceOf = (model: string) => ModelPrice | undefined;

/**
 * El catálogo de modelos que opencode baja de models.dev (`$XDG_CACHE_HOME/opencode/models.json`, por defecto
 * `~/.cache/opencode`). Se lee una vez, la primera vez que hace falta; sin archivo, o con uno que no se entiende,
 * no hay precios y el costo queda como lo reportó opencode.
 */
export function catalogPrices(env: Record<string, string | undefined>): PriceOf {
  const cacheDir = env.XDG_CACHE_HOME ?? (env.HOME === undefined ? undefined : join(env.HOME, ".cache"));
  let catalog: Record<string, { models?: Record<string, { cost?: unknown }> }> | undefined;
  return (model) => {
    if (catalog === undefined) {
      try {
        catalog = cacheDir === undefined ? {} : (JSON.parse(readFileSync(join(cacheDir, "opencode", "models.json"), "utf8")) as typeof catalog);
      } catch {
        catalog = {};
      }
    }
    const slash = model.indexOf("/");
    if (slash < 0) return undefined;
    return priceOf(catalog?.[model.slice(0, slash)]?.models?.[model.slice(slash + 1)]?.cost);
  };
}

function priceOf(cost: unknown): ModelPrice | undefined {
  const base = ratesOf(cost);
  if (!base) return undefined;
  const tiers = Array.isArray((cost as { tiers?: unknown }).tiers) ? ((cost as { tiers: unknown[] }).tiers) : [];
  const parsed = tiers.flatMap((t) => {
    const size = (t as { tier?: { type?: string; size?: unknown } }).tier;
    const rates = ratesOf(t);
    return size?.type === "context" && typeof size.size === "number" && rates ? [{ size: size.size, rates }] : [];
  });
  return { ...base, ...(parsed.length > 0 && { tiers: parsed.sort((a, b) => a.size - b.size) }) };
}

function ratesOf(value: unknown): Rates | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const { input, output, cache_read, cache_write } = value as Record<string, unknown>;
  if (typeof input !== "number" || typeof output !== "number") return undefined;
  return {
    input,
    output,
    ...(typeof cache_read === "number" && { cache_read }),
    ...(typeof cache_write === "number" && { cache_write }),
  };
}

/**
 * Lo que costaría un paso a precio de lista, en micros. El prompt (entrada más caché) elige la tarifa: la del tramo más
 * grande que supera. El razonamiento se cobra como salida, como en `usageOf`.
 */
export function estimateMicros(price: ModelPrice, tokens: TokenUsage): number {
  const prompt = tokens.input + tokens.cache.read + tokens.cache.write;
  const rates = [...(price.tiers ?? [])].reverse().find((t) => prompt > t.size)?.rates ?? price;
  const usd =
    (tokens.input * rates.input +
      (tokens.output + tokens.reasoning) * rates.output +
      tokens.cache.read * (rates.cache_read ?? rates.input) +
      tokens.cache.write * (rates.cache_write ?? rates.input)) /
    1_000_000;
  return usdToMicros(usd);
}

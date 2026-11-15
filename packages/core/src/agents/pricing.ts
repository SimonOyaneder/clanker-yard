import { lte } from "drizzle-orm";
import { modelPrices } from "../store/schema";
import type { StoreDb } from "../store/store";

export interface TurnTokens {
  tokensIn: number;
  tokensOut: number;
  tokensCacheRead: number;
  /** Todo lo escrito en la caché. */
  tokensCacheWrite: number;
  /** La parte de `tokensCacheWrite` que fue a la caché de 1 h. */
  tokensCacheWrite1h: number;
}

const ZERO_TOKENS: TurnTokens = { tokensIn: 0, tokensOut: 0, tokensCacheRead: 0, tokensCacheWrite: 0, tokensCacheWrite1h: 0 };

const TOKENS_PER_PRICE_UNIT = 1_000_000;

/**
 * El USD de un turno en micros, con la tabla `model_prices` (la misma cuenta de `clanker-loop cost`:
 * entrada, escritura de caché de 5 min y de 1 h, lectura de caché y salida). Un modelo con precio
 * por prompt largo cobra el turno entero con ese precio si su prompt (entrada más caché) lo pasa.
 * `undefined` si ningún precio vigente en `ts` corresponde al modelo: quien llama decide qué hacer,
 * nunca se inventa uno.
 */
export function estimateCostMicros(
  db: StoreDb,
  model: string,
  ts: number,
  tokens: TurnTokens,
): number | undefined {
  const isFree = Object.values(tokens).every((n) => n === 0);
  if (isFree) return 0;

  // Gana el nombre más específico, entre iguales el precio más reciente y, entre iguales, el de prompt más largo que aplique.
  const promptTokens = tokens.tokensIn + tokens.tokensCacheRead + tokens.tokensCacheWrite;
  const price = db
    .select()
    .from(modelPrices)
    .where(lte(modelPrices.validFrom, ts))
    .all()
    .filter((p) => model.includes(p.model) && (p.abovePromptTokens === 0 || promptTokens > p.abovePromptTokens))
    .sort(
      (a, b) =>
        b.model.length - a.model.length || b.validFrom - a.validFrom || b.abovePromptTokens - a.abovePromptTokens,
    )[0];
  if (price === undefined) return undefined;

  const write5m = tokens.tokensCacheWrite - tokens.tokensCacheWrite1h;
  const total =
    tokens.tokensIn * price.input +
    tokens.tokensOut * price.output +
    tokens.tokensCacheRead * price.cacheRead +
    write5m * price.cacheWrite5m +
    tokens.tokensCacheWrite1h * price.cacheWrite1h;
  return Math.round(total / TOKENS_PER_PRICE_UNIT);
}

/** Lo que una sesión de Claude Code escribe en la caché antes de su primera respuesta (herramientas, prompt de sistema y contexto): 30 a 50k tokens. */
export const PREFIX_TOKENS = 50_000;

/**
 * El tope de gasto por debajo del cual una sesión no llega a entregar un reporte: escribir el prefijo
 * en la caché de `cacheTtl`. `undefined` si el modelo no tiene precio.
 */
export function minUsefulBudgetMicros(
  db: StoreDb,
  model: string,
  ts: number,
  cacheTtl: "5m" | "1h",
): number | undefined {
  return estimateCostMicros(db, model, ts, {
    ...ZERO_TOKENS,
    tokensCacheWrite: PREFIX_TOKENS,
    tokensCacheWrite1h: cacheTtl === "1h" ? PREFIX_TOKENS : 0,
  });
}

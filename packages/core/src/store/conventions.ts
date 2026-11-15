import { monotonicFactory } from "ulid";

const ulid = monotonicFactory();

/** Id de texto con prefijo y ULID (`run_01J…`): ordenable por creación, también dentro del mismo ms. */
export function newId<const P extends string>(prefix: P): `${P}_${string}` {
  return `${prefix}_${ulid()}`;
}

const MICROS_PER_USD = 1_000_000;

/** La plata se guarda en micros de USD (INTEGER): sumar no acumula errores de float. */
export function usdToMicros(usd: number): number {
  return Math.round(usd * MICROS_PER_USD);
}

export function microsToUsd(micros: number): number {
  return micros / MICROS_PER_USD;
}

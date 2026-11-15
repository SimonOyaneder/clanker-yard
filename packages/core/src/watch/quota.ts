import { eq } from "drizzle-orm";
import { rateKey } from "../github/client";
import { syncCursors } from "../store/schema";
import type { Store } from "../store/store";

/** Bajo esta fracción de la cuota los intervalos se duplican. */
export const SLOW_BELOW = 0.25;
/** Bajo esta fracción solo se atienden los PRs que un flujo espera. */
export const WAITS_ONLY_BELOW = 0.1;

/**
 * Cuánto puede gastar Watch ahora (`docs/design.html#d-ops`, "Freno"):
 * - `normal`: los intervalos de siempre.
 * - `slow`: bajo 25% de la cuota de REST o de GraphQL, intervalos al doble.
 * - `waits-only`: bajo 10%, solo los PRs con waits (siguen al doble) hasta `until`, cuando la cuota se renueva.
 * - `exhausted`: sin cuota, nada hasta `until`.
 */
export type Throttle =
  | { level: "normal" | "slow" }
  | { level: "waits-only" | "exhausted"; until: number };

/**
 * El freno de una cuenta según la última cuota que GitHub informó (`sync_cursors`). Una cuota cuyo reset
 * ya pasó se da por renovada: GitHub no vuelve a informarla hasta la próxima request.
 */
export function throttleOf(store: Store, account: string, at: number): Throttle {
  let slow = false;
  let waitsOnlyUntil: number | undefined;
  for (const resource of ["core", "graphql"]) {
    const row = store.db.select().from(syncCursors).where(eq(syncCursors.key, rateKey(account, resource))).get();
    if (row?.rateRemaining == null || row.resetAt == null || row.resetAt <= at) continue;
    if (row.rateRemaining <= 0) return { level: "exhausted", until: row.resetAt };
    const fraction = row.rateRemaining / (row.rateLimit ?? DEFAULT_LIMIT);
    if (fraction < WAITS_ONLY_BELOW) waitsOnlyUntil = Math.max(waitsOnlyUntil ?? 0, row.resetAt);
    else if (fraction < SLOW_BELOW) slow = true;
  }
  if (waitsOnlyUntil !== undefined) return { level: "waits-only", until: waitsOnlyUntil };
  return { level: slow ? "slow" : "normal" };
}

/** El tope de REST y de GraphQL para un PAT, si GitHub no informó otro. */
const DEFAULT_LIMIT = 5000;

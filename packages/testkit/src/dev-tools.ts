import type { Client } from "@clanker/api";
import type { DevTools, Store } from "@clanker/core";
import { scenarios } from "./scenarios";
import { seedSummary } from "./summary-scenario";

export interface DevKit {
  dev: DevTools;
  /** El reloj falso del core de desarrollo: pásalo como `now` de las conexiones. */
  now(): number;
}

/**
 * Lo que un core de desarrollo necesita para montar el router `dev` (`startCore({ dev })`, `docs/design.html#devx`):
 * como fixtures, los escenarios de base (`scenarios.ts`) y `summary` (`summary-scenario.ts`), los mismos que usan
 * los tests y el core de demo; y un reloj falso que parte de `clockStart` más `clockOffset()` (lo que ya
 * adelantaba `demo-control.json`) y que `dev.advanceClock` empuja. `api` se pide perezoso: el cliente de un core
 * existe recién cuando el core ya arrancó con este kit.
 */
export function createDevKit({
  store,
  api,
  clockStart,
  clockOffset = () => 0,
}: {
  store: Store;
  api: () => Client;
  clockStart: number;
  clockOffset?: () => number;
}): DevKit {
  let advanced = 0;
  const now = () => clockStart + clockOffset() + advanced;
  const fixtures: Record<string, () => Promise<void>> = {
    summary: async () => void (await seedSummary({ client: api(), store })),
  };
  for (const [name, seed] of Object.entries(scenarios)) fixtures[name] = async () => seed(store);
  return {
    now,
    dev: {
      fixtures,
      advanceClock(ms) {
        advanced += ms;
        return now();
      },
    },
  };
}

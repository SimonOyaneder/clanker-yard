import { devContract } from "@clanker/api";
import { implement, ORPCError } from "@orpc/server";
import type { Flows } from "../flows/flows";
import { asApiError, type CoreContext } from "./router";

/**
 * Lo que quien lanza un core de desarrollo (el core de demo del testkit) le da al router `dev`
 * (`docs/design.html#devx`). Pasarlo a `startCore({ dev })` es el único interruptor: sin él, el core no monta el
 * router `dev` ni sus tools MCP.
 */
export interface DevTools {
  /** Los escenarios que `dev.loadFixture` siembra, por nombre. */
  fixtures: Readonly<Record<string, () => Promise<void>>>;
  /** Adelanta el reloj falso `ms` y devuelve la hora nueva (ms epoch). */
  advanceClock(ms: number): number;
}

const os = implement(devContract).$context<CoreContext>();

/** El router `dev`; se sirve bajo la clave `dev`, junto al de `contract`, solo cuando el core se lanzó con `DevTools`. */
export function createDevRouter({ flows, dev }: { flows: Flows; dev: DevTools }) {
  return os.router({
    injectStepResult: os.injectStepResult.handler(({ input, context }) =>
      asApiError(() => flows.getRun(flows.stepCommand(input.stepId, { force: input.outcome }, context.origin))),
    ),
    loadFixture: os.loadFixture.handler(async ({ input }) => {
      const seed = Object.hasOwn(dev.fixtures, input.name) ? dev.fixtures[input.name] : undefined;
      if (!seed) {
        const known = Object.keys(dev.fixtures).join(", ") || "ninguno";
        throw new ORPCError("BAD_REQUEST", { message: `No existe el fixture "${input.name}": hay ${known}.` });
      }
      await seed();
      return { name: input.name };
    }),
    advanceClock: os.advanceClock.handler(({ input }) => ({ now: dev.advanceClock(input.ms) })),
  });
}

export type DevRouter = ReturnType<typeof createDevRouter>;

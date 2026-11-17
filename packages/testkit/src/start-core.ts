import type { AgentRuntime } from "@clanker/core";
import { startCore as startCoreBase, type StartCoreOptions } from "@clanker/core";
import { JUGUETE_TEMPLATE } from "@clanker/core/testing";
import type { FakeRuntime } from "./fake-runtime";

/**
 * `startCore` con la plantilla `juguete`, que el core de producción no instala: los tests y las demos la usan como flujo
 * mínimo. Con el runtime `fake` entre los runtimes, los checks de la receta salen de su guion (`recipeResults`).
 */
export const startCore = (opts: StartCoreOptions) =>
  startCoreBase({ builtins: [JUGUETE_TEMPLATE], recipeResults: opts.runtimes.find(isFake), ...opts });

const isFake = (runtime: AgentRuntime): runtime is FakeRuntime => runtime.id === "fake";

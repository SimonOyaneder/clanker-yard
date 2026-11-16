import { startCore as startCoreBase, type StartCoreOptions } from "@clanker/core";
import { JUGUETE_TEMPLATE } from "@clanker/core/testing";

/** `startCore` con la plantilla `juguete`, que el core de producción no instala: los tests y las demos la usan como flujo mínimo. */
export const startCore = (opts: StartCoreOptions) => startCoreBase({ builtins: [JUGUETE_TEMPLATE], ...opts });

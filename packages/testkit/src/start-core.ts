import { JUGUETE_TEMPLATE, startCore as startCoreBase, type StartCoreOptions } from "@clanker/core";

/** `startCore` con la plantilla `juguete`, que el core de producción no instala: los tests y las demos la usan como flujo mínimo. */
export const startCore = (opts: StartCoreOptions) => startCoreBase({ builtins: [JUGUETE_TEMPLATE], ...opts });

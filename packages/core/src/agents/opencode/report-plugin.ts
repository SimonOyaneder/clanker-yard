import { REPORT_TOOL } from "./config";

/**
 * El plugin de servidor de opencode 2 que registra `REPORT_TOOL`, cuya entrada es el esquema del reporte del modo
 * (`options.schema`, de la config del run). opencode 2 no tiene salida estructurada: el adapter toma el reporte de la
 * llamada a esta herramienta (`session.tool.called`) y el core lo valida como cualquier otro.
 *
 * Es JavaScript plano sin imports (un plugin es `{ id, setup }`; `Plugin.define` de `@opencode/plugin` solo lo tipa), así
 * que no necesita dependencias instaladas. El core lo escribe en `<home>/agent-env/opencode/report-plugin/index.js`
 * porque el bundle del core no lleva archivos sueltos.
 */
export const REPORT_PLUGIN_SOURCE = `// Generado por Clanker Yard: no lo edites, se reescribe en cada arranque.
export default {
  id: "clanker-report",
  async setup(ctx) {
    const schema = ctx.options.schema;
    await ctx.tool.transform((editor) => {
      editor.add({
        name: ${JSON.stringify(REPORT_TOOL)},
        description: "Entrega el reporte final de tu trabajo. Llámala una sola vez, al terminar: es lo último que haces.",
        input: schema,
        options: { codemode: false },
        execute: async () => ({ content: "Reporte recibido. Terminaste: no hagas nada más." }),
      });
    });
  },
};
`;

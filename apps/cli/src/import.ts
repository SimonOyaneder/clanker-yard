import { resolve } from "node:path";
import { parseArgs } from "node:util";
import type { LegacyImportResult } from "@clanker/api";
import type { Command } from "./command";
import { formatTable } from "./format";

export const IMPORT_LEGACY_USAGE = "clanker import legacy --from <carpeta del clanker-loop> [--dry-run] [--json]";

const LABELS: [keyof LegacyImportResult["created"], string][] = [
  ["projects", "proyectos"],
  ["issues", "issues"],
  ["pullRequests", "PRs"],
  ["runs", "corridas (con sus métricas)"],
  ["runRoleCosts", "costos por rol"],
  ["learnings", "learnings propuestos"],
  ["decisions", "decisiones y notas"],
  ["artifacts", "artefactos"],
  ["profiles", "perfiles"],
  ["modelPrices", "precios de modelos"],
];

function describe(result: LegacyImportResult): string {
  const lines = [
    result.dryRun ? "Simulación: no se escribió nada. Una importación real crearía:" : "Importado:",
    formatTable(LABELS.map(([key, label]) => [label, String(result.created[key])]), 1),
  ];
  if (result.unresolvedRepos.length > 0) {
    lines.push(
      `Repos sin registrar (sus PRs quedaron fuera): ${result.unresolvedRepos.join(", ")}.`,
      "Regístralos en Clanker Yard y repite el comando: solo agrega lo que falte.",
    );
  }
  return lines.join("\n");
}

/**
 * `clanker import legacy`: el core lee la carpeta del clanker-loop (solo lectura) e importa su historial.
 * Se puede repetir; `--dry-run` cuenta sin escribir.
 */
export const importLegacy: Command = {
  usage: IMPORT_LEGACY_USAGE,
  async run(args, ctx) {
    const { values } = parseArgs({
      args,
      options: { from: { type: "string" }, "dry-run": { type: "boolean" }, json: { type: "boolean" } },
    });
    if (!values.from) throw new Error(`Falta --from. Uso: ${IMPORT_LEGACY_USAGE}`);

    // El core corre en otra carpeta: la ruta que lee tiene que ser absoluta.
    const result = await (await ctx.client()).imports.legacy({ from: resolve(values.from), dryRun: values["dry-run"] ?? false });
    ctx.write(values.json ? JSON.stringify(result, null, 2) : describe(result));
  },
};

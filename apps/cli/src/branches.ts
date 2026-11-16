import { parseArgs } from "node:util";
import type { Command } from "./cli";
import { projectBySlug } from "./projects";

/**
 * `clanker branches rename-legacy`: renombra las branches `iss_...` de los PRs abiertos a `eng-1234-slug`.
 * Con `--dry-run` solo lista `viejo → nuevo`.
 */
export const branchesRenameLegacy: Command = {
  usage: "clanker branches rename-legacy [--project <slug>] [--dry-run] [--json]",
  async run(args, ctx) {
    const { values } = parseArgs({ args, options: { project: { type: "string" }, "dry-run": { type: "boolean" }, json: { type: "boolean" } } });
    const client = await ctx.client();
    const projectId = values.project === undefined ? undefined : (await projectBySlug(client, values.project)).id;
    const results = await client.branches.renameLegacy({ projectId, dryRun: values["dry-run"] ?? false });

    if (values.json) return ctx.write(JSON.stringify(results, null, 2));
    if (results.length === 0) return ctx.write("No hay PRs abiertos con branch iss_...");
    for (const r of results) {
      const detail = r.reason ? ` (${r.reason})` : "";
      ctx.write(`${r.status} ${r.repo}#${r.number} ${r.from}${r.to ? ` → ${r.to}` : ""}${detail}`);
    }
  },
};

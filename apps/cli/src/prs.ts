import { parseArgs } from "node:util";
import type { Command } from "./cli";
import { projectBySlug } from "./projects";

/**
 * `clanker prs republish`: rehace los PRs abiertos del sistema con la branch, el autor y los commits de hoy (el PR
 * viejo queda cerrado y reemplazado). Con `--dry-run` solo lista `viejo → branch nueva`, sin tocar nada ni gastar.
 */
export const prsRepublish: Command = {
  usage: "clanker prs republish [--project <slug>] [--pr <n>]... [--drafts] [--dry-run] [--json]",
  async run(args, ctx) {
    const { values } = parseArgs({
      args,
      options: { project: { type: "string" }, pr: { type: "string", multiple: true }, drafts: { type: "boolean" }, "dry-run": { type: "boolean" }, json: { type: "boolean" } },
    });
    const prs = (values.pr ?? []).map((n) => {
      if (!/^[1-9]\d*$/.test(n)) throw new Error(`--pr pide un número de PR, no "${n}".\nUso: ${prsRepublish.usage}`);
      return Number(n);
    });
    const client = await ctx.client();
    const projectId = values.project === undefined ? undefined : (await projectBySlug(client, values.project)).id;
    const results = await client.prs.republish({ projectId, prs, dryRun: values["dry-run"] ?? false, draftOnly: values.drafts ?? false });

    if (values.json) return ctx.write(JSON.stringify(results, null, 2));
    if (results.length === 0) return ctx.write("No hay PRs abiertos del sistema.");
    for (const r of results) {
      const target = r.branch === undefined ? "" : ` → ${r.branch}${r.newNumber ? ` (#${r.newNumber})` : ""}, base ${r.base}${r.commits === undefined ? "" : `, ${r.commits} commits`}`;
      ctx.write(`${r.status} ${r.repo}#${r.number}${target}${r.reason ? ` (${r.reason})` : ""}`);
    }
  },
};

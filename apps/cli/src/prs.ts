import { parseArgs } from "node:util";
import type { Command } from "./command";
import { projectBySlug } from "./projects";

/**
 * `clanker prs republish`: rehace los PRs abiertos del sistema con la branch, el autor y los commits de hoy (el PR
 * viejo queda cerrado y reemplazado). Con `--dry-run` solo lista `viejo → branch nueva`, sin tocar nada ni gastar.
 *
 * El core lanza las corridas y vuelve; aquí se consulta `prs.republishProgress` cada `POLL_MS` hasta que todos los PRs
 * tienen resultado (un hijo sale cuando su padre ya publicó). Ninguna llamada espera una corrida, así que no hay un
 * timeout HTTP que corte el lote. Cada línea sale en cuanto su PR termina.
 */
const POLL_MS = 2000;

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
    let progress = await client.prs.republish({ projectId, prs, dryRun: values["dry-run"] ?? false, draftOnly: values.drafts ?? false });
    const printed = new Set<number>();
    const print = () => {
      for (const r of progress.results) {
        if (r.status === "pending" || r.status === "running" || printed.has(r.number)) continue;
        printed.add(r.number);
        if (values.json) continue;
        const target = r.branch === undefined ? "" : ` → ${r.branch}${r.newNumber ? ` (#${r.newNumber})` : ""}, base ${r.base}${r.commits === undefined ? "" : `, ${r.commits} commits`}`;
        ctx.write(`${r.status} ${r.repo}#${r.number}${target}${r.reason ? ` (${r.reason})` : ""}`);
      }
    };
    if (!values.json && progress.results.length === 0) return ctx.write("No hay PRs abiertos del sistema.");
    print();
    while (!progress.done) {
      await ctx.sleep(POLL_MS);
      if (ctx.signal.aborted) throw new Error("Interrumpido: las corridas ya lanzadas siguen en el core y terminan solas.");
      progress = await client.prs.republishProgress({ id: progress.id });
      print();
    }
    if (values.json) ctx.write(JSON.stringify(progress.results, null, 2));
  },
};

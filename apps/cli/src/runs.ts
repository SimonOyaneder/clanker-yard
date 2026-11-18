import { parseArgs } from "node:util";
import { contract, RunId, type RunDetail } from "@clanker/api";
import type { Command } from "./command";
import { formatTable, usd } from "./format";
import { projectBySlug } from "./projects";
import { inputHelp, JSON_INPUT_USAGE, jsonInputOptions, readJsonInput, validateInput } from "./rpc";

const iso = (ms: number) => `${new Date(ms).toISOString().slice(0, 19)}Z`;

/** La corrida con sus pasos; los errores de los pasos van aparte porque son largos. */
function formatRun(run: RunDetail): string {
  const header: [string, string | null][] = [
    ["Corrida", run.id],
    ["Flujo", `${run.flow.slug}@${run.flow.version}`],
    ["Sujeto", `${run.subject.type} ${run.subject.id}`],
    ["Carril", run.lane],
    ["Estado", run.parkReason ? `${run.status} (${run.parkReason})` : run.status],
    ["Outcome", run.outcome],
    ["Costo", usd(run.costMicros / 1e6)],
    ["Inicio", iso(run.startedAt)],
    ["Fin", run.endedAt === null ? null : iso(run.endedAt)],
  ];
  const lines = header.flatMap(([label, value]) => (value === null ? [] : [`${`${label}:`.padEnd(9)} ${value}`]));

  if (run.steps.length > 0) {
    lines.push(
      "",
      formatTable([
        ["Paso", "Visita", "Estado", "Outcome", "Costo"],
        ...run.steps.map((s) => [s.nodeId, String(s.visit), s.status, s.outcome ?? "-", usd(s.costMicros / 1e6)]),
      ]),
    );
    for (const s of run.steps) if (s.error) lines.push(`Error en ${s.nodeId} (visita ${s.visit}): ${s.error}`);
  }
  return lines.join("\n");
}

const START_USAGE = `clanker runs start <proyecto> <issue> [--flow <slug>] [--json]\n  clanker runs start (${JSON_INPUT_USAGE})`;
const startInput = contract.runs.start["~orpc"].inputSchema!;

export const runsStart: Command = {
  usage: START_USAGE,
  help: () => `Con --input o --input-file devuelve JSON y recibe los ids del proyecto y la issue.\n\n${inputHelp(startInput)}`,
  async run(args, ctx) {
    const { values, positionals } = parseArgs({
      args,
      allowPositionals: true,
      options: { flow: { type: "string" }, json: { type: "boolean" }, ...jsonInputOptions },
    });
    if (values.input !== undefined || values["input-file"] !== undefined) {
      if (positionals.length || values.flow !== undefined) {
        throw new Error("No combines --input ni --input-file con argumentos posicionales o --flow.");
      }
      const input = await validateInput(startInput, readJsonInput(values, ctx)!);
      const run = await (await ctx.client()).runs.start(input, { signal: ctx.signal });
      return ctx.write(JSON.stringify(run, null, 2));
    }

    const [projectSlug, issueKey, ...extra] = positionals;
    if (projectSlug === undefined || issueKey === undefined || extra.length > 0) {
      throw new Error(`Faltan el proyecto y la issue (o sobran argumentos).\nUso: ${START_USAGE}`);
    }

    const client = await ctx.client();
    const project = await projectBySlug(client, projectSlug);
    const issue = (await client.issues.list({ projectId: project.id })).find(
      (i) => i.ref.key.toLowerCase() === issueKey.toLowerCase() || i.id === issueKey,
    );
    if (!issue) throw new Error(`No existe la issue "${issueKey}" en el proyecto "${projectSlug}".`);

    const run = await client.runs.start({ projectId: project.id, issueId: issue.id, flow: values.flow });
    if (values.json) return ctx.write(JSON.stringify(run, null, 2));
    ctx.write(formatRun(run));
    ctx.write(`\nSigue el progreso con: clanker events tail --run ${run.id} --follow`);
  },
};

export const runsGet: Command = {
  usage: "clanker runs get <id> [--json]",
  async run(args, ctx) {
    const { values, positionals } = parseArgs({ args, allowPositionals: true, options: { json: { type: "boolean" } } });
    const [id, ...extra] = positionals;
    if (id === undefined || extra.length > 0) throw new Error("Falta el id de la corrida.\nUso: clanker runs get <id> [--json]");
    const runId = RunId.safeParse(id);
    if (!runId.success) throw new Error(`"${id}" no es un id de corrida (run_...).`);

    const run = await (await ctx.client()).runs.get({ id: runId.data });
    ctx.write(values.json ? JSON.stringify(run, null, 2) : formatRun(run));
  },
};

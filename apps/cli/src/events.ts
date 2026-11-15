import { parseArgs } from "node:util";
import { type Client, type Event, type EventFilter, EventType, RunId } from "@clanker/api";
import type { Command } from "./cli";
import { projectBySlug } from "./projects";

const PAGE = 500;

const USAGE = "clanker events tail [--run <id>] [--project <slug>] [--type <tipo>]... [-n <líneas>] [--follow] [--json]";

function formatEvent(e: Event): string {
  const payload = Object.keys(e.payload).length > 0 ? ` ${JSON.stringify(e.payload)}` : "";
  const run = e.runId ? ` ${e.runId}` : "";
  return `${new Date(e.ts).toISOString().slice(0, 19)}Z #${e.seq} ${e.type.padEnd(20)} ${e.origin.padEnd(6)}${run}${payload}`.trimEnd();
}

/**
 * Los últimos `lines` eventos del filtro y el `seq` del último que existe. La API solo pagina hacia
 * adelante (`events.list` con `after`), así que recorre todo el filtro conservando la cola.
 */
async function lastEvents(client: Client, filter: EventFilter, lines: number): Promise<{ tail: Event[]; lastSeq: number }> {
  const tail: Event[] = [];
  let lastSeq = 0;
  for (;;) {
    const page = await client.events.list({ after: lastSeq, limit: PAGE, filter });
    tail.push(...page);
    tail.splice(0, Math.max(0, tail.length - lines));
    lastSeq = page.at(-1)?.seq ?? lastSeq;
    if (page.length < PAGE) return { tail, lastSeq };
  }
}

export const events: Command = {
  usage: USAGE,
  async run(args, ctx) {
    const { values } = parseArgs({
      args,
      options: {
        run: { type: "string" },
        project: { type: "string" },
        type: { type: "string", multiple: true },
        lines: { type: "string", short: "n", default: "20" },
        follow: { type: "boolean", short: "f" },
        json: { type: "boolean" },
      },
    });
    const lines = Number(values.lines);
    if (!Number.isInteger(lines) || lines < 0) throw new Error(`-n debe ser un entero desde 0, no "${values.lines}".`);
    const runId = values.run === undefined ? undefined : RunId.safeParse(values.run);
    if (runId && !runId.success) throw new Error(`"${values.run}" no es un id de corrida (run_...).`);
    const types = (values.type ?? []).map((t) => {
      const parsed = EventType.safeParse(t);
      if (!parsed.success) throw new Error(`Tipo de evento desconocido "${t}". Son de la forma entidad.verbo, por ejemplo run.finished.`);
      return parsed.data;
    });

    const client = await ctx.client();
    const filter: EventFilter = {
      runId: runId?.data,
      projectId: values.project === undefined ? undefined : (await projectBySlug(client, values.project)).id,
      types: types.length > 0 ? types : undefined,
    };
    const print = (e: Event) => ctx.write(values.json ? JSON.stringify(e) : formatEvent(e));

    const { tail, lastSeq } = await lastEvents(client, filter, lines);
    tail.forEach(print);
    if (!values.follow) return;

    try {
      // Desde `lastSeq`: lo que pasó entre el recorrido y esta suscripción no se pierde ni se repite.
      for await (const e of await client.events.stream({ after: lastSeq, filter }, { signal: ctx.signal })) print(e);
    } catch (error) {
      // Ctrl+C es la forma de salir de --follow, no un fallo.
      if (!ctx.signal.aborted) throw error;
    }
  },
};

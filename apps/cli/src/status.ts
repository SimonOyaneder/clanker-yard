import { parseArgs } from "node:util";
import type { Command } from "./command";

export const status: Command = {
  usage: "clanker status [--json]",
  async run(args, ctx) {
    const { values } = parseArgs({ args, options: { json: { type: "boolean" } } });
    const client = await ctx.client();
    const [health, info] = await Promise.all([client.system.health(), client.system.info()]);

    if (values.json) return ctx.write(JSON.stringify({ ...health, ...info }, null, 2));
    ctx.write(`Core ${health.coreVersion} corriendo (pid ${info.pid}, api ${health.apiMajor}, esquema ${health.schemaVersion})`);
    ctx.write(`Datos: ${info.dataDir}`);
    ctx.write(`Corridas activas: ${health.activeRuns}`);
  },
};

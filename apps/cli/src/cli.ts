import type { CliContext, Command } from "./command";
import { events } from "./events";
import { importLegacy } from "./import";
import { mcp } from "./mcp";
import { metricsCompareCommand } from "./metrics-compare";
import { projectsList } from "./projects";
import { prsRepublish } from "./prs";
import { prsListLocal, prsShowLocal } from "./prs-local";
import { runsGet, runsStart } from "./runs";
import { status } from "./status";

const commands: Record<string, Command> = {
  status,
  "projects list": projectsList,
  "runs start": runsStart,
  "runs get": runsGet,
  "events tail": events,
  "metrics compare": metricsCompareCommand,
  "import legacy": importLegacy,
  "prs list-local": prsListLocal,
  "prs show-local": prsShowLocal,
  "prs republish": prsRepublish,
  mcp,
};

const help = `Uso:\n${Object.values(commands)
  .map((c) => `  ${c.usage}`)
  .join("\n")}`;

/** Ejecuta un comando; lanza con un mensaje listo para mostrar si algo falla. */
export async function runCli(argv: string[], ctx: CliContext): Promise<void> {
  const [first, second] = argv;
  if (first === undefined || first === "--help" || first === "-h" || first === "help") return ctx.write(help);

  const name = Object.hasOwn(commands, first) ? first : `${first} ${second}`;
  const command = Object.hasOwn(commands, name) ? commands[name] : undefined;
  if (!command) throw new Error(`Comando desconocido: clanker ${argv.slice(0, 2).join(" ")}\n${help}`);

  try {
    await command.run(argv.slice(name.split(" ").length), ctx);
  } catch (error) {
    // Un flag mal puesto (`parseArgs`) se explica mejor con el uso del comando.
    if ((error as NodeJS.ErrnoException).code?.startsWith("ERR_PARSE_ARGS")) {
      throw new Error(`${(error as Error).message.split(".")[0]}.\nUso: ${command.usage}`);
    }
    throw error;
  }
}

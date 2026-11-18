import type { CliContext, Command } from "./command";
import { events } from "./events";
import { importLegacy } from "./import";
import { mcp } from "./mcp";
import { metricsCompareCommand } from "./metrics-compare";
import { projectsArchive, projectsList } from "./projects";
import { prsRepublish } from "./prs";
import { prsApplyLocal, prsEditLocal, prsListLocal, prsPublishLocal, prsShowLocal } from "./prs-local";
import { rpcCommands } from "./rpc";
import { runsGet, runsStart } from "./runs";
import { status } from "./status";

const commands: Record<string, Command> = {
  status,
  "projects list": projectsList,
  "projects archive": projectsArchive,
  "runs start": runsStart,
  "runs get": runsGet,
  "events tail": events,
  "metrics compare": metricsCompareCommand,
  "import legacy": importLegacy,
  "prs list-local": prsListLocal,
  "prs show-local": prsShowLocal,
  "prs edit-local": prsEditLocal,
  "prs apply-local": prsApplyLocal,
  "prs publish-local": prsPublishLocal,
  "prs republish": prsRepublish,
  mcp,
};

for (const [name, command] of rpcCommands()) {
  // Los comandos con argumentos y formatos propios conservan su interfaz.
  if (!Object.hasOwn(commands, name)) commands[name] = command;
}

const helpFor = (entries: Command[]) => `Uso:\n${entries
  .map((c) => `  ${c.usage}`)
  .join("\n")}`;
const help = helpFor(Object.values(commands));
const isHelp = (arg: string | undefined) => arg === "--help" || arg === "-h";

/** Ejecuta un comando; lanza con un mensaje listo para mostrar si algo falla. */
export async function runCli(argv: string[], ctx: CliContext): Promise<void> {
  const [first, second] = argv;
  if (first === undefined || isHelp(first) || first === "help") return ctx.write(help);

  if (second === undefined || isHelp(second)) {
    const entries = Object.entries(commands).filter(([name]) => name.startsWith(`${first} `));
    if (entries.length) return ctx.write(helpFor(entries.map(([, command]) => command)));
  }

  const name = Object.hasOwn(commands, first) ? first : `${first} ${second}`;
  const command = Object.hasOwn(commands, name) ? commands[name] : undefined;
  if (!command) throw new Error(`Comando desconocido: clanker ${argv.slice(0, 2).join(" ")}\n${help}`);

  const args = argv.slice(name.split(" ").length);
  if (args.length === 1 && isHelp(args[0])) {
    const details = command.help?.();
    return ctx.write(`${helpFor([command])}${details ? `\n\n${details}` : ""}`);
  }

  try {
    await command.run(args, ctx);
  } catch (error) {
    // Un flag mal puesto (`parseArgs`) se explica mejor con el uso del comando.
    if ((error as NodeJS.ErrnoException).code?.startsWith("ERR_PARSE_ARGS")) {
      throw new Error(`${(error as Error).message.split(".")[0]}.\nUso: ${command.usage}`);
    }
    throw error;
  }
}

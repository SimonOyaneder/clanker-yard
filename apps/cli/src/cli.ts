import type { Client } from "@clanker/api";
import { events } from "./events";
import { importLegacy } from "./import";
import { mcp } from "./mcp";
import { metricsCompareCommand } from "./metrics-compare";
import { projectsList } from "./projects";
import { prsRepublish } from "./prs";
import { runsGet, runsStart } from "./runs";
import { status } from "./status";

/** Lo que un comando necesita del mundo; `main.ts` lo arma con el core real y los tests con uno de prueba. */
export interface CliContext {
  /** El cliente del core. Lo levanta si no corre, así que un comando lo pide después de validar sus argumentos. */
  client(): Promise<Client>;
  /** Dónde está el MCP del core (`/mcp`) y el token que pide. Lo levanta si no corre. */
  mcpEndpoint(): Promise<{ url: string; token: string }>;
  /** Una línea de salida. */
  write(line: string): void;
  readFile(path: string): string;
  /** Espera `ms`; vuelve antes si se aborta `signal`. */
  sleep(ms: number): Promise<void>;
  /** Se aborta con Ctrl+C: es lo que termina un `events tail --follow`. */
  signal: AbortSignal;
}

export interface Command {
  /** `clanker <comando> <args>`, tal como se muestra en la ayuda y en los errores de uso. */
  usage: string;
  run(args: string[], ctx: CliContext): Promise<void>;
}

const commands: Record<string, Command> = {
  status,
  "projects list": projectsList,
  "runs start": runsStart,
  "runs get": runsGet,
  "events tail": events,
  "metrics compare": metricsCompareCommand,
  "import legacy": importLegacy,
  "prs republish": prsRepublish,
  mcp,
};

const help = `Uso:\n${Object.values(commands)
  .map((c) => `  ${c.usage}`)
  .join("\n")}`;

/** Ejecuta un comando; lanza con un mensaje listo para mostrar si algo falla. */
export async function runCli(argv: string[], ctx: CliContext): Promise<void> {
  const [first, second] = argv;
  if (
    first === undefined ||
    first === "--help" ||
    first === "-h" ||
    first === "help"
  )
    return ctx.write(help);

  const name = Object.hasOwn(commands, first) ? first : `${first} ${second}`;
  const command = Object.hasOwn(commands, name) ? commands[name] : undefined;
  if (!command)
    throw new Error(
      `Comando desconocido: clanker ${argv.slice(0, 2).join(" ")}\n${help}`,
    );

  try {
    await command.run(argv.slice(name.split(" ").length), ctx);
  } catch (error) {
    // Un flag mal puesto (`parseArgs`) se explica mejor con el uso del comando.
    if ((error as NodeJS.ErrnoException).code?.startsWith("ERR_PARSE_ARGS")) {
      throw new Error(
        `${(error as Error).message.split(".")[0]}.\nUso: ${command.usage}`,
      );
    }
    throw error;
  }
}

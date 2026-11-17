import type { Client } from "@clanker/api";

// El contrato de un comando de `clanker`: cada uno vive en su archivo y `cli.ts` solo los junta.

/** Lo que un comando necesita del mundo; `main.ts` lo arma con el core real y los tests con uno de prueba. */
export interface CliContext {
  /** El cliente del core. Lo levanta si no corre, así que un comando lo pide después de validar sus argumentos. */
  client(): Promise<Client>;
  /** Dónde está el MCP del core (`/mcp`) y el token que pide. Lo levanta si no corre, y cada llamada lo vuelve a buscar: puerto y token cambian en cada arranque. */
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

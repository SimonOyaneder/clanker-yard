import { spawn } from "node:child_process";
import { killGroup, type Procs } from "../../procs/procs";

/** Lo que tarda `opencode serve` en decir dónde escucha; carga plugins y MCP del usuario, así que puede tardar. */
export const SERVE_START_TIMEOUT_MS = 30_000;

/** opencode 1 decía "opencode server listening on", opencode 2 "server listening on". */
const LISTENING = /listening on (https?:\/\/\S+)/i;
const OUTPUT_TAIL_CHARS = 2000;

export interface LaunchInput {
  executable: string;
  args: string[];
  env: Record<string, string>;
  cwd: string;
  /** Con `procs`, el servidor (y los comandos del agente, que son sus hijos) queda en su grupo y registrado. */
  procs?: Procs;
  stepRunId?: string;
  killAfterMs?: number;
}

export interface OpencodeServer {
  url: string;
  /** Lo último que el servidor escribió: cuando muere, la causa está ahí. */
  output(): string;
  /** Resuelve cuando el proceso terminó solo (un crash): con el código y la cola de su salida. */
  exited: Promise<string>;
  /** Baja el grupo entero: el servidor y lo que lanzó el agente. */
  close(): void;
}

/** Lanza un servidor de opencode para un run, en su propio grupo de procesos (`detached`), y espera a que escuche. */
export type LaunchServer = (input: LaunchInput) => Promise<OpencodeServer>;

export const launchOpencodeServer: LaunchServer = ({ executable, args, env, cwd, procs, stepRunId, killAfterMs }) => {
  const child = spawn(executable, args, { cwd, env, detached: true, stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
  procs?.track(child, { kind: "agent", stepRunId });
  let output = "";
  const remember = (chunk: Buffer) => {
    output = (output + chunk.toString()).slice(-OUTPUT_TAIL_CHARS);
  };
  child.stdout.on("data", remember);
  child.stderr.on("data", remember);

  let closing = false;
  const exited = new Promise<string>((resolve) => {
    child.once("close", (code, signal) => resolve(`opencode serve terminó (${signal ?? `código ${code}`}): ${output.trim() || "sin salida"}`));
  });

  const close = () => {
    if (closing) return;
    closing = true;
    killGroup(child, killAfterMs);
  };

  return new Promise<OpencodeServer>((resolve, reject) => {
    const timer = setTimeout(() => {
      close();
      reject(new Error(`opencode serve no empezó a escuchar en ${SERVE_START_TIMEOUT_MS / 1000} s: ${output.trim() || "sin salida"}`));
    }, SERVE_START_TIMEOUT_MS);
    const onData = () => {
      const match = LISTENING.exec(output);
      if (!match?.[1]) return;
      clearTimeout(timer);
      child.stdout.off("data", onData);
      resolve({ url: match[1], output: () => output.trim(), exited, close });
    };
    child.stdout.on("data", onData);
    child.once("error", (error) => {
      clearTimeout(timer);
      reject(
        (error as NodeJS.ErrnoException).code === "ENOENT"
          ? new Error(`No encuentro "${executable}" en el PATH del core: instala opencode (https://opencode.ai) o quita opencode del perfil.`)
          : error,
      );
    });
    void exited.then((reason) => {
      clearTimeout(timer);
      reject(new Error(reason));
    });
  });
};

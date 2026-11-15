import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

/** `git` salió con error. `output` es lo que el usuario vería en la terminal: stdout y stderr (un hook imprime en cualquiera). */
export class GitError extends Error {
  constructor(
    message: string,
    readonly stdout: string,
    readonly stderr: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
  }

  get output(): string {
    return [this.stdout, this.stderr].filter((text) => text.trim() !== "").join("\n");
  }
}

/** Corre `git` en `cwd` y devuelve stdout tal cual: a un patch sin su salto final `git apply` lo rechaza. */
export async function gitRaw(cwd: string, args: string[], env: Record<string, string> = {}): Promise<string> {
  try {
    const { stdout } = await execFileAsync("git", args, {
      cwd,
      env: { ...process.env, ...env },
      encoding: "utf8",
      maxBuffer: 256 * 1024 * 1024,
    });
    return stdout;
  } catch (error) {
    const { stdout = "", stderr = "" } = error as { stdout?: string; stderr?: string };
    throw new GitError(`git ${args.join(" ")} falló en ${cwd}: ${stderr.trim() || String(error)}`, stdout, stderr, {
      cause: error,
    });
  }
}

/** Como `gitRaw`, sin el salto de línea final. */
export async function git(cwd: string, args: string[], env: Record<string, string> = {}): Promise<string> {
  return (await gitRaw(cwd, args, env)).trimEnd();
}

/** `undefined` si git sale con error: para preguntas de existencia, donde el error es la respuesta. */
export async function tryGit(cwd: string, args: string[]): Promise<string | undefined> {
  try {
    return await git(cwd, args);
  } catch {
    return undefined;
  }
}

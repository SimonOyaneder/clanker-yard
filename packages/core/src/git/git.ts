import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { pickEnv } from "../procs/env";

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

/**
 * Lo único que hereda del core un `git` local. El core puede traer `GH_TOKEN`, `ANTHROPIC_API_KEY` y otros
 * secretos de la shell que lanzó la app, y en un worktree los hooks (`git commit`) y el config del repo
 * (`core.fsmonitor` corre en cualquier `add` o `diff`) los escribe el agente.
 */
const INHERITED_ENV = ["PATH", "HOME", "USER", "LANG", "TMPDIR", "SHELL"];

/** Lo que el `fetch` de `origin` con las credenciales del usuario necesita además (agente SSH y proxies). */
export const USER_REMOTE_ENV = ["SSH_AUTH_SOCK", "GIT_SSH_COMMAND", "HTTPS_PROXY", "https_proxy", "NO_PROXY", "no_proxy"];

/**
 * Corre `git` en `cwd` y devuelve stdout tal cual: a un patch sin su salto final `git apply` lo rechaza.
 * Hereda solo `INHERITED_ENV`, más `env`. `input` va a su stdin.
 */
export async function gitRaw(cwd: string, args: string[], env: Record<string, string> = {}, input?: string): Promise<string> {
  try {
    const running = execFileAsync("git", args, {
      cwd,
      env: { ...pickEnv(INHERITED_ENV), ...env },
      encoding: "utf8",
      maxBuffer: 256 * 1024 * 1024,
    });
    if (input !== undefined) running.child.stdin?.end(input);
    return (await running).stdout;
  } catch (error) {
    const { stdout = "", stderr = "" } = error as { stdout?: string; stderr?: string };
    throw new GitError(`git ${args.join(" ")} falló en ${cwd}: ${stderr.trim() || String(error)}`, stdout, stderr, {
      cause: error,
    });
  }
}

/** Como `gitRaw`, sin el salto de línea final. */
export async function git(cwd: string, args: string[], env: Record<string, string> = {}, input?: string): Promise<string> {
  return (await gitRaw(cwd, args, env, input)).trimEnd();
}

/** `undefined` si git sale con error: para preguntas de existencia, donde el error es la respuesta. */
export async function tryGit(cwd: string, args: string[]): Promise<string | undefined> {
  try {
    return await git(cwd, args);
  } catch {
    return undefined;
  }
}

/** `merge-base --is-ancestor`. Que `ancestor` no exista en el repo también es "no". */
export async function isAncestor(cwd: string, ancestor: string, descendant: string): Promise<boolean> {
  return (await tryGit(cwd, ["merge-base", "--is-ancestor", ancestor, descendant])) !== undefined;
}

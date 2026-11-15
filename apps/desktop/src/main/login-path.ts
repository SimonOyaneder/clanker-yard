import { execFileSync } from "node:child_process";
import { delimiter } from "node:path";

const START = "__clanker_path_start__";
const END = "__clanker_path_end__";

/**
 * El `PATH` de la shell de login del usuario sumado al actual. Una app abierta desde el Dock o Spotlight
 * hereda un `PATH` mínimo (`/usr/bin:/bin:...`) y el core, que hereda el de la app, no encontraría
 * `claude`, `gh` ni el `git` de Homebrew. Si la shell no contesta se deja el `PATH` como está.
 */
export function withLoginPath(
  env: NodeJS.ProcessEnv,
  run: (shell: string, args: string[]) => string = (shell, args) => execFileSync(shell, args, { encoding: "utf8", timeout: 5_000 }),
): string {
  const shell = env.SHELL ?? "/bin/zsh";
  let output: string;
  try {
    output = run(shell, ["-ilc", `printf '%s' "${START}$PATH${END}"`]);
  } catch (error) {
    console.error(`login-path: ${shell} no entregó el PATH`, error);
    return env.PATH ?? "";
  }
  // Un .zshrc ruidoso imprime antes o después: solo vale lo que va entre las marcas.
  const start = output.indexOf(START);
  const end = output.indexOf(END, start);
  if (start === -1 || end === -1) return env.PATH ?? "";
  const seen = new Set<string>();
  return [...output.slice(start + START.length, end).split(delimiter), ...(env.PATH ?? "").split(delimiter)]
    .filter((dir) => dir !== "" && !seen.has(dir) && seen.add(dir))
    .join(delimiter);
}

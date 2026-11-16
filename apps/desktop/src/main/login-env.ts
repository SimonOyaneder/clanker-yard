import { execFileSync } from "node:child_process";
import { delimiter } from "node:path";

const START = "__clanker_env_start__";
const SEP = "__clanker_env_sep__";
const END = "__clanker_env_end__";
// `printenv` y no `$PATH`: da lo exportado tal cual en cualquier shell (fish expande `$PATH` con espacios).
const PRINT_ENV = `printf '%s' '${START}'; printenv PATH; printf '%s' '${SEP}'; printenv LANG; printf '%s' '${END}'`;

/** El locale de Terminal en un Mac en inglés: siempre existe. */
const FALLBACK_LANG = "en_US.UTF-8";

/**
 * `PATH` y `LANG` para el core de una app abierta desde el Dock o Spotlight, que hereda de launchd un `PATH`
 * mínimo (`/usr/bin:/bin:...`) y ningún `LANG`. Sin el `PATH` de la shell de login el core no encuentra
 * `claude`, `gh` ni el `git` de Homebrew; sin `LANG` los checks y los agentes corren en el locale C (Ruby lee
 * en US-ASCII). El `PATH` es el de la shell sumado al actual, solo con carpetas absolutas (una relativa como
 * `./bin` haría que el core corra el `git` del worktree en que trabaja). `LANG` es el actual, el de la shell o
 * `en_US.UTF-8`, en ese orden. Si la shell no contesta, el `PATH` queda como está.
 */
export function loginEnv(
  env: NodeJS.ProcessEnv,
  run: (shell: string, args: string[]) => string = (shell, args) => execFileSync(shell, args, { encoding: "utf8", timeout: 5_000 }),
): { PATH: string; LANG: string } {
  const shell = env.SHELL ?? "/bin/zsh";
  const current = (env.PATH ?? "").split(delimiter);
  const fallback = { PATH: absolute(current), LANG: env.LANG || FALLBACK_LANG };
  let output: string;
  try {
    output = run(shell, ["-ilc", PRINT_ENV]);
  } catch (error) {
    console.error(`login-env: ${shell} no entregó su entorno`, error);
    return fallback;
  }
  // Un .zshrc ruidoso imprime antes o después: solo vale lo que va entre las marcas.
  const start = output.indexOf(START);
  const end = output.indexOf(END, start);
  if (start === -1 || end === -1) {
    console.error(`login-env: ${shell} no imprimió su entorno entre las marcas`);
    return fallback;
  }
  const [path = "", lang = ""] = output.slice(start + START.length, end).split(SEP).map((s) => s.trim());
  return { PATH: absolute([...path.split(delimiter), ...current]), LANG: env.LANG || lang || FALLBACK_LANG };
}

function absolute(dirs: string[]): string {
  const seen = new Set<string>();
  return dirs.filter((dir) => dir.startsWith("/") && !seen.has(dir) && seen.add(dir)).join(delimiter);
}

import { lstatSync, mkdirSync, rmSync, symlinkSync } from "node:fs";
import { delimiter, join } from "node:path";

export interface CliLink {
  link: string;
  /** `binDir` está en el `PATH` del main: si no, una terminal nueva todavía no encuentra el comando. */
  onPath: boolean;
}

/**
 * Deja `clanker` en `binDir` apuntando al lanzador de la app (`resources/clanker`). Reemplaza un
 * symlink anterior (la app se pudo mover); un archivo que no es symlink lo respeta y lanza.
 */
export function linkCli(opts: { launcher: string; binDir: string; pathEnv?: string }): CliLink {
  const link = join(opts.binDir, "clanker");
  mkdirSync(opts.binDir, { recursive: true });
  const existing = lstatSync(link, { throwIfNoEntry: false });
  if (existing && !existing.isSymbolicLink()) {
    throw new Error(`${link} ya existe y no es un symlink: bórralo o muévelo y vuelve a intentar.`);
  }
  if (existing) rmSync(link);
  symlinkSync(opts.launcher, link);
  return { link, onPath: (opts.pathEnv ?? "").split(delimiter).includes(opts.binDir) };
}

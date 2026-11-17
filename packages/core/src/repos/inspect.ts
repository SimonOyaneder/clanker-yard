import { existsSync, readdirSync, realpathSync, statSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { git } from "../git/git";
import { BadRequestError } from "../errors/domain";

/** Lo que se sabe de un checkout de git sin que nadie lo haya registrado. */
export interface RepoInfo {
  /** La raíz del checkout, sin symlinks. */
  path: string;
  name: string;
  defaultBranch: string;
  /** `owner/name` si `origin` es de GitHub. */
  remote: string | null;
}

/** La ruta no es la raíz de un repo de git: el mensaje dice qué pasó. */
export class NotAGitRepoError extends BadRequestError {}

/** Solo lee el repo del usuario: sin los locks opcionales que estorbarían a su git. */
const READ_ONLY = { GIT_OPTIONAL_LOCKS: "0" };

const GITHUB_REMOTE = /^(?:https:\/\/(?:[^@/]+@)?github\.com\/|git@github\.com:|ssh:\/\/git@github\.com\/)([^/\s]+)\/([^/\s]+?)(?:\.git)?\/?$/;

/** Mira el repo de `path`, que debe ser su raíz. */
export async function inspectRepo(path: string): Promise<RepoInfo> {
  const root = resolveDir(path);
  const toplevel = await git(root, ["rev-parse", "--show-toplevel"], READ_ONLY).catch(() => {
    throw new NotAGitRepoError(`${root} no es un repo de git.`);
  });
  if (realpathSync(toplevel) !== root) {
    throw new NotAGitRepoError(`${root} no es la raíz de un repo de git: la raíz es ${toplevel}.`);
  }
  return {
    path: root,
    // El nombre es el de la carpeta como se pidió, no el del destino de un symlink.
    name: basename(resolve(path)),
    defaultBranch: await defaultBranchOf(root),
    remote: parseGitHubRemote(await git(root, ["remote", "get-url", "origin"], READ_ONLY).catch(() => "")),
  };
}

/** Los repos de git de `folder`: ella misma si es un repo; si no, sus subcarpetas directas que lo son. Por nombre. */
export async function findRepos(folder: string): Promise<RepoInfo[]> {
  const root = resolveDir(folder);
  if (existsSync(join(root, ".git"))) return [await inspectRepo(root)];
  const children = readdirSync(root, { withFileTypes: true })
    .filter((entry) => !entry.name.startsWith(".") && existsSync(join(root, entry.name, ".git")))
    .map((entry) => join(root, entry.name))
    .sort();
  return Promise.all(children.map(inspectRepo));
}

function resolveDir(path: string): string {
  let real: string;
  try {
    real = realpathSync(path);
  } catch {
    throw new NotAGitRepoError(`No existe la carpeta ${path}.`);
  }
  if (!statSync(real).isDirectory()) throw new NotAGitRepoError(`${path} no es una carpeta.`);
  return real;
}

/** `origin/HEAD` si el clon lo tiene; si no, `main` o `master` si existen, y por último la branch actual. */
async function defaultBranchOf(root: string): Promise<string> {
  const originHead = await git(root, ["symbolic-ref", "--short", "refs/remotes/origin/HEAD"], READ_ONLY).catch(() => "");
  if (originHead.startsWith("origin/")) return originHead.slice("origin/".length);
  for (const name of ["main", "master"]) {
    if (await git(root, ["rev-parse", "--verify", "--quiet", `refs/heads/${name}`], READ_ONLY).then(() => true, () => false)) return name;
  }
  return (await git(root, ["symbolic-ref", "--short", "HEAD"], READ_ONLY).catch(() => "")) || "main";
}

export function parseGitHubRemote(url: string): string | null {
  const match = GITHUB_REMOTE.exec(url.trim());
  return match ? `${match[1]}/${match[2]}` : null;
}

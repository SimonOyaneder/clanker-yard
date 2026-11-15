import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

export interface CommitSpec {
  message: string;
  /** Ruta relativa al repo -> contenido. Sin archivos, el commit va vacío. */
  files?: Record<string, string>;
}

export interface TempGitRepoOptions {
  /** Commits sobre `main`, en orden. Por defecto, un solo commit inicial. */
  commits?: CommitSpec[];
  /** Ramas que salen del último commit de `main`, con sus propios commits. */
  branches?: Record<string, CommitSpec[]>;
  /** Crea un remoto bare local como `origin` y le empuja `main` y las ramas. */
  remote?: boolean;
}

export interface TempGitRepo {
  /** Working tree, con `main` como rama activa. */
  dir: string;
  /** Ruta del remoto bare, o `undefined` sin `remote`. */
  remoteDir: string | undefined;
  /** Corre git dentro de `dir` y devuelve stdout sin el salto final. Lanza si git falla. */
  git(...args: string[]): string;
  /** Borra el repo y su remoto. */
  cleanup(): void;
}

/** Git aislado de la configuración del usuario (firma, hooks globales, rama inicial). */
const GIT_ENV = {
  ...process.env,
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_SYSTEM: "/dev/null",
  GIT_AUTHOR_NAME: "Clanker Test",
  GIT_AUTHOR_EMAIL: "test@clanker.invalid",
  GIT_COMMITTER_NAME: "Clanker Test",
  GIT_COMMITTER_EMAIL: "test@clanker.invalid",
};

function runGit(cwd: string, args: string[]): string {
  try {
    return execFileSync("git", args, { cwd, env: GIT_ENV, encoding: "utf8", stdio: "pipe" }).trimEnd();
  } catch (error) {
    const { stderr } = error as { stderr?: string };
    throw new Error(`git ${args.join(" ")} falló en ${cwd}: ${stderr?.trim() ?? String(error)}`, {
      cause: error,
    });
  }
}

function commit(dir: string, { message, files = {} }: CommitSpec): void {
  for (const [path, content] of Object.entries(files)) {
    const full = join(dir, path);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, content);
  }
  runGit(dir, ["add", "--all"]);
  runGit(dir, ["commit", "--allow-empty", "--message", message]);
}

/**
 * Repo git real en un directorio temporal, para probar Workspaces sin tocar ningún repo del usuario.
 * Con `remote`, `origin` es un bare local: push, fetch y clone funcionan sin red.
 */
export function tempGitRepo(opts: TempGitRepoOptions = {}): TempGitRepo {
  const { commits = [{ message: "chore: initial commit" }], branches = {}, remote = false } = opts;
  const root = mkdtempSync(join(tmpdir(), "clanker-git-"));
  try {
    const dir = join(root, "work");
    mkdirSync(dir);
    runGit(dir, ["init", "--initial-branch=main"]);
    for (const spec of commits) commit(dir, spec);

    for (const [branch, branchCommits] of Object.entries(branches)) {
      runGit(dir, ["checkout", "-b", branch, "main"]);
      for (const spec of branchCommits) commit(dir, spec);
    }
    runGit(dir, ["checkout", "main"]);

    let remoteDir: string | undefined;
    if (remote) {
      remoteDir = join(root, "remote.git");
      runGit(root, ["init", "--bare", "--initial-branch=main", remoteDir]);
      runGit(dir, ["remote", "add", "origin", remoteDir]);
      runGit(dir, ["push", "--set-upstream", "origin", "main"]);
      for (const branch of Object.keys(branches)) {
        runGit(dir, ["push", "--set-upstream", "origin", branch]);
      }
    }

    return {
      dir,
      remoteDir,
      git: (...args) => runGit(dir, args),
      cleanup: () => rmSync(root, { recursive: true, force: true }),
    };
  } catch (error) {
    rmSync(root, { recursive: true, force: true });
    throw error;
  }
}

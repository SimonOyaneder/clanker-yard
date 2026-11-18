import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { GitError } from "../git/git";
import { excerpt } from "./exec";

// La mecánica de git del rebase de un PR (`docs/design.html#d-ops`, rebasePr). Las precondiciones y lo
// que se guarda en la base lo hace `workspaces.rebase`.

/** Commits con conflicto que un solo rebase admite: más es un agente dando vueltas o un PR que no se resuelve. */
export const MAX_CONFLICTED_COMMITS = 20;

type Git = (...args: string[]) => Promise<string>;

/**
 * - `done`: el rebase terminó y la branch está sobre la base nueva.
 * - `conflict`: el rebase quedó detenido en un commit (HEAD detached): `conflicts` son los archivos que
 *   hay que resolver y `applying` el commit que se estaba aplicando.
 * - `error`: falló sin conflicto; ya se hizo `--abort` y la branch quedó como estaba.
 */
export type RebaseStep =
  | { status: "done" }
  | { status: "conflict"; applying: string | undefined; conflicts: string[]; failures: string }
  | { status: "error"; failures: string };

/** `git rebase` de `HEAD` sobre `onto`; con `from`, solo los commits que siguen a `from` (`--onto onto from`). */
export async function startRebase(git: Git, { onto, from }: { onto: string; from?: string }): Promise<RebaseStep> {
  try {
    await git("rebase", ...OFF, ...(from === undefined ? [onto] : ["--onto", onto, from]));
    return { status: "done" };
  } catch (error) {
    return afterFailure(git, error);
  }
}

/**
 * Sigue un rebase detenido por conflicto, un commit a la vez: si en los archivos que cambió el worktree
 * quedan marcas `<<<<<<<` o `>>>>>>>`, no avanza y los devuelve como `conflict`; si no, los agrega al
 * index y corre `rebase --continue`. Un rebase con más de `MAX_CONFLICTED_COMMITS` commits con conflicto
 * se aborta (`error`): el conteo vive en la carpeta del propio rebase, que git borra al terminar.
 */
export async function continueRebase(git: Git): Promise<RebaseStep> {
  const marked = await withMarkers(git);
  if (marked.length > 0) {
    return {
      status: "conflict",
      applying: await applyingCommit(git),
      conflicts: marked,
      failures: `Quedan marcas de conflicto (<<<<<<< o >>>>>>>) en ${marked.join(", ")}: resuélvelas antes de continuar.`,
    };
  }

  const counter = join(await rebaseDir(git), CONFLICTS_FILE);
  const conflicted = (existsSync(counter) ? Number(readFileSync(counter, "utf8")) : 0) + 1;
  if (conflicted > MAX_CONFLICTED_COMMITS) {
    await git("rebase", "--abort");
    return {
      status: "error",
      failures: `El rebase pasó por más de ${MAX_CONFLICTED_COMMITS} commits con conflicto: se abortó y la branch quedó como estaba.`,
    };
  }
  writeFileSync(counter, String(conflicted));

  await git("add", "--all");
  try {
    await git("-c", "core.editor=true", "rebase", "--continue");
    return { status: "done" };
  } catch (error) {
    return afterFailure(git, error);
  }
}

/** Hay un rebase detenido en este worktree. */
export async function rebaseInProgress(git: Git): Promise<boolean> {
  return existsSync(await rebaseDir(git));
}

/** La base sobre la que el rebase en curso está aplicando los commits. */
export async function rebaseOnto(git: Git): Promise<string> {
  return readFileSync(join(await rebaseDir(git), "onto"), "utf8").trim();
}

/**
 * Lo que ~/.gitconfig podría prender y cambiaría el resultado: sin `autostash` el rebase se niega con
 * cambios sin commitear, y sin `updateRefs` no mueve otras branches.
 */
const OFF = ["--no-autostash", "--no-update-refs"];

const CONFLICTS_FILE = "clanker-conflicted";

/** La carpeta del rebase `merge` de este worktree: existe solo mientras hay uno en curso. */
async function rebaseDir(git: Git): Promise<string> {
  return join(await git("rev-parse", "--absolute-git-dir"), "rebase-merge");
}

/** Un rebase que falló: con conflicto queda detenido para resolverlo; sin conflicto se aborta. */
async function afterFailure(git: Git, error: unknown): Promise<RebaseStep> {
  if (!(error instanceof GitError)) throw error;
  const conflicts = (await rebaseInProgress(git)) ? await unmerged(git) : [];
  if (conflicts.length === 0) {
    // Sin un rebase en curso `--abort` falla: git ya lo había descartado.
    await git("rebase", "--abort").catch(() => undefined);
    return { status: "error", failures: `El rebase falló sin conflictos y la branch quedó como estaba.\n${excerpt(error.output)}` };
  }
  return {
    status: "conflict",
    applying: await applyingCommit(git),
    conflicts,
    failures: [`Conflicto en ${conflicts.join(", ")}.`, "Las marcas <<<<<<< están en los archivos del worktree.", excerpt(error.output)].join("\n"),
  };
}

async function unmerged(git: Git): Promise<string[]> {
  return (await git("-c", "core.quotePath=false", "diff", "--name-only", "--diff-filter=U")).split("\n").filter(Boolean);
}

/** El commit que el rebase detenido estaba aplicando (`REBASE_HEAD`). */
async function applyingCommit(git: Git): Promise<string | undefined> {
  return git("rev-parse", "--verify", "--quiet", "REBASE_HEAD").catch(() => undefined);
}

/**
 * Los archivos de texto que el rebase en curso tiene cambiados contra `HEAD` (con o sin `git add`: un
 * archivo agregado con marcas ya no figura como sin mergear) y todavía traen marcas de conflicto.
 */
export async function withMarkers(git: Git): Promise<string[]> {
  const root = await git("rev-parse", "--show-toplevel");
  const changed = (await git("-c", "core.quotePath=false", "diff", "--name-only", "HEAD")).split("\n").filter(Boolean);
  return changed.filter((path) => {
    const file = join(root, path);
    if (!existsSync(file)) return false;
    const content = readFileSync(file);
    return !content.includes(0) && MARKER.test(content.toString("utf8"));
  });
}

const MARKER = /^(<{7}|>{7})( |$)/m;

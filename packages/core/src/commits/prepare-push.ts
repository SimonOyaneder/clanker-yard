import { GitError, isAncestor } from "../git/git";
import { snapshotTree } from "../git/tree";
import { cleanMessage, CONVENTIONAL_COMMIT } from "./apply";
import { FIXUP_PREFIX } from "./route";
import { excerpt } from "../workspaces/exec";
import type { Workspaces, WorkspaceRef } from "../workspaces/workspaces";

export interface PreparePushOptions {
  /** Lo último que el core sabe de la branch (la punta que dejó `commits.apply` o la que pusheó). */
  knownSha: string;
  /**
   * La base actual de la branch (una ref o un sha). Su merge-base con `HEAD` acota lo que el squash
   * puede reescribir: nunca los commits que ya son de la base.
   */
  base: string;
  /** El PR tuvo threads `[clanker-council]`: sus `fixup!` quedan visibles, no se reescribe nada. */
  council: boolean;
  /** Regex que debe cumplir la primera línea de cada commit del agente (sin `fixup! `). Por defecto, Conventional Commits. */
  messagePattern?: string;
}

/**
 * - `ok`: `head` es lo que hay que pushear; `squashed` dice si el squash reescribió commits.
 * - `replan`: los commits que el agente hizo por su cuenta no cuadran; `failures` va de vuelta al
 *   committer. La branch quedó en `knownSha` y todo lo del agente es ahora un cambio sin commitear.
 * - `squash-failed`: el squash no pudo (conflicto, árbol distinto, `fixup!` sin destino). La branch
 *   quedó como estaba y `failures` es el extracto.
 */
export type PreparePushResult =
  | { outcome: "ok"; head: string; squashed: boolean }
  | { outcome: "replan"; failures: string }
  | { outcome: "squash-failed"; failures: string };

/**
 * Lo que va antes de cada push (`docs/design.html#d-ops`, push y squash): reconcilia los commits que
 * el agente haya hecho por su cuenta y deja la branch sin `fixup!` (autosquash local) salvo en un PR
 * con council. No pushea: el push con lease es `workspaces.push`, que con council tampoco fuerza.
 *
 * Un commit del agente se acepta si `HEAD` desciende de `knownSha`, su árbol es el del worktree
 * (nada quedó sin commitear) y cada mensaje cumple `messagePattern` sin líneas de atribución a una IA,
 * como los de `commits.apply` (el agente puede commitear con su propia firma). Si no, la branch vuelve a `knownSha` con `reset --mixed`: el worktree
 * no cambia y el committer recibe todo el trabajo del agente como un diff por commitear.
 *
 * El squash pasa por `rebase --interactive --autosquash` con el editor de la secuencia en `true`
 * (`sequence.editor`; `core.editor` también, para que ningún mensaje abra un editor). Sin `autoStash` ni
 * `updateRefs` aunque el ~/.gitconfig los pida: con cambios sin commitear el rebase se niega (el
 * `reset --hard` de un squash fallido los borraría) y no mueve otras branches. Los subjects se
 * leen enteros en memoria: filtrarlos con un pipe y `grep -q` mata a `git log` con SIGPIPE y, bajo
 * `pipefail`, no ve un `fixup!` que es el último commit. Si el árbol cambia, hay conflicto o queda
 * algún `fixup!`, vuelve al sha anterior.
 */
export async function preparePush(
  workspaces: Workspaces,
  ws: WorkspaceRef,
  { knownSha, base, council, messagePattern }: PreparePushOptions,
): Promise<PreparePushResult> {
  const rejected = await reconcile(workspaces, ws, knownSha, messagePattern);
  if (rejected !== undefined) return { outcome: "replan", failures: rejected };
  if (council) return { outcome: "ok", head: await workspaces.git(ws, "rev-parse", "HEAD"), squashed: false };
  return squash(workspaces, ws, base);
}

/** Por qué los commits del agente no se aceptan; `undefined` si se aceptan (o no hay ninguno). */
async function reconcile(workspaces: Workspaces, ws: WorkspaceRef, knownSha: string, messagePattern: string | undefined): Promise<string | undefined> {
  const head = await workspaces.git(ws, "rev-parse", "HEAD");
  if (head === knownSha) return undefined;

  let reason: string | undefined;
  if (!(await isAncestor(ws.path, knownSha, head))) {
    reason = `HEAD ${head.slice(0, 9)} no desciende de ${knownSha.slice(0, 9)}, el último sha conocido: el agente reescribió la historia de la branch.`;
  } else if ((await snapshotTree(ws.path)) !== (await workspaces.git(ws, "rev-parse", "HEAD^{tree}"))) {
    const stat = await workspaces.git(ws, "diff", "--stat", "HEAD");
    reason = `El árbol de HEAD ${head.slice(0, 9)} no es el del worktree: el agente dejó cambios sin commitear.\n${excerpt(stat)}`;
  } else {
    reason = await messageProblems(workspaces, ws, knownSha, messagePattern);
  }
  if (reason === undefined) return undefined;

  await workspaces.git(ws, "reset", "--quiet", "--mixed", knownSha);
  return reason;
}

/**
 * Los commits del agente cuyo mensaje no cumple el patrón o lleva una línea de atribución a una IA. Un merge
 * no se revisa: su mensaje lo escribe git, y deshacerlo convertiría lo que trajo de la base en un diff a rutear.
 */
async function messageProblems(workspaces: Workspaces, ws: WorkspaceRef, knownSha: string, messagePattern: string | undefined): Promise<string | undefined> {
  const pattern = messagePattern === undefined ? CONVENTIONAL_COMMIT : new RegExp(messagePattern);
  const log = await workspaces.git(ws, "log", "--no-merges", "--format=%h%x00%B%x1e", `${knownSha}..HEAD`);
  const problems: string[] = [];
  for (const entry of log.split("\x1e")) {
    const [sha, body = ""] = entry.trim().split("\0");
    if (!sha) continue;
    const message = body.trim();
    const subject = message.split("\n")[0]!;
    let target = subject;
    while (target.startsWith(FIXUP_PREFIX)) target = target.slice(FIXUP_PREFIX.length);
    if (!pattern.test(target)) problems.push(`${sha} "${subject}": el mensaje no cumple ${pattern}`);
    else if (cleanMessage(message) !== message) problems.push(`${sha} "${subject}": el mensaje firma el commit como hecho por una IA`);
  }
  if (problems.length === 0) return undefined;
  return `Commits del agente con un mensaje que no se puede pushear; su trabajo vuelve sin commitear:\n${problems.join("\n")}`;
}

async function squash(workspaces: Workspaces, ws: WorkspaceRef, base: string): Promise<PreparePushResult> {
  const before = await workspaces.git(ws, "rev-parse", "HEAD");
  const mergeBase = await workspaces.git(ws, "merge-base", before, base);
  const hasFixup = async () => (await subjectsSince(workspaces, ws, mergeBase)).some((s) => s.startsWith(FIXUP_PREFIX));
  if (!(await hasFixup())) return { outcome: "ok", head: before, squashed: false };

  const failed = async (failures: string): Promise<PreparePushResult> => {
    // Sin un rebase en curso `--abort` falla: el rebase ya había terminado.
    await workspaces.git(ws, "rebase", "--abort").catch(() => undefined);
    if ((await workspaces.git(ws, "rev-parse", "HEAD")) !== before) await workspaces.git(ws, "reset", "--hard", before);
    return { outcome: "squash-failed", failures };
  };

  const treeBefore = await workspaces.git(ws, "rev-parse", `${before}^{tree}`);
  try {
    await workspaces.git(
      ws,
      "-c",
      "sequence.editor=true",
      "-c",
      "core.editor=true",
      "rebase",
      "--interactive",
      "--autosquash",
      "--no-autostash",
      "--no-update-refs",
      mergeBase,
    );
  } catch (error) {
    if (!(error instanceof GitError)) throw error;
    return failed(`El autosquash falló y la branch volvió a ${before.slice(0, 9)}\n${excerpt(error.output)}`);
  }

  const head = await workspaces.git(ws, "rev-parse", "HEAD");
  if ((await workspaces.git(ws, "rev-parse", "HEAD^{tree}")) !== treeBefore) {
    return failed(`El autosquash cambió el árbol y la branch volvió a ${before.slice(0, 9)}`);
  }
  const left = (await subjectsSince(workspaces, ws, mergeBase)).filter((s) => s.startsWith(FIXUP_PREFIX));
  if (left.length > 0) {
    return failed(`Quedan fixup! sin commit destino y la branch volvió a ${before.slice(0, 9)}: ${left.join("; ")}`);
  }
  return { outcome: "ok", head, squashed: true };
}

async function subjectsSince(workspaces: Workspaces, ws: WorkspaceRef, from: string): Promise<string[]> {
  return (await workspaces.git(ws, "log", "--format=%s", `${from}..HEAD`)).split("\n");
}

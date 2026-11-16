import * as z from "zod";
import type { ActionDef } from "../flows/catalog";
import { rebaseInProgress } from "./rebase";
import { WorkspaceOutput, type Workspaces } from "./workspaces";

// Las acciones del rebase de un PR que solo tocan el worktree. `workspace.rebase`, que además lee el PR, está en
// `github/rebase-pr.ts`.

const RebaseAbortArgs = z.object({ ws: WorkspaceOutput });

/**
 * `workspace.rebaseAbort`: deja el worktree como estaba antes del rebase que el agente no pudo resolver, o
 * que una persona decidió no aplicar. Sin esto, la corrida termina con el rebase detenido y el próximo
 * `workspace.rebase` del PR lanza por "rebase en curso". Sin rebase en curso no hace nada. Output `aborted`.
 */
export function workspaceRebaseAbortAction(workspaces: Workspaces): ActionDef<typeof RebaseAbortArgs> {
  return {
    name: "workspace.rebaseAbort",
    args: RebaseAbortArgs,
    outcomes: ["ok"],
    effects: "local",
    async run({ ws }) {
      const git = (...args: string[]) => workspaces.git(ws, ...args);
      const aborted = await rebaseInProgress(git);
      if (aborted) await git("rebase", "--abort");
      return { outcome: "ok", output: { aborted } };
    },
  };
}

const CommitAfterRebaseArgs = z.object({ ws: WorkspaceOutput });

/** El mensaje del commit con lo que dejó el `afterRebase` de la receta (o un arreglo del agente tras un check rojo). */
const AFTER_REBASE_COMMIT_MESSAGE = "chore: update generated files after rebase";

/**
 * `workspace.commitAfterRebase`: commitea lo que `recipe.check` con `afterRebase` dejó en el worktree
 * (la versión de `schema.rb`, `packwerk update-todo`), y lo que el agente arregló tras un check rojo, en un
 * solo commit sobre los del PR: `pr.pushLease` no pushea lo que no está commiteado. Lo hace el core y no un
 * agente porque no hay nada que decidir: son los cambios que la receta o el check pidieron. Sin cambios no
 * hace nada. Output `committed` y `head`.
 */
export function workspaceCommitAfterRebaseAction(workspaces: Workspaces): ActionDef<typeof CommitAfterRebaseArgs> {
  return {
    name: "workspace.commitAfterRebase",
    args: CommitAfterRebaseArgs,
    outcomes: ["ok"],
    effects: "local",
    run: ({ ws }, ctx) =>
      ctx.once("commit", async () => {
        const git = (...args: string[]) => workspaces.git(ws, ...args);
        const dirty = (await git("status", "--porcelain")) !== "";
        if (dirty) {
          await git("add", "--all");
          await git("commit", "--quiet", "--message", AFTER_REBASE_COMMIT_MESSAGE);
        }
        return { outcome: "ok", output: { committed: dirty, head: await git("rev-parse", "HEAD") } };
      }),
  };
}

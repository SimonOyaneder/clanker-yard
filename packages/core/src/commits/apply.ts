import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as z from "zod";
import { PermanentActionError, type ActionCtx, type ActionDef, type ActionResult } from "../flows/catalog";
import { GitError, tryGit } from "../git/git";
import { diffBetween, listHunks, snapshotTree, type Hunk } from "../git/tree";
import type { Recipes } from "../recipe/recipe";
import { excerpt } from "../workspaces/exec";
import { splitMoves } from "./split-moves";
import { WorkspaceOutput, type Workspaces, type WorkspaceRef } from "../workspaces/workspaces";
import { messageOf } from "../errors/format";

/** Conventional Commits: el formato por defecto. Un pack que pida otro pasa su `messagePattern`. */
export const CONVENTIONAL_COMMIT = /^(feat|fix|refactor|docs|test|chore|perf|ci|build|style|revert)(\([^)]+\))?!?: \S/;

/**
 * Líneas que firman un commit como hecho por una IA: el core las saca, el plan no puede traerlas. Incluye el
 * link suelto a la sesión de Claude Code (`https://claude.ai/code/session_...`) que su atribución deja en un PR.
 */
const AI_ATTRIBUTION =
  /^(co-authored-by:.*\b(claude|anthropic|openai|copilot|gemini)\b|claude-session:|.*\bgenerated (with|by)\b.*\b(claude|anthropic|ai)\b|.*\bclaude\.ai\/code\b).*$/i;

export const ApplyArgs = z.object({
  /** El output de `workspace.acquire` (`$ws`). */
  ws: WorkspaceOutput,
  /**
   * El reporte del committer (`CommitPlan`) o lo que de él importa: `hunks` son ids de `hunks.json` y
   * `tests` los archivos de pruebas que deben pasar en ese commit, solos.
   */
  plan: z.object({
    commits: z.array(z.object({ message: z.string(), hunks: z.array(z.string()), tests: z.array(z.string()) })),
  }),
  /** Regex que debe cumplir la primera línea de cada mensaje. Por defecto, Conventional Commits. */
  messagePattern: z
    .string()
    .refine((source) => {
      try {
        new RegExp(source);
        return true;
      } catch {
        return false;
      }
    }, "no es una expresión regular válida")
    .optional(),
  /** El slot de entorno del worktree, para `{{slot}}` de la receta. */
  slot: z.int().positive().optional(),
});

/**
 * `commits.apply`: convierte el plan del committer en commits reales sin tocar el worktree hasta que
 * todo está verificado. Outcomes: `ok` (el output trae `commits` y `tree`), `replan` (el plan no se
 * puede aplicar o un commit no pasa sus tests: `failures` es lo que va de vuelta al committer, y el
 * flujo acota las vueltas con `maxRounds` en ese edge) y `hook-failed` (un hook del repo rechazó un
 * commit, decisión #36: `failures` va al dev).
 *
 * El árbol completo del worktree se guarda con `write-tree` en un index temporal. Los commits se hacen
 * en un worktree de verify separado, partiendo de la base: por commit, `git apply --index` de sus hunks
 * (el diff se parte igual que `hunks.json`), `git commit` (con los hooks del repo) y los tests del
 * commit con el comando `test` de la receta. Solo si el árbol del último commit es el guardado, la
 * branch del worktree se mueve a él (`reset --mixed`: el working tree no cambia). Cualquier otro final
 * deja el worktree como estaba; los commits sueltos los recoge el gc de git.
 *
 * Parte de la base del lease: un worktree con commits propios lanza, porque `hunks.json` lo planificó
 * contra la base. Eso y una receta inválida son `PermanentActionError`: el paso falla sin reintentos.
 */
export function commitsApplyAction({
  workspaces,
  recipes,
}: {
  workspaces: Workspaces;
  recipes: Recipes;
}): ActionDef<typeof ApplyArgs> {
  async function apply(
    { ws, plan, messagePattern, slot }: z.infer<typeof ApplyArgs>,
    ctx: ActionCtx,
  ): Promise<ActionResult> {
    // La vigente: `workspace.syncBase` pudo mover la base después de `workspace.acquire`.
    const baseSha = workspaces.baseSha(ws);
    const head = await workspaces.git(ws, "rev-parse", "HEAD");
    const saved = await snapshotTree(ws.path);
    // Reintentar no mueve la branch de vuelta a la base.
    if (head !== baseSha) {
      const made = await madeByPreviousRun(workspaces, ws, baseSha, plan.commits.map((c) => cleanMessage(c.message)), saved);
      if (made) return { outcome: "ok", output: { commits: made, tree: saved } };
      throw new PermanentActionError(
        `commits.apply parte de la base ${baseSha.slice(0, 9)}, pero ${ws.branch} ya está en ${head.slice(0, 9)}: ` +
          `el plan se hizo sobre hunks.json, que es el diff contra esa base.`,
      );
    }
    const hunks = listHunks(await diffBetween(ws.path, baseSha, saved));

    const messages = plan.commits.map((commit) => cleanMessage(commit.message));
    const problems = planProblems(plan.commits, messages, hunks, messagePattern);
    if (problems.length > 0) return { outcome: "replan", output: { failures: problems.join("\n") } };

    let recipe;
    try {
      recipe = recipes.read(ws.path);
    } catch (error) {
      // Una receta mal escrita no se arregla reintentando.
      throw new PermanentActionError(messageOf(error), { cause: error });
    }
    const dir = mkdtempSync(join(tmpdir(), "clanker-verify-"));
    const verify: WorkspaceRef = { ...ws, path: join(dir, "worktree") };
    try {
      await workspaces.git(ws, "worktree", "add", "--detach", verify.path, baseSha);
      for (const command of recipe?.setup?.worktree ?? []) {
        const setup = await workspaces.exec(verify, command, { runId: ctx.runId, stepId: ctx.stepId, signal: ctx.signal });
        if (setup.exitCode !== 0) {
          throw new Error(`setup.worktree falló en el worktree de verify: ${command} (exit ${setup.exitCode})\n${setup.extract}`);
        }
      }

      const made: { sha: string; message: string }[] = [];
      for (const [i, commit] of plan.commits.entries()) {
        const message = messages[i]!;
        const label = `commit ${i + 1} "${message.split("\n")[0]}"`;
        const patchPath = join(dir, `commit-${i + 1}.patch`);
        writeFileSync(patchPath, patchOf(commit.hunks.map((id) => hunks.find((h) => h.id === id)!), hunks));

        try {
          await workspaces.git(verify, "apply", "--index", "--whitespace=nowarn", patchPath);
        } catch (error) {
          if (!(error instanceof GitError)) throw error;
          return fail("replan", `[${label}] sus hunks no se aplican sobre los commits anteriores\n${excerpt(error.output)}`);
        }
        try {
          await workspaces.git(verify, "commit", "--message", message);
        } catch (error) {
          if (!(error instanceof GitError)) throw error;
          return fail("hook-failed", `[${label}] git commit falló (hooks del repo)\n${excerpt(error.output)}`);
        }
        made.push({ sha: await workspaces.git(verify, "rev-parse", "HEAD"), message });

        if (commit.tests.length > 0 && recipe?.commands.test !== undefined) {
          const test = await recipes.runCommand(verify, recipe, "test", { files: commit.tests, slot }, ctx);
          if (!test.ok) return fail("replan", `[${label}] test exit ${test.exitCode}\n${test.extract}`);
        }
      }

      const tree = await workspaces.git(verify, "rev-parse", "HEAD^{tree}");
      if (tree !== saved) {
        const stat = await workspaces.git(verify, "diff", "--stat", saved, "HEAD");
        return fail("replan", `El árbol de los commits no es el del worktree (¿un hook cambió archivos al commitear?)\n${excerpt(stat)}`);
      }
      // Mixed: la branch y el index pasan a los commits y el working tree, que ya es ese árbol, no se toca.
      if (made.length > 0) await workspaces.git(ws, "reset", "--quiet", "--mixed", made.at(-1)!.sha);
      return { outcome: "ok", output: { commits: made, tree } };
    } finally {
      await tryGit(ws.path, ["worktree", "remove", "--force", verify.path]);
      rmSync(dir, { recursive: true, force: true });
      await tryGit(ws.path, ["worktree", "prune"]);
    }
  }

  return {
    name: "commits.apply",
    args: ApplyArgs,
    outcomes: ["ok", "replan", "hook-failed"],
    effects: "local",
    // Una vez por visita: si el proceso cae justo después de mover la branch, el reintento devuelve ese resultado.
    run: (args, ctx) => ctx.once("apply", () => apply(args, ctx)),
  };
}

/**
 * Si el proceso cayó después de mover la branch y antes de guardar la etapa, el reintento llega con
 * los commits del plan ya hechos: los mismos mensajes, en orden, y el árbol del worktree. Entonces el
 * resultado es ese, no un error.
 */
async function madeByPreviousRun(
  workspaces: Workspaces,
  ws: WorkspaceRef,
  baseSha: string,
  messages: string[],
  tree: string,
): Promise<{ sha: string; message: string }[] | undefined> {
  if ((await workspaces.git(ws, "rev-parse", "HEAD^{tree}")) !== tree) return undefined;
  const log = await workspaces.git(ws, "log", "--reverse", "--format=%H%x00%B%x01", `${baseSha}..HEAD`);
  const made = log
    .split("\x01")
    .filter((entry) => entry.trim() !== "")
    .map((entry) => {
      const [sha = "", message = ""] = entry.split("\x00");
      return { sha: sha.trim(), message: message.trim() };
    });
  return made.length === messages.length && made.every((c, i) => c.message === messages[i]) ? made : undefined;
}

function fail(outcome: "replan" | "hook-failed", failures: string): ActionResult {
  return { outcome, output: { failures } };
}

/** Sin las líneas que firman un commit (o un PR) como hecho por una IA. */
export function cleanMessage(message: string): string {
  return message
    .split("\n")
    .filter((line) => !AI_ATTRIBUTION.test(line.trim()))
    .join("\n")
    .trim();
}

/** Lo que impide aplicar el plan, una línea por problema. Vacío: el plan cubre cada hunk una vez. */
function planProblems(
  commits: { hunks: string[] }[],
  messages: string[],
  hunks: Hunk[],
  messagePattern: string | undefined,
): string[] {
  const problems: string[] = [];
  const pattern = messagePattern === undefined ? CONVENTIONAL_COMMIT : new RegExp(messagePattern);
  const assigned = new Map<string, number>();
  for (const [i, commit] of commits.entries()) {
    const subject = messages[i]!.split("\n")[0]!;
    const label = `commit ${i + 1} "${subject}"`;
    if (!pattern.test(subject)) problems.push(`[${label}] el mensaje no cumple ${pattern}`);
    if (commit.hunks.length === 0) problems.push(`[${label}] no tiene hunks`);
    for (const id of commit.hunks) {
      const owner = assigned.get(id);
      if (!hunks.some((h) => h.id === id)) problems.push(`[${label}] usa el hunk ${id}, que no existe en hunks.json`);
      else if (owner !== undefined) problems.push(`[${label}] usa el hunk ${id}, que ya es del commit ${owner + 1}`);
      assigned.set(id, assigned.get(id) ?? i);
    }
  }
  problems.push(...splitMoves(hunks, assigned));
  const unassigned = hunks.filter((h) => !assigned.has(h.id));
  if (unassigned.length > 0) {
    const shown = unassigned.slice(0, 20).map((h) => `${h.id} ${h.path} ${h.header}`);
    const more = unassigned.length > shown.length ? `, y ${unassigned.length - shown.length} más` : "";
    problems.push(`Hunks sin asignar a ningún commit: ${shown.join("; ")}${more}`);
  }
  return problems;
}

/** El patch de `selected`, en el orden del diff: el encabezado de cada archivo una vez y sus hunks seguidos. */
export function patchOf(selected: Hunk[], all: Hunk[]): string {
  let patch = "";
  let fileHeader: string | undefined;
  for (const hunk of [...selected].sort((a, b) => all.indexOf(a) - all.indexOf(b))) {
    if (hunk.fileHeader !== fileHeader) patch += hunk.fileHeader;
    fileHeader = hunk.fileHeader;
    patch += hunk.body;
  }
  return patch;
}

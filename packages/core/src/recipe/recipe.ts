import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Recipe, renderTemplate, templateVariables, type RunId, type TemplateVars } from "@clanker/api";
import { desc, eq, inArray, sql } from "drizzle-orm";
import * as z from "zod";
import type { Artifacts } from "../artifacts/artifacts";
import type { Defs } from "../defs/defs";
import { DefValidationError } from "../defs/defs";
import { PermanentActionError, type ActionCtx, type ActionDef } from "../flows/catalog";
import type { SlotLease, Slots } from "../slots/slots";
import { agentSessions, runs, stepRuns, workspaces as workspaceRows } from "../store/schema";
import type { Store } from "../store/store";
import { excerpt } from "../workspaces/exec";
import { WorkspaceOutput, type Workspaces, type WorkspaceRef } from "../workspaces/workspaces";

export const RECIPE_PATH = ".clanker/recipe.json";

/** Lo que el runtime `fake` devuelve de `run.<comando>` del guion (`FakeRuntime.nextRecipeResult`). */
export interface ScriptedRecipe {
  nextRecipeResult(sessionId: string, command: string): { ok: boolean; extract?: string };
}

export interface RecipesOptions {
  store: Store;
  defs: Defs;
  workspaces: Workspaces;
  artifacts: Artifacts;
  /** Los pools de slots: `recipe.check` toma uno del carril de su corrida cuando la receta define `slots`. */
  slots: Slots;
  /** Con el runtime `fake`: `recipe.check` no corre los comandos, usa los resultados del guion. */
  fake?: ScriptedRecipe;
}

export interface Recipes {
  /** `readRecipe`. */
  read(dir: string): Recipe | undefined;
  /** La acción `recipe.check` para `flows.registerAction`. */
  checkAction: ActionDef<typeof CheckArgs>;
  /**
   * Corre el comando `name` de `recipe` (que debe tenerlo en `commands`) dentro de `ws.path`, con el
   * `env` y el `wrap` de la receta y `{{files}}` = `files`. Un exit distinto de 0 es un resultado. El
   * extracto queda como artefacto del paso de `ctx` (`role: check:<name>`). Con el runtime `fake`
   * no corre nada: consume `run.<name>` del guion.
   */
  runCommand(
    ws: WorkspaceRef,
    recipe: Pick<Recipe, "env" | "wrap" | "commands">,
    name: string,
    opts: { files: string[]; slot?: number },
    ctx: ActionCtx,
  ): Promise<CommandRun>;
}

const CheckArgs = z.object({
  /** El output de `workspace.acquire` (`$ws`). */
  ws: WorkspaceOutput,
  /** `changed`: `{{files}}` son los archivos que cambió la issue; `all`: `{{files}}` queda vacío. */
  scope: z.enum(["changed", "all"]),
  /**
   * El slot de entorno, para `{{slot}}`, cuando quien llama ya lo tiene y lo prepara. Sin él, si la receta
   * define `slots`, la acción toma uno del pool del carril de su corrida y lo suelta al terminar; si no
   * los define, una receta que usa `{{slot}}` falla.
   */
  slot: z.int().positive().optional(),
});

/** Un comando que corrió. `extract` son las últimas 60 líneas y `artifact` el hash con el que quedaron guardadas. */
export interface CommandRun {
  name: string;
  ok: boolean;
  exitCode: number;
  extract: string;
  artifact: string;
}

/** Los archivos de pruebas: un directorio `spec`, `test` o `__tests__`, o un `*_spec.rb`, `*.test.ts`... */
const SPEC_FILE = /(^|\/)(specs?|tests?|__tests__)\/|[._-](spec|test)\.[^/]+$/;

/** Un repo sin receta: ni entorno, ni wrap, ni checks. */
const NO_RECIPE = Recipe.parse({ version: 1 });

/** `.clanker/recipe.json` no es JSON. */
export class RecipeSyntaxError extends Error {}

/**
 * Lee y valida `.clanker/recipe.json` de `dir`. `undefined` si el repo no tiene receta: funciona
 * igual, sin slots, sin `wrap` y sin checks. Una receta inválida lanza `DefValidationError` con la
 * ruta de cada campo, o `RecipeSyntaxError` si ni siquiera es JSON.
 */
export function readRecipe(dir: string): Recipe | undefined {
  let text: string;
  try {
    text = readFileSync(join(dir, RECIPE_PATH), "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch (error) {
    throw new RecipeSyntaxError(`${RECIPE_PATH} de ${dir} no es JSON válido: ${(error as Error).message}`, { cause: error });
  }
  const parsed = Recipe.safeParse(json);
  if (!parsed.success) {
    throw new DefValidationError(
      "recipe",
      RECIPE_PATH,
      parsed.error.issues.map(({ path, message }) => ({ path, message })),
    );
  }
  return parsed.data;
}

export function createRecipes({ store, defs, workspaces, artifacts, slots, fake }: RecipesOptions): Recipes {
  defs.register("recipe", Recipe);

  /** Lo que cambió la issue: commits desde la base, cambios sin commit y archivos nuevos. Sin los borrados. */
  async function changedFiles(ws: WorkspaceRef, baseSha: string): Promise<string[]> {
    const git = (...args: string[]) => workspaces.git(ws, "-c", "core.quotePath=false", ...args);
    const tracked = await git("diff", "--name-only", "--no-renames", "--diff-filter=d", baseSha);
    const untracked = await git("ls-files", "--others", "--exclude-standard");
    return [...new Set([...tracked.split("\n"), ...untracked.split("\n")].filter(Boolean))].sort();
  }

  /**
   * La sesión de agente que terminó más recientemente en la corrida o en sus padres (un subflujo retoma la
   * sesión del dev de la corrida que lo llamó): el guion `fake` pone ahí los resultados de la receta.
   */
  function scriptedSession(ctx: ActionCtx): string {
    const lineage: RunId[] = [];
    for (let id: RunId | null = ctx.runId; id !== null; ) {
      lineage.push(id);
      id = store.db.select({ parent: runs.parentRunId }).from(runs).where(eq(runs.id, id)).get()?.parent ?? null;
    }
    const session = store.db
      .select({ ref: agentSessions.sessionRef })
      .from(agentSessions)
      .innerJoin(stepRuns, eq(agentSessions.stepRunId, stepRuns.id))
      .where(inArray(stepRuns.runId, lineage))
      .orderBy(desc(sql`coalesce(${agentSessions.endedAt}, ${agentSessions.startedAt})`), desc(agentSessions.id))
      .limit(1)
      .get();
    if (!session) {
      throw new Error(
        `Con el runtime fake, recipe.check usa el guion de la última sesión de agente de la corrida ${ctx.runId} y todavía no tiene ninguna.`,
      );
    }
    return session.ref;
  }

  /** El entorno, el prefijo y el sustituidor de variables de la receta para un comando con este `slot` y estos `files`. */
  function rendering(ws: WorkspaceRef, recipe: Pick<Recipe, "env" | "wrap">, { slot, files }: { slot?: number; files: string[] }) {
    const vars: TemplateVars = { slot, worktree: ws.path, branch: ws.branch, files, envKeys: Object.keys(recipe.env) };
    // Un `{{slot}}` sin slot no se arregla reintentando.
    const render = (template: string, shell: boolean) => {
      try {
        return renderTemplate(template, vars, { shell });
      } catch (error) {
        throw asPermanent(error);
      }
    };
    return {
      render,
      env: Object.fromEntries(Object.entries(recipe.env).map(([key, value]) => [key, render(value, false)])),
      wrap: recipe.wrap === undefined ? [] : [render(recipe.wrap, true)],
    };
  }

  async function runCommand(
    ws: WorkspaceRef,
    recipe: Pick<Recipe, "env" | "wrap" | "commands">,
    name: string,
    opts: { files: string[]; slot?: number },
    ctx: ActionCtx,
  ): Promise<CommandRun> {
    const { render, env, wrap } = rendering(ws, recipe, opts);
    const command = [...wrap, render(recipe.commands[name]!, true)].join(" ");

    let exitCode: number;
    let extract: string;
    if (fake) {
      const scripted = fake.nextRecipeResult(scriptedSession(ctx), name);
      exitCode = scripted.ok ? 0 : 1;
      extract = excerpt(scripted.extract ?? "");
    } else {
      ({ exitCode, extract } = await workspaces.exec(ws, command, {
        runId: ctx.runId,
        stepId: ctx.stepId,
        env,
        signal: ctx.signal,
      }));
    }
    const artifact = artifacts.put(extract, "log_excerpt");
    artifacts.ref(artifact, { type: "step_run", id: ctx.stepId, role: `check:${name}` });
    return { name, ok: exitCode === 0, exitCode, extract, artifact };
  }

  /** El slot del pool del carril de la corrida, para el worktree `ws`. */
  function acquireSlot(ws: WorkspaceRef, pools: NonNullable<Recipe["slots"]>, ctx: ActionCtx): Promise<SlotLease> {
    const run = store.db.select({ lane: runs.lane }).from(runs).where(eq(runs.id, ctx.runId)).get();
    const workspace = store.db.select({ repoId: workspaceRows.repoId }).from(workspaceRows).where(eq(workspaceRows.id, ws.workspaceId)).get();
    if (!run || !workspace) {
      throw new PermanentActionError(
        `No se puede tomar un slot: ${run ? `el workspace ${ws.workspaceId}` : `la corrida ${ctx.runId}`} no existe en la base.`,
      );
    }
    return slots.acquire({ repoId: workspace.repoId, lane: run.lane, runId: ctx.runId, pools, workspaceId: ws.workspaceId }, ctx.signal);
  }

  /**
   * Deja el slot listo para `ws`. Si lo preparó otro worktree, cambió el hash de `setup.slotKey` o un
   * setup anterior quedó a medias, corre `setup.guard` y recién después `setup.slot`: un guard que no calza
   * aborta (`PermanentActionError`) sin borrar nada. Devuelve el extracto del comando de `setup.slot` que
   * falló, o `undefined` si el slot quedó listo.
   */
  async function prepareSlot(
    ws: WorkspaceRef,
    recipe: Recipe,
    lease: SlotLease,
    ctx: ActionCtx,
  ): Promise<string | undefined> {
    const setup = recipe.setup;
    if (!setup || setup.slot.length === 0) return undefined;
    const setupHash = slotKeyHash(ws.path, setup.slotKey);
    if (!lease.dirty && lease.workspaceId === ws.workspaceId && lease.setupHash === setupHash) return undefined;

    const { render, env, wrap } = rendering(ws, recipe, { slot: lease.idx, files: [] });
    const run = (template: string) =>
      workspaces.exec(ws, [...wrap, render(template, true)].join(" "), { runId: ctx.runId, stepId: ctx.stepId, env, signal: ctx.signal });

    if (setup.guard) {
      const expected = render(setup.guard.expect, false);
      const { exitCode, extract } = await run(setup.guard.run);
      if (exitCode !== 0 || extract.trim() !== expected) {
        throw new PermanentActionError(
          `setup.guard no calza en el slot ${lease.idx}: se esperaba "${expected}" y ` +
            `${exitCode === 0 ? `salió "${extract.trim()}"` : `el comando salió con exit ${exitCode}\n${extract}`}. ` +
            "No se corrió setup.slot ni se borró nada.",
        );
      }
    }
    slots.startSetup(lease);
    for (const command of setup.slot) {
      const { exitCode, extract } = await run(command);
      if (exitCode !== 0) return `[setup.slot] ${command} exit ${exitCode}\n${extract}`;
    }
    slots.finishSetup(lease, { workspaceId: ws.workspaceId, setupHash, env });
    return undefined;
  }

  const checkAction: Recipes["checkAction"] = {
    name: "recipe.check",
    args: CheckArgs,
    outcomes: ["ok", "fail"],
    effects: "local",
    async run({ ws, scope, slot }, ctx) {
      let recipe;
      try {
        recipe = readRecipe(ws.path) ?? NO_RECIPE;
      } catch (error) {
        // Una receta mal escrita no se arregla reintentando.
        throw asPermanent(error);
      }
      // Con `slot` ya viene preparado por quien llama. Si no, el slot es de este paso: se toma aquí y se
      // suelta al terminar (también si falla), así una corrida que se estaciona nunca lo conserva.
      const lease = slot === undefined && recipe.slots ? await acquireSlot(ws, recipe.slots, ctx) : undefined;
      try {
        // Si el lease del slot se pierde, los comandos se matan.
        const stepCtx = lease ? { ...ctx, signal: AbortSignal.any([ctx.signal, lease.lost]) } : ctx;
        const changed = await changedFiles(ws, workspaces.baseSha(ws));
        const files = scope === "changed" ? changed : [];
        const specsChanged = changed.filter((file) => SPEC_FILE.test(file));

        // Con el runtime `fake` no se corre ningún comando, tampoco el setup.
        const setupFailure = lease && !fake ? await prepareSlot(ws, recipe, lease, stepCtx) : undefined;
        if (setupFailure !== undefined) return { outcome: "fail", output: { failures: setupFailure, specsChanged, checks: [] } };

        // Se corre en orden y se corta en el primer rojo: los checks siguientes casi siempre dependen de los
        // anteriores (un typecheck roto llena de ruido el lint y los tests), y así el agente recibe un solo extracto.
        const checks: Array<CommandRun | { name: string; skipped: true }> = [];
        for (const name of recipe.checks) {
          if (scope === "changed" && changed.length === 0 && templateVariables(recipe.commands[name]!).includes("files")) {
            checks.push({ name, skipped: true });
            continue;
          }
          const result = await ctx.once(`check:${name}`, () =>
            runCommand(ws, recipe, name, { files, slot: slot ?? lease?.idx }, stepCtx),
          );
          checks.push(result);
          if (!result.ok) break;
        }

        const failed = checks.find((c): c is CommandRun => "ok" in c && !c.ok);
        return {
          outcome: failed ? "fail" : "ok",
          output: {
            failures: failed ? `[${failed.name}] exit ${failed.exitCode}\n${failed.extract}` : "",
            specsChanged,
            checks: checks.map((c) => ("ok" in c ? { name: c.name, ok: c.ok, exitCode: c.exitCode, artifact: c.artifact } : c)),
          },
        };
      } finally {
        if (lease) slots.release(lease);
      }
    },
  };

  return { read: readRecipe, checkAction, runCommand };
}

/** El hash de los archivos de `setup.slotKey` en `dir`: nombre y contenido de cada uno, o que no existe. */
function slotKeyHash(dir: string, files: readonly string[]): string {
  const hash = createHash("sha256");
  for (const file of files) {
    let content: Buffer | string;
    try {
      content = readFileSync(join(dir, file));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw asPermanent(error);
      content = "\0missing";
    }
    hash.update(`${file}\0`).update(content).update("\0");
  }
  return hash.digest("hex");
}

function asPermanent(error: unknown): PermanentActionError {
  return new PermanentActionError(error instanceof Error ? error.message : String(error), { cause: error });
}

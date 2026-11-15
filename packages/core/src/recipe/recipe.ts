import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Recipe, renderTemplate, templateVariables, type TemplateVars } from "@clanker/api";
import { desc, eq } from "drizzle-orm";
import * as z from "zod";
import type { Artifacts } from "../artifacts/artifacts";
import type { Defs } from "../defs/defs";
import { DefValidationError } from "../defs/defs";
import type { ActionCtx, ActionDef } from "../flows/catalog";
import { agentSessions, stepRuns } from "../store/schema";
import type { Store } from "../store/store";
import { excerpt } from "../workspaces/exec";
import type { Workspaces, WorkspaceRef } from "../workspaces/workspaces";

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
  /** Con el runtime `fake`: `recipe.check` no corre los comandos, usa los resultados del guion. */
  fake?: ScriptedRecipe;
}

export interface Recipes {
  /**
   * Lee y valida `.clanker/recipe.json` de `dir`. `undefined` si el repo no tiene receta: funciona
   * igual, sin slots, sin `wrap` y sin checks. Una receta inválida lanza `DefValidationError` con la
   * ruta de cada campo.
   */
  read(dir: string): Recipe | undefined;
  /** La acción `recipe.check` para `flows.registerAction`. */
  checkAction: ActionDef<typeof CheckArgs>;
}

const CheckArgs = z.object({
  /** El output de `workspace.acquire` (`$ws`). */
  ws: z.object({
    workspaceId: z.string(),
    path: z.string(),
    branch: z.string(),
    baseSha: z.string(),
    fencingToken: z.int(),
  }),
  /** `changed`: `{{files}}` son los archivos que cambió la issue; `all`: `{{files}}` queda vacío. */
  scope: z.enum(["changed", "all"]),
  /** El slot de entorno del worktree, para `{{slot}}`. Sin él, una receta que lo usa falla. */
  slot: z.int().positive().optional(),
});

/** Un check que corrió. `extract` son las últimas 60 líneas y `artifact` el hash con el que quedaron guardadas. */
interface CheckRun {
  name: string;
  ok: boolean;
  exitCode: number;
  extract: string;
  artifact: string;
}

/** Los archivos de pruebas: un directorio `spec`, `test` o `__tests__`, o un `*_spec.rb`, `*.test.ts`... */
const SPEC_FILE = /(^|\/)(specs?|tests?|__tests__)\/|[._-](spec|test)\.[^/]+$/;

/** Un repo sin receta: ni entorno, ni wrap, ni checks. */
const NO_RECIPE: Pick<Recipe, "env" | "wrap" | "commands" | "checks"> = { env: {}, wrap: undefined, commands: {}, checks: [] };

export function createRecipes({ store, defs, workspaces, artifacts, fake }: RecipesOptions): Recipes {
  defs.register("recipe", Recipe);

  function read(dir: string): Recipe | undefined {
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
      throw new Error(`${RECIPE_PATH} de ${dir} no es JSON válido: ${(error as Error).message}`, { cause: error });
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

  /** Lo que cambió la issue: commits desde la base, cambios sin commit y archivos nuevos. Sin los borrados. */
  async function changedFiles(ws: WorkspaceRef, baseSha: string): Promise<string[]> {
    const git = (...args: string[]) => workspaces.git(ws, "-c", "core.quotePath=false", ...args);
    const tracked = await git("diff", "--name-only", "--no-renames", "--diff-filter=d", baseSha);
    const untracked = await git("ls-files", "--others", "--exclude-standard");
    return [...new Set([...tracked.split("\n"), ...untracked.split("\n")].filter(Boolean))].sort();
  }

  /** La sesión del agente que terminó antes de este paso: el guion `fake` pone ahí los resultados de la receta. */
  function scriptedSession(ctx: ActionCtx): string {
    const session = store.db
      .select({ ref: agentSessions.sessionRef })
      .from(agentSessions)
      .innerJoin(stepRuns, eq(agentSessions.stepRunId, stepRuns.id))
      .where(eq(stepRuns.runId, ctx.runId))
      .orderBy(desc(agentSessions.startedAt), desc(agentSessions.id))
      .limit(1)
      .get();
    if (!session) {
      throw new Error(
        `Con el runtime fake, recipe.check usa el guion de la última sesión de agente de la corrida ${ctx.runId} y todavía no tiene ninguna.`,
      );
    }
    return session.ref;
  }

  /** Corre un check y guarda su extracto como artefacto del paso. */
  async function runCheck(
    name: string,
    command: string,
    env: Record<string, string>,
    ws: WorkspaceRef,
    ctx: ActionCtx,
  ): Promise<CheckRun> {
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

  const checkAction: Recipes["checkAction"] = {
    name: "recipe.check",
    args: CheckArgs,
    outcomes: ["ok", "fail"],
    effects: "local",
    async run({ ws, scope, slot }, ctx) {
      const { env: recipeEnv, wrap: recipeWrap, commands, checks: names } = read(ws.path) ?? NO_RECIPE;
      const changed = await changedFiles(ws, ws.baseSha);
      const vars: TemplateVars = {
        slot,
        worktree: ws.path,
        branch: ws.branch,
        files: scope === "changed" ? changed : [],
        envKeys: Object.keys(recipeEnv),
      };
      const env = Object.fromEntries(
        Object.entries(recipeEnv).map(([key, value]) => [key, renderTemplate(value, vars, { shell: false })]),
      );
      const wrap = recipeWrap === undefined ? [] : [renderTemplate(recipeWrap, vars, { shell: true })];

      // Se corre en orden y se corta en el primer rojo: los checks siguientes casi siempre dependen de los
      // anteriores (un typecheck roto llena de ruido el lint y los tests), y así el agente recibe un solo extracto.
      const checks: Array<CheckRun | { name: string; skipped: true }> = [];
      for (const name of names) {
        const template = commands[name]!;
        if (scope === "changed" && changed.length === 0 && templateVariables(template).includes("files")) {
          checks.push({ name, skipped: true });
          continue;
        }
        const command = [...wrap, renderTemplate(template, vars, { shell: true })].join(" ");
        const result = await ctx.once(`check:${name}`, () => runCheck(name, command, env, ws, ctx));
        checks.push(result);
        if (!result.ok) break;
      }

      const failed = checks.find((c): c is CheckRun => "ok" in c && !c.ok);
      return {
        outcome: failed ? "fail" : "ok",
        output: {
          failures: failed ? `[${failed.name}] exit ${failed.exitCode}\n${failed.extract}` : "",
          specsChanged: changed.filter((file) => SPEC_FILE.test(file)),
          checks: checks.map((c) => ("ok" in c ? { name: c.name, ok: c.ok, exitCode: c.exitCode, artifact: c.artifact } : c)),
        },
      };
    },
  };

  return { read, checkAction };
}

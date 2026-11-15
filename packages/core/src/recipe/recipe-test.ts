import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { renderTemplate, type Origin, type Recipe, type RecipeTestPhase, type RecipeTestResult, type RecipeTestStep, type RepoId, type TemplateVars } from "@clanker/api";
import { git as runGit } from "../git/git";
import type { Procs } from "../procs/procs";
import type { SlotLease, Slots } from "../slots/slots";
import { newId } from "../store/conventions";
import type { Store } from "../store/store";
import { excerpt, execStreaming } from "../workspaces/exec";
import { RepoNotFoundError, type Repos } from "../workspaces/repos";
import { readRecipe, RECIPE_PATH } from "./recipe";

/** Una prueba que dura más se mata: un `setup` colgado no puede dejar la llamada abierta para siempre. */
export const RECIPE_TEST_TIMEOUT_MS = 30 * 60_000;
/** La salida en vivo sale en eventos de a lo más uno cada tanto, no uno por línea. */
export const OUTPUT_FLUSH_MS = 250;
const OUTPUT_FLUSH_CHARS = 8 * 1024;

/** No se puede probar la receta: el mensaje dice por qué (no hay receta, o ya hay una prueba corriendo). */
export class RecipeTestError extends Error {}

export interface RecipeTester {
  /**
   * Corre la receta de `repoId` sobre un worktree desechable (detached en `HEAD`, borrado al terminar):
   * `requires`, `setup.worktree`, `setup.guard` y `setup.slot`, en ese orden, con un slot libre del pool de
   * mantenimiento (se suelta al terminar; si la receta no define `slots` no hay slot y `{{slot}}` falla).
   * El slot queda sin dueño de su preparación, así el próximo uso corre `setup.slot` de nuevo. La salida va en vivo como `recipe.test_output` entre `recipe.test_started` y
   * `recipe.test_finished`. Un comando rojo corta la prueba (salvo `requires`, donde se prueban todos) y
   * es un resultado, no un error. Lanza `RepoNotFoundError`, `RecipeTestError` o el error de la receta
   * (`DefValidationError`, `RecipeSyntaxError`).
   */
  test(repoId: RepoId, origin: Origin): Promise<RecipeTestResult>;
}

export interface RecipeTesterOptions {
  store: Store;
  repos: Repos;
  slots: Slots;
  /** Los worktrees desechables viven en `<dataDir>/recipe-tests`. */
  dataDir: string;
  /** Donde se registran los comandos de la receta, para matar los que deje un crash. */
  procs?: Procs;
}

export function createRecipeTester({ store, repos, slots, dataDir, procs }: RecipeTesterOptions): RecipeTester {
  const running = new Set<RepoId>();

  return {
    async test(repoId, origin) {
      const repo = repos.get(repoId);
      if (!repo) throw new RepoNotFoundError(repoId);
      const recipe = readRecipe(repo.path);
      if (!recipe) throw new RecipeTestError(`${repo.name} no tiene ${RECIPE_PATH}: no hay nada que probar.`);
      if (running.has(repoId)) throw new RecipeTestError(`Ya hay una prueba de la receta de ${repo.name} en curso.`);
      running.add(repoId);

      const emit = (type: "recipe.test_started" | "recipe.test_output" | "recipe.test_finished", payload: Record<string, unknown>) =>
        store.tx((tx) => tx.emit({ type, origin, payload: { repoId, ...payload } }));
      const scratchRoot = join(dataDir, "recipe-tests");
      mkdirSync(scratchRoot, { recursive: true });
      const scratch = mkdtempSync(join(scratchRoot, "t-"));
      const worktree = join(scratch, "worktree");
      let worktreeAdded = false;
      let lease: SlotLease | undefined;
      try {
        if (recipe.slots) {
          // `repos.testRecipe` no es una corrida: el id solo nombra al dueño del slot.
          lease = slots.tryAcquire({ repoId, lane: "maintenance", runId: newId("run"), pools: recipe.slots });
          if (!lease) {
            throw new RecipeTestError(
              `Los ${recipe.slots.maintenance} slots de mantenimiento de ${repo.name} están ocupados: ` +
                "espera a que termine un rebase o un council e inténtalo de nuevo.",
            );
          }
        }
        // Sin hooks: `post-checkout` y compañía son del repo del usuario, no de esta prueba.
        await git(repo.path, "-c", "core.hooksPath=/dev/null", "worktree", "add", "--detach", worktree, "HEAD");
        worktreeAdded = true;
        emit("recipe.test_started", {});
        const result = await runRecipe(recipe, worktree, lease && { lease, slots }, (phase, text) => emit("recipe.test_output", { phase, text }), procs);
        emit("recipe.test_finished", { ok: result.ok });
        return result;
      } finally {
        if (lease) slots.release(lease);
        if (worktreeAdded) await git(repo.path, "worktree", "remove", "--force", worktree);
        rmSync(scratch, { recursive: true, force: true });
        running.delete(repoId);
      }
    },
  };
}

async function runRecipe(
  recipe: Recipe,
  worktree: string,
  slot: { lease: SlotLease; slots: Slots } | undefined,
  onOutput: (phase: RecipeTestPhase, text: string) => void,
  procs: Procs | undefined,
): Promise<RecipeTestResult> {
  const vars: TemplateVars = { slot: slot?.lease.idx, worktree, branch: "recipe-test", files: [], envKeys: Object.keys(recipe.env) };
  // Una receta que usa `{{slot}}` sin definir `slots` es un error de la receta, no del programa.
  const render = (template: string, shell: boolean) => {
    try {
      return renderTemplate(template, vars, { shell });
    } catch (error) {
      throw new RecipeTestError((error as Error).message, { cause: error });
    }
  };
  const env = Object.fromEntries(Object.entries(recipe.env).map(([key, value]) => [key, render(value, false)]));
  const wrap = recipe.wrap === undefined ? [] : [render(recipe.wrap, true)];
  const signal = AbortSignal.timeout(RECIPE_TEST_TIMEOUT_MS);
  const steps: RecipeTestStep[] = [];

  async function run(phase: RecipeTestPhase, name: string, command: string, expect?: string): Promise<boolean> {
    const pump = createOutputPump((text) => onOutput(phase, text));
    const { exitCode, output } = await execStreaming({
      cwd: worktree,
      command,
      env,
      onOutput: pump.push,
      signal,
      onSpawn: procs && ((child) => procs.track(child, { kind: "recipe" })),
    });
    pump.finish();
    const timedOut = signal.aborted;
    const mismatch = exitCode === 0 && expect !== undefined && output.trim() !== expect;
    const extract = timedOut
      ? `se pasó de ${RECIPE_TEST_TIMEOUT_MS / 60_000} min y se mató\n${excerpt(output)}`
      : mismatch
        ? `se esperaba "${expect}" y salió "${output.trim()}"`
        : excerpt(output);
    const ok = exitCode === 0 && !mismatch && !timedOut;
    steps.push({ phase, name, ok, exitCode, extract });
    return ok;
  }
  const wrapped = (template: string) => [...wrap, render(template, true)].join(" ");

  // `requires` se prueba entero: así se ve de una vez qué servicios faltan. El setup solo tiene sentido si están todos.
  let requiresOk = true;
  for (const { name, check } of recipe.requires) requiresOk = (await run("requires", name, render(check, true))) && requiresOk;
  if (!requiresOk) return { ok: false, steps };

  // El orden de una corrida real: `setup.worktree` al crear el worktree, y al tomar el slot el guard y después `setup.slot`.
  const { setup } = recipe;
  for (const template of setup?.worktree ?? []) {
    const command = wrapped(template);
    if (!(await run("setup.worktree", command, command))) return { ok: false, steps };
  }
  if (setup?.guard) {
    const command = wrapped(setup.guard.run);
    if (!(await run("guard", command, command, render(setup.guard.expect, false)))) return { ok: false, steps };
  }
  if (slot && (setup?.slot.length ?? 0) > 0) slot.slots.startSetup(slot.lease);
  for (const template of setup?.slot ?? []) {
    const command = wrapped(template);
    if (!(await run("setup.slot", command, command))) return { ok: false, steps };
  }
  // El slot ya no es de ningún worktree real: el próximo que lo tome corre `setup.slot` de nuevo.
  if (slot && (setup?.slot.length ?? 0) > 0) slot.slots.finishSetup(slot.lease, { workspaceId: null, setupHash: null, env });
  return { ok: true, steps };
}

/**
 * Junta la salida y la entrega a lo más cada `OUTPUT_FLUSH_MS` (o al juntar 8 KB). `push` corre dentro de
 * callbacks de streams y de un timer, donde un throw tumbaría el core: un fallo de `emit` se guarda y
 * `finish` lo lanza.
 */
function createOutputPump(emit: (text: string) => void) {
  let pending = "";
  let timer: NodeJS.Timeout | undefined;
  let failure: unknown;

  function flush() {
    clearTimeout(timer);
    timer = undefined;
    if (pending === "") return;
    const text = pending;
    pending = "";
    try {
      emit(text);
    } catch (error) {
      failure ??= error;
    }
  }

  return {
    push(text: string) {
      pending += text;
      if (pending.length >= OUTPUT_FLUSH_CHARS) flush();
      else timer ??= setTimeout(flush, OUTPUT_FLUSH_MS);
    },
    finish() {
      flush();
      if (failure !== undefined) throw failure;
    },
  };
}

/** El git del core (entorno mínimo: `worktree add` corre el hook post-checkout del repo), con su fallo como `RecipeTestError`. */
async function git(cwd: string, ...args: string[]): Promise<void> {
  try {
    await runGit(cwd, args);
  } catch (error) {
    throw new RecipeTestError((error as Error).message, { cause: error });
  }
}

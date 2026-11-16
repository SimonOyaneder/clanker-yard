import { renderTemplate, type RepoId } from "@clanker/api";
import { readRecipe } from "../recipe/recipe";
import { failedRequires } from "../recipe/requires";
import type { Connections } from "../connections/connections";
import type { Repos } from "../repos/repos";
import { execStreaming } from "../workspaces/exec";
import type { AgentRuntime } from "../agents/runtime";
import { CLAUDE_RUNTIME, GITHUB_SCOPE, REPO_SCOPE_PREFIX, runtimeScope } from "./breakers";
import { messageOf } from "../errors/format";

/** Una prueba de `requires` que se cuelga es una causa que sigue: no puede dejar al breaker sin reintentar. */
const REQUIRES_TIMEOUT_MS = 30_000;

export interface ProbeDeps {
  connections: Pick<Connections, "list" | "githubClient" | "markRevoked" | "testClaude">;
  repos: Pick<Repos, "get">;
  /** Los runtimes registrados: `claude-sdk` se prueba con su conexión y los demás con su `probe`. */
  runtimes: readonly Pick<AgentRuntime, "id" | "probe">[];
}

/**
 * La prueba barata de cada ámbito (`docs/design.html#d-ops`): `undefined` si la causa se fue, o por qué sigue.
 * - `github`: `GET /user` con cada cuenta conectada (un 401 la deja `revoked`; una cuota agotada falla igual).
 * - `runtime:claude-sdk`: `connections.testClaude` (de menor a mayor costo; la llamada mínima solo si el login y la versión están bien).
 * - `runtime:<otro>`: su `probe` (opencode: que esté instalado y sea de una versión que el core soporta). Sin `probe`, se da por bueno.
 * - `repo:<id>`: los `requires` de su receta, en el checkout del repo y con el mismo `env` que les da `recipe.check`
 *   (con el primer slot de dev si la receta tiene slots): una prueba que los corre distinto podría no pasar nunca y
 *   dejar el repo en pausa para siempre. Un repo que ya no está registrado no tiene nada que pausar.
 */
export function environmentProbe({ connections, repos, runtimes }: ProbeDeps): (scope: string) => Promise<string | undefined> {
  async function github(): Promise<string | undefined> {
    const accounts = connections.list().filter((c) => c.provider === "github");
    if (accounts.length === 0) return "No hay una cuenta de GitHub conectada.";
    for (const { account, status } of accounts) {
      if (status !== "active") return `La cuenta de GitHub ${account} está ${status}: reconéctala.`;
      try {
        await connections.githubClient(account).request("GET /user");
      } catch (error) {
        const status = (error as { status?: number }).status;
        if (status === 401) connections.markRevoked("github", account, "core");
        return `GitHub no responde bien con la cuenta ${account}: ${messageOf(error)}`;
      }
    }
    return undefined;
  }

  async function claude(): Promise<string | undefined> {
    const status = await connections.testClaude(undefined, "core");
    return status.state === "ready" ? undefined : (status.message ?? `Claude está ${status.state}.`);
  }

  async function repo(id: string): Promise<string | undefined> {
    const found = repos.get(id);
    if (!found) return undefined;
    const recipe = readRecipe(found.path);
    if (!recipe || recipe.requires.length === 0) return undefined;
    const vars = { worktree: found.path, branch: found.defaultBranch, files: [], envKeys: Object.keys(recipe.env), slot: recipe.slots && 1 };
    const env = Object.fromEntries(Object.entries(recipe.env).map(([key, value]) => [key, renderTemplate(value, vars, { shell: false })]));
    const signal = AbortSignal.timeout(REQUIRES_TIMEOUT_MS);
    const down = await failedRequires(
      recipe,
      (template) => renderTemplate(template, vars, { shell: true }),
      async (command) => (await execStreaming({ cwd: found.path, command, env, onOutput: () => {}, signal })).exitCode,
    );
    return down.length === 0 ? undefined : `No responde: ${down.join(", ")}.`;
  }

  return (scope) => {
    if (scope === GITHUB_SCOPE) return github();
    if (scope === runtimeScope(CLAUDE_RUNTIME) && runtimes.some((r) => r.id === CLAUDE_RUNTIME)) return claude();
    const runtime = runtimes.find((r) => scope === runtimeScope(r.id));
    if (runtime?.probe) return runtime.probe();
    if (scope.startsWith(REPO_SCOPE_PREFIX)) return repo(scope.slice(REPO_SCOPE_PREFIX.length) as RepoId);
    return Promise.resolve(undefined);
  };
}

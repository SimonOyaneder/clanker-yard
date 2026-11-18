/**
 * Los tests de integración pesados (repos git reales, el GitHub simulado, el core completo): son ~10% de los archivos
 * y ~65% del tiempo de la suite. `npm test` los deja fuera; `npm run test:slow` corre solo estos y `npm run test:all`
 * todo. `vitest related` (el check `test:related` de la receta) los incluye si tocan lo que cambió.
 *
 * Un archivo entra si en la suite completa pasa de ~60 s de trabajo. Rutas desde la raíz del repo.
 */
export const SLOW_TESTS = [
  "apps/cli/src/core.test.ts",
  "packages/core/src/daemon/daemon.test.ts",
  "packages/testkit/src/chat-scratch.test.ts",
  "packages/testkit/src/codex-runtime.test.ts",
  "packages/testkit/src/combined-base.test.ts",
  "packages/testkit/src/core.test.ts",
  "packages/testkit/src/git-remote.test.ts",
  "packages/testkit/src/mcp-write.test.ts",
  "packages/testkit/src/merge-strategy.test.ts",
  "packages/testkit/src/night.test.ts",
  "packages/testkit/src/pr-detail.test.ts",
  "packages/testkit/src/pr-publish.test.ts",
  "packages/testkit/src/pr-push-fixups.test.ts",
  "packages/testkit/src/pr-rebase.test.ts",
  "packages/testkit/src/pr-restack.test.ts",
  "packages/testkit/src/rebase-conflict-e2e.test.ts",
  "packages/testkit/src/repos.test.ts",
  "packages/testkit/src/republish-pr.test.ts",
  "packages/testkit/src/restack-e2e.test.ts",
  "packages/testkit/src/scheduler.test.ts",
  "packages/testkit/src/techlead-e2e.test.ts",
  "packages/testkit/src/workspaces-rebase.test.ts",
  "packages/testkit/src/workspaces.test.ts",
];

/**
 * Qué corre la suite: `fast` (por defecto) sin los lentos, `slow` solo ellos y `all` todo. Sale de `CLANKER_TESTS`.
 * Sin la variable, quien nombra archivos o carpetas (`vitest run packages/testkit/src/pr-restack.test.ts`) o pide
 * `vitest related` corre todo lo que pidió: los lentos solo se saltan en la corrida sin filtros.
 */
export type TestTier = "fast" | "slow" | "all";

const SUBCOMMANDS = new Set(["run", "list", "watch", "dev", "related", "bench"]);

export function testTier(value = process.env.CLANKER_TESTS, argv = process.argv.slice(2)): TestTier {
  if (value === "slow" || value === "all" || value === "fast") return value;
  if (value !== undefined && value !== "") throw new Error(`CLANKER_TESTS=${value}: usa fast, slow o all`);
  // Cualquier argumento suelto que no es un subcomando cuenta como filtro; el valor de una opción (`--project ui`) también,
  // y lo único que cuesta es correr los lentos de ese proyecto.
  const filtered = argv.includes("related") || argv.some((arg) => !arg.startsWith("-") && !SUBCOMMANDS.has(arg));
  return filtered ? "all" : "fast";
}

import { existsSync, globSync, readFileSync } from "node:fs";
import { availableParallelism } from "node:os";
import { dirname, join, relative } from "node:path";
import { configDefaults, defineConfig } from "vitest/config";
import { SLOW_TESTS, testTier } from "./vitest.slow.ts";

const maxWorkers = process.env.CI ? 4 : Math.min(6, Math.max(1, availableParallelism() - 1));
const projects = globSync(["apps/*/package.json", "packages/*/package.json"], { cwd: import.meta.dirname }).map((file) => ({
  root: dirname(file),
  name: JSON.parse(readFileSync(join(import.meta.dirname, file), "utf8")).name as string,
}));
projects.push({ root: "scripts", name: "scripts" });

// `npm test` deja fuera los tests pesados de `vitest.slow.ts`; `test:slow` corre solo esos y `test:all` todo.
const tier = testTier();
const slowIn = (root: string) => SLOW_TESTS.filter((file) => file.startsWith(`${root}/`)).map((file) => relative(root, file));
const tiered = (root: string) =>
  tier === "fast" ? { exclude: [...configDefaults.exclude, ...slowIn(root)] } : tier === "slow" ? { include: slowIn(root) } : {};

// Vitest aplica el paralelismo por proyecto. Los proyectos por ruta no heredan el límite de la raíz.
export default defineConfig({
  root: import.meta.dirname,
  test: {
    maxWorkers,
    projects: projects
      .filter(({ root }) => tier !== "slow" || slowIn(root).length > 0)
      .map(({ root, name }) => ({
        root,
        extends: ["vitest.config.ts", "vite.config.ts"].map((file) => join(import.meta.dirname, root, file)).find(existsSync) ?? false,
        test: { name, maxWorkers, ...tiered(root) },
      })),
  },
});

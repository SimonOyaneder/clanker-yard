import { existsSync, globSync, readFileSync } from "node:fs";
import { availableParallelism } from "node:os";
import { dirname, join } from "node:path";
import { defineConfig } from "vitest/config";

const maxWorkers = process.env.CI ? 4 : Math.min(6, Math.max(1, availableParallelism() - 1));
const projects = globSync(["apps/*/package.json", "packages/*/package.json"], { cwd: import.meta.dirname }).map((file) => ({
  root: dirname(file),
  name: JSON.parse(readFileSync(join(import.meta.dirname, file), "utf8")).name as string,
}));
projects.push({ root: "scripts", name: "scripts" });

// Vitest aplica el paralelismo por proyecto. Los proyectos por ruta no heredan el límite de la raíz.
export default defineConfig({
  root: import.meta.dirname,
  test: {
    maxWorkers,
    projects: projects.map(({ root, name }) => ({
      root,
      extends: ["vitest.config.ts", "vite.config.ts"].map((file) => join(import.meta.dirname, root, file)).find(existsSync) ?? false,
      test: { name, maxWorkers },
    })),
  },
});

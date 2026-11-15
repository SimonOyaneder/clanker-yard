import { defineConfig } from "vitest/config";

// Cada app y paquete es un proyecto de Vitest; si necesita config propia, la deja en su carpeta.
export default defineConfig({
  test: { projects: ["apps/*", "packages/*"] },
});

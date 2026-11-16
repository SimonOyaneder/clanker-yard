import { defineConfig } from "vitest/config";

// Cada app y paquete (y `scripts`, que prueba el chequeo de límites) es un proyecto de Vitest; si necesita config propia, la deja en su carpeta.
//
// `maxWorkers`: por defecto Vitest usa núcleos - 1, o sea 1 worker en el runner de 2 vCPU de la CI, y casi todo el tiempo de
// un test es esperar a procesos hijos (git, el core, node), no CPU: con 4 workers los núcleos no quedan ociosos.
export default defineConfig({
  test: { projects: ["apps/*", "packages/*", "scripts"], ...(process.env.CI && { maxWorkers: 4 }) },
});

import { defineProject } from "vitest/config";

// Los tests del testkit levantan cores, repos git y servidores reales: bajo la suite completa en paralelo pasan de los
// 5 s por defecto de Vitest. 20 s es el piso; un archivo más lento sube el suyo con `vi.setConfig`.
export default defineProject({
  // Cada caso prepara y limpia sus repos, stores y servidores. El worker puede reutilizar los módulos del core.
  test: { testTimeout: 20_000, isolate: false },
});

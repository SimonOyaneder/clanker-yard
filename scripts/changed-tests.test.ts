import { describe, expect, test } from "vitest";
import { testsFor } from "./changed-tests.ts";

const code: Record<string, string> = {
  "packages/core/src/store/store.test.ts": `import { openStore } from "./store";\nimport { x } from "../flows/engine";`,
  "packages/core/src/flows/engine.test.ts": `import { createFlows } from "./flows";`,
  "packages/core/src/github/pr-rows.test.ts": `import { closed } from "./pr-rows.ts";\nimport { seed } from "../testing/pull-requests";`,
  "packages/ui/src/hooks/use-live.test.tsx": `import { useLiveQuery } from "./use-live"\nimport { replaceEqualDeep } from "@/lib/replace-equal-deep"`,
  "packages/ui/src/App.test.tsx": `const m = await import("@/components/elapsed")`,
  "packages/testkit/src/pr-publish.test.ts": `import { startCore } from "@clanker/core";`,
};
const tests = Object.keys(code);
const run = (changed: string[]) => testsFor(changed, tests, (file) => code[file]!);

describe("testsFor", () => {
  test("un test que cambió corre", () => {
    expect(run(["packages/testkit/src/pr-publish.test.ts"])).toEqual(["packages/testkit/src/pr-publish.test.ts"]);
  });

  test("un archivo con test al lado corre solo ese, aunque otros tests lo importen", () => {
    expect(run(["packages/core/src/flows/engine.ts"])).toEqual(["packages/core/src/flows/engine.test.ts"]);
  });

  test("un archivo sin test al lado corre los tests que lo importan directo", () => {
    expect(run(["packages/core/src/testing/pull-requests.ts"])).toEqual(["packages/core/src/github/pr-rows.test.ts"]);
  });

  test("resuelve el alias @/ de la UI, la extensión .ts y el import dinámico", () => {
    expect(run(["packages/ui/src/lib/replace-equal-deep.ts"])).toEqual(["packages/ui/src/hooks/use-live.test.tsx"]);
    expect(run(["packages/ui/src/components/elapsed.tsx"])).toEqual(["packages/ui/src/App.test.tsx"]);
    expect(run(["packages/core/src/flows/flows.ts"])).toEqual(["packages/core/src/flows/engine.test.ts"]);
  });

  test("no sigue el grafo: un módulo que solo llega por el índice de un paquete no arrastra sus tests", () => {
    expect(run(["packages/core/src/index.ts", "AGENTS.md", "docs/design.html"])).toEqual([]);
  });
});

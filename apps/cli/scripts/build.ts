// Empaqueta la CLI en `dist/clanker.js`, el archivo que apunta `bin`: un solo archivo que corre con
// `node` (`npm run build -w @clanker/cli`, luego `npm link -w @clanker/cli` para tener `clanker` en el PATH).
import { build } from "esbuild";
import { fileURLToPath } from "node:url";

const root = new URL("../", import.meta.url);
export const cliBundle = fileURLToPath(new URL("dist/clanker.js", root));

/** `outfile` distinto del de `dist/` para quien construye su propia copia (los tests). */
export async function buildCli(outfile = cliBundle): Promise<string> {
  await build({
    entryPoints: [fileURLToPath(new URL("src/main.ts", root))],
    outfile,
    bundle: true,
    platform: "node",
    target: "node24",
    format: "esm",
    // Dependencias CommonJS empaquetadas en un bundle ESM necesitan `require`.
    banner: {
      js: '#!/usr/bin/env node\nimport { createRequire } from "node:module"; const require = createRequire(import.meta.url);',
    },
    logLevel: "warning",
  });
  return outfile;
}

if (import.meta.url === `file://${process.argv[1]}`) await buildCli(process.argv[2]);

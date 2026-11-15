// Empaqueta el core en `dist/main.js`: un solo archivo que corre con `node` (o Electron con
// `ELECTRON_RUN_AS_NODE=1`). Las migraciones quedan al lado, en `../migrations`.
import { build } from "esbuild";
import { fileURLToPath } from "node:url";

const root = new URL("../", import.meta.url);
export const coreBundle = fileURLToPath(new URL("dist/main.js", root));

/** `outfile` distinto del de `dist/` para quien construye su propia copia (las migraciones se buscan en `../migrations` del bundle). */
export async function buildCore(outfile = coreBundle): Promise<string> {
  await build({
    entryPoints: [fileURLToPath(new URL("src/main.ts", root))],
    outfile,
    bundle: true,
    platform: "node",
    target: "node24",
    format: "esm",
    // Dependencias CommonJS empaquetadas en un bundle ESM necesitan `require`.
    banner: {
      js: 'import { createRequire } from "node:module"; const require = createRequire(import.meta.url);',
    },
    logLevel: "warning",
  });
  return outfile;
}

if (import.meta.url === `file://${process.argv[1]}`) await buildCore(process.argv[2]);

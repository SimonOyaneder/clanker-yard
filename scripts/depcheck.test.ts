import { execFile } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const run = promisify(execFile);

const packageDirs = {
  "@clanker/api": "packages/api",
  "@clanker/core": "packages/core",
  "@clanker/ui": "packages/ui",
  "@clanker/testkit": "packages/testkit",
  "@clanker/desktop": "apps/desktop",
  "@clanker/cli": "apps/cli",
};

// Un monorepo mínimo con la misma forma que el real. Cada archivo `bad-*` rompe una regla.
const files: Record<string, string> = {
  "packages/api/src/index.ts": "export const api = 1;",
  "packages/api/src/node.ts": "export const apiNode = 1;",
  "packages/api/src/contract.ts": "export const contract = 1;",
  "packages/core/src/index.ts": 'import { apiNode } from "@clanker/api/node"; export const core = apiNode;',
  "packages/ui/src/index.ts": 'import { api } from "@clanker/api"; export const ui = api;',
  "packages/testkit/src/index.ts": 'import { core } from "@clanker/core"; export const testkit = core;',
  "apps/desktop/src/index.ts": 'import { ui } from "@clanker/ui"; import { api } from "@clanker/api"; export const d = [ui, api];',
  "apps/cli/src/index.ts": 'import { api } from "@clanker/api"; export const cli = api;',

  "packages/ui/src/styles/globals.css": "body {}",
  "packages/ui/src/styles/other.css": "body {}",
  "apps/desktop/src/styles.ts": 'import "@clanker/ui/styles.css";',

  "packages/ui/src/bad-core.ts": 'import { core } from "@clanker/core"; export const x = core;',
  "packages/ui/src/bad-core-relative.ts": 'import { core } from "../../core/src/index"; export const x = core;',
  "packages/ui/src/bad-api-node.ts": 'import { apiNode } from "@clanker/api/node"; export const x = apiNode;',
  "apps/desktop/src/bad-core.ts": 'import { core } from "@clanker/core"; export const x = core;',
  "packages/core/src/bad-electron.ts": 'import { app } from "electron"; export const x = app;',
  "packages/core/src/bad-ui.ts": 'import { ui } from "@clanker/ui"; export const x = ui;',
  "packages/api/src/bad-cli.ts": 'import { cli } from "@clanker/cli"; export const x = cli;',
  "apps/cli/src/bad-core.ts": 'import { core } from "@clanker/core"; export const x = core;',
  "packages/testkit/src/bad-ui.ts": 'import { ui } from "@clanker/ui"; export const x = ui;',
  "apps/desktop/src/bad-css.ts": 'import "../../../packages/ui/src/styles/other.css";',
  "packages/ui/src/bad-internal.ts": 'import { contract } from "../../api/src/contract"; export const x = contract;',
};

type Violation = { rule: { name: string }; from: string; to: string };

let fixture: string;

beforeAll(() => {
  fixture = mkdtempSync(join(tmpdir(), "depcheck-"));
  const write = (path: string, content: string) => {
    mkdirSync(dirname(join(fixture, path)), { recursive: true });
    writeFileSync(join(fixture, path), content);
  };
  mkdirSync(join(fixture, "node_modules/@clanker"), { recursive: true });
  for (const [name, dir] of Object.entries(packageDirs)) {
    const exports =
      name === "@clanker/api"
        ? { ".": "./src/index.ts", "./node": "./src/node.ts" }
        : name === "@clanker/ui"
          ? { ".": "./src/index.ts", "./styles.css": "./src/styles/globals.css" }
          : { ".": "./src/index.ts" };
    write(`${dir}/package.json`, JSON.stringify({ name, type: "module", exports }));
    symlinkSync(join(fixture, dir), join(fixture, "node_modules", name));
  }
  write("tsconfig.base.json", JSON.stringify({ compilerOptions: { module: "ESNext", moduleResolution: "Bundler" } }));
  for (const [path, content] of Object.entries(files)) write(path, content);
});

afterAll(() => rmSync(fixture, { recursive: true, force: true }));

async function cruise(): Promise<Violation[]> {
  const args = [join(root, "node_modules/dependency-cruiser/bin/dependency-cruiser.mjs"), "apps", "packages"];
  args.push("--config", join(root, ".dependency-cruiser.mjs"), "--output-type", "json");
  // depcruise sale con código distinto de cero cuando hay violaciones, pero igual escribe el JSON.
  const { stdout } = await run(process.execPath, args, { cwd: fixture, maxBuffer: 10_000_000 }).catch((e) => e);
  return JSON.parse(stdout).summary.violations;
}

describe("límites entre paquetes (.dependency-cruiser.mjs)", () => {
  it("deja pasar las dependencias permitidas y marca cada violación con su regla", async () => {
    const violations = (await cruise()).map((v) => `${v.rule.name}: ${v.from} -> ${v.to}`).sort();
    expect(violations).toEqual(
      [
        "api-only-allowed-packages: packages/api/src/bad-cli.ts -> apps/cli/src/index.ts",
        "cli-only-allowed-packages: apps/cli/src/bad-core.ts -> packages/core/src/index.ts",
        "core-no-electron: packages/core/src/bad-electron.ts -> electron",
        "core-only-allowed-packages: packages/core/src/bad-ui.ts -> packages/ui/src/index.ts",
        "desktop-no-core: apps/desktop/src/bad-core.ts -> packages/core/src/index.ts",
        "only-package-entrypoints: apps/desktop/src/bad-css.ts -> packages/ui/src/styles/other.css",
        "only-package-entrypoints: packages/ui/src/bad-internal.ts -> packages/api/src/contract.ts",
        "testkit-only-allowed-packages: packages/testkit/src/bad-ui.ts -> packages/ui/src/index.ts",
        "ui-no-api-node: packages/ui/src/bad-api-node.ts -> packages/api/src/node.ts",
        "ui-no-core: packages/ui/src/bad-core-relative.ts -> packages/core/src/index.ts",
        "ui-no-core: packages/ui/src/bad-core.ts -> packages/core/src/index.ts",
      ].sort(),
    );
  });
});

describe("manifiestos", () => {
  it("testkit declara core y api solo como devDependency", () => {
    const manifest = JSON.parse(readFileSync(join(root, "packages/testkit/package.json"), "utf8"));
    for (const dep of ["@clanker/core", "@clanker/api"]) {
      expect(manifest.dependencies ?? {}).not.toHaveProperty(dep);
      expect(manifest.devDependencies).toHaveProperty(dep);
    }
  });
});

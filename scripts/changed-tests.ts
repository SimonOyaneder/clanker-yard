import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Los tests de lo que cambió, sin recorrer el grafo de imports (`vitest related` arrastra media suite: los tests del
 * testkit importan el core entero por `@clanker/core`):
 * - los tests que cambiaron;
 * - el test que vive al lado de un archivo que cambió (`x.ts` → `x.test.ts` o `x.test.tsx`);
 * - si el archivo no tiene uno al lado, los tests que lo importan directo (por ruta relativa o por el alias `@/` de la
 *   UI). Con test propio no se buscan: `store.ts` lo importan casi todos los tests del core como fixture.
 *
 * Lo que se rompe más lejos lo ve `typecheck`; la suite entera es `npm run test:all`, antes de pushear a main.
 */
export function testsFor(changed: readonly string[], testFiles: readonly string[], read: (file: string) => string): string[] {
  const tests = new Set<string>();
  const orphans = new Set<string>();
  for (const file of changed.map((f) => normalize(f))) {
    if (isTest(file)) {
      tests.add(file);
      continue;
    }
    const source = file.match(/^(.*)\.tsx?$/)?.[1];
    if (source === undefined) continue;
    const own = [`${source}.test.ts`, `${source}.test.tsx`].filter((candidate) => testFiles.includes(candidate));
    for (const test of own) tests.add(test);
    if (own.length === 0) orphans.add(file);
  }
  if (orphans.size > 0) {
    for (const test of testFiles) {
      if (!tests.has(test) && importsOf(read(test)).some((spec) => targetsOf(test, spec).some((target) => orphans.has(target)))) tests.add(test);
    }
  }
  return [...tests].filter((test) => testFiles.includes(test) || changed.includes(test)).sort();
}

const isTest = (file: string) => /\.test\.tsx?$/.test(file);

/** Los módulos que importa un archivo: `import ... from "x"`, `export ... from "x"` e `import("x")`. */
function importsOf(code: string): string[] {
  return [...code.matchAll(/(?:\bfrom\s+|\bimport\s*\(\s*|\bimport\s+)["']([^"']+)["']/g)].map((m) => m[1]!);
}

/** Los archivos a los que puede apuntar `spec` desde `test` (con o sin extensión, o el `index` de una carpeta). */
function targetsOf(test: string, spec: string): string[] {
  let base: string;
  if (spec.startsWith(".")) base = join(dirname(test), spec);
  else if (spec.startsWith("@/") && test.startsWith("packages/ui/")) base = join("packages/ui/src", spec.slice(2));
  else return [];
  base = normalize(base).replace(/\.js$/, "");
  return [base, `${base}.ts`, `${base}.tsx`, join(base, "index.ts"), join(base, "index.tsx")];
}

/** Sin archivos, lo que cambió la branch contra `origin/main`: commits, cambios sin commit y archivos nuevos. */
function changedAgainstMain(root: string): string[] {
  const git = (...args: string[]) => execFileSync("git", ["-c", "core.quotePath=false", ...args], { cwd: root, encoding: "utf8" });
  const base = git("merge-base", "origin/main", "HEAD").trim();
  const files = [...git("diff", "--name-only", "--diff-filter=d", base).split("\n"), ...git("ls-files", "--others", "--exclude-standard").split("\n")];
  return [...new Set(files.filter(Boolean))];
}

function main() {
  const root = join(dirname(fileURLToPath(import.meta.url)), "..");
  const args = process.argv.slice(2);
  // `--dry-run` solo lista los tests; el resto de las opciones van a vitest.
  const dryRun = args.includes("--dry-run");
  const flags = args.filter((arg) => arg.startsWith("-") && arg !== "--dry-run");
  const given = args.filter((arg) => !arg.startsWith("-"));
  const changed = given.length > 0 ? given : changedAgainstMain(root);
  const testFiles = execFileSync("git", ["ls-files", "--cached", "--others", "--exclude-standard", "*.test.ts", "*.test.tsx"], { cwd: root, encoding: "utf8" })
    .split("\n")
    .filter((file) => file && existsSync(join(root, file)));
  const tests = testsFor(changed, testFiles, (file) => readFileSync(join(root, file), "utf8"));
  if (tests.length === 0) {
    console.log(`Ningún test toca lo que cambió (${changed.length} archivos): nada que correr.`);
    return 0;
  }
  console.log(`${tests.length} tests de ${changed.length} archivos cambiados:\n${tests.map((t) => `  ${t}`).join("\n")}\n`);
  if (dryRun) return 0;
  const run = spawnSync("npx", ["vitest", "run", "--passWithNoTests", ...flags, ...tests], { cwd: root, stdio: "inherit" });
  return run.status ?? 1;
}

if (process.argv[1] !== undefined && normalize(process.argv[1]) === fileURLToPath(import.meta.url)) process.exit(main());

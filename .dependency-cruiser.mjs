// Límites entre paquetes (AGENTS.md, "Paquetes y dependencias permitidas";
// docs/design.html#d-data). Corre con `npm run depcheck`, dentro de `npm run lint`.

const dirs = {
  api: "packages/api",
  core: "packages/core",
  ui: "packages/ui",
  testkit: "packages/testkit",
  desktop: "apps/desktop",
  cli: "apps/cli",
};

// Qué paquetes del repo puede importar cada uno (además de sí mismo).
// Que testkit declare core y api solo como devDependency no se puede expresar acá: dependency-cruiser
// no distingue el tipo de dependencia de los paquetes del workspace (`undetermined`).
// Lo verifica scripts/depcheck.test.ts.
const allowed = {
  api: [],
  core: ["api"],
  ui: ["api"],
  desktop: ["ui", "api"],
  cli: ["api"],
  testkit: ["core", "api"],
};

// Prohibiciones con regla propia, para que el error diga por qué.
const explicitlyForbidden = {
  ui: ["core"],
  desktop: ["core"],
};

const dirRegex = (names) => `^(${names.map((n) => dirs[n]).join("|")})/`;

const allowListRules = Object.keys(dirs).map((pkg) => ({
  name: `${pkg}-only-allowed-packages`,
  comment: `${pkg} solo puede depender de: ${allowed[pkg].join(", ") || "ningún paquete del repo"}.`,
  severity: "error",
  from: { path: dirRegex([pkg]) },
  to: {
    path: "^(apps|packages)/",
    pathNot: dirRegex([pkg, ...allowed[pkg], ...(explicitlyForbidden[pkg] ?? [])]),
  },
}));

/** @type {import('dependency-cruiser').IConfiguration} */
export default {
  forbidden: [
    ...allowListRules,
    {
      name: "ui-no-core",
      comment: "La UI solo habla con la API; no importa el core.",
      severity: "error",
      from: { path: dirRegex(["ui"]) },
      to: { path: dirRegex(["core"]) },
    },
    {
      name: "desktop-no-core",
      comment: "El core se empaqueta y se lanza como proceso, no se importa.",
      severity: "error",
      from: { path: dirRegex(["desktop"]) },
      to: { path: dirRegex(["core"]) },
    },
    {
      name: "core-no-electron",
      comment: "El core corre como proceso Node independiente; no conoce Electron.",
      severity: "error",
      from: { path: dirRegex(["core"]) },
      to: { path: "(^|/)node_modules/electron/|^electron$" },
    },
    {
      name: "ui-no-api-node",
      comment: "`@clanker/api/node` es solo para Node (paths, ensureCore); la UI usa `@clanker/api`.",
      severity: "error",
      from: { path: dirRegex(["ui"]) },
      to: { path: `^${dirs.api}/src/node\\.ts$` },
    },
    {
      name: "only-package-entrypoints",
      comment: "Cada paquete exporta solo `src/index.ts` (más `@clanker/api/node`, `@clanker/core/testing` y `@clanker/ui/styles.css`); nada de imports a archivos internos de otro paquete.",
      severity: "error",
      from: { path: "^((?:apps|packages)/[^/]+)/" },
      to: {
        path: "^(apps|packages)/",
        pathNot: [
          "^$1/",
          "^(apps|packages)/[^/]+/src/index\\.ts$",
          `^${dirs.core}/src/testing\\.ts$`,
          `^${dirs.api}/src/node\\.ts$`,
          `^${dirs.ui}/src/styles/globals\\.css$`,
        ],
      },
    },
    {
      name: "core-testing-only-in-tests",
      comment: "Los GitHub y Linear falsos y la plantilla `juguete` (`@clanker/core/testing`) son de pruebas: el código de producción no los importa.",
      severity: "error",
      from: { path: "^(apps|packages)/[^/]+/src/", pathNot: ["\\.test\\.tsx?$", `^${dirs.testkit}/`, `^${dirs.core}/src/testing(\\.ts$|/)`] },
      to: { path: `^${dirs.core}/src/testing(\\.ts$|/)` },
    },
    {
      name: "no-non-package-json",
      comment:
        "Un paquete de npm que se importa tiene que estar en el package.json del paquete que lo importa: si no, solo resuelve por el hoisting del workspace y se rompe al empaquetar o instalar aparte.",
      severity: "error",
      from: {},
      to: { dependencyTypes: ["npm-no-pkg", "npm-unknown"] },
    },
    {
      name: "not-to-dev-dep",
      comment:
        "El código de producción no importa una devDependency: un bundle que no la incluya, o un `npm ci --omit=dev`, se rompe. Los tests, los E2E, los scripts y el testkit (solo de tests) sí pueden, y la app de escritorio también: electron-vite la bundlea entera y electron-builder exige `electron` como devDependency.",
      severity: "error",
      from: { path: "^(apps|packages)/[^/]+/src/", pathNot: ["\\.test\\.tsx?$", `^${dirs.testkit}/`, `^${dirs.desktop}/`, "/testing/", "/testing\\.ts$"] },
      to: { dependencyTypes: ["npm-dev"], dependencyTypesNot: ["type-only"] },
    },
  ],
  options: {
    doNotFollow: { path: "node_modules" },
    // El package.json de cada paquete más el de la raíz (vitest, tipos de Node y el resto de las herramientas del repo).
    combinedDependencies: true,
    tsPreCompilationDeps: true,
    tsConfig: { fileName: "tsconfig.base.json" },
    enhancedResolveOptions: { exportsFields: ["exports"], conditionNames: ["import", "require", "node", "default"] },
  },
};

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
      comment: "Cada paquete exporta solo `src/index.ts` (más `@clanker/api/node` y `@clanker/ui/styles.css`); nada de imports a archivos internos de otro paquete.",
      severity: "error",
      from: { path: "^((?:apps|packages)/[^/]+)/" },
      to: {
        path: "^(apps|packages)/",
        pathNot: [
          "^$1/",
          "^(apps|packages)/[^/]+/src/index\\.ts$",
          `^${dirs.api}/src/node\\.ts$`,
          `^${dirs.ui}/src/styles/globals\\.css$`,
        ],
      },
    },
  ],
  options: {
    doNotFollow: { path: "node_modules" },
    tsPreCompilationDeps: true,
    tsConfig: { fileName: "tsconfig.base.json" },
    enhancedResolveOptions: { exportsFields: ["exports"], conditionNames: ["import", "require", "node", "default"] },
  },
};

# Clanker Yard

Orquestador de agentes de código sobre issues y PRs. Monorepo con npm workspaces (Node 24, TypeScript estricto).

## El diseño es la fuente de verdad

Vive en `docs/design.html` (260 KB, no lo leas entero ni lo edites). Cita siempre la sección por su id, por ejemplo `docs/design.html#d-data`. Para leer una sección en texto plano:

```
python3 scripts/design-section.py          # lista los ids
python3 scripts/design-section.py d-data   # imprime una sección
```

Ids más usados: `devx` (dev setup), `d-data` (schema, API, monorepo), `stack`, `ui`, `d-ui`, `d-flows`, `d-agents`. Si el diseño no cuadra con la realidad, haz lo más simple que respete su intención y deja el desvío escrito en el PR.

## Instalar, correr, probar

```
nvm use                # Node 24, fijado en .nvmrc
npm ci
npm run typecheck      # tsc --noEmit en cada workspace
npm run lint           # eslint desde la raíz, más `npm run depcheck`
npm test               # vitest desde la raíz (un proyecto por app y paquete)
```

Los tres deben pasar antes de dar algo por listo; la CI corre los mismos en cada PR y en `main`. Un test de un paquete va junto a su código como `src/**/*.test.ts`.

UI sola: `npm run dev -w packages/ui` abre la UI en el navegador (puerto 8890) con datos de ejemplo en memoria.

Capturas de UI: todavía no hay captura automática. Cuando exista el E2E con Playwright `_electron` se documenta aquí; mientras tanto usa `chrome-devtools-mcp`.

## Paquetes y dependencias permitidas

```
apps/desktop      Electron (main, preload, ventana)
apps/cli          comandos `clanker` sobre la API
packages/api      contrato oRPC, esquemas zod, cliente
packages/core     Store, Flows, Agents, Workspaces, Scheduler, servidor
packages/ui       React + shadcn, vistas
packages/testkit  runtime fake, fixtures, repos git temporales
```

- `api` no depende de nadie del repo. `core` → `api`. `ui` → `api`. `desktop` → `ui`, `api`. `cli` → `api`. `testkit` → `core`, `api`, solo como `devDependency`.
- Prohibido: `ui` → `core`, `desktop` → `core` (el core se empaqueta y se lanza, no se importa), `core` → `electron`.
- Cada paquete exporta solo su `src/index.ts` (más `@clanker/api/node`, que la UI no puede usar). Nada de imports a archivos internos de otro paquete.
- `npm run depcheck` lo hace cumplir con dependency-cruiser (`.dependency-cruiser.mjs`) y corre dentro de `npm run lint`, así que la CI lo ejecuta en cada PR. Si agregas un paquete o cambias una dependencia permitida, edita esa config y el test `scripts/depcheck.test.ts`. Que `testkit` use `core` y `api` solo como `devDependency` lo verifica ese test, no dependency-cruiser.

## Base de datos

El schema vive en `packages/core/src/store/schema.ts`. Tras cambiarlo: `npm run db:generate -w @clanker/core` deja una carpeta nueva en `packages/core/migrations/` (se commitea). Para triggers u otro SQL que drizzle-kit no modela: `npx drizzle-kit generate --custom --name <x>` desde `packages/core` y escribe el SQL a mano. No edites una migración ya mergeada.

Lo que ya define `@clanker/api` (ids con prefijo, `EventType`, `Origin`, `SubjectRef`, `Event`, `EventFilter`) se importa de ahí, no se redeclara en el core: en el schema con `.$type<...>()`, que no cambia la migración.

## Testkit

`@clanker/testkit` (devDependency de quien lo use; solo se importa desde tests) trae lo necesario para probar sin tocar nada del usuario:

- `tempGitRepo({ commits, branches, remote })`: repo git real en un directorio temporal, aislado de tu config de git. `commits` va sobre `main`, `branches` sale del último commit de `main`, y con `remote: true` `origin` es un bare local donde `main` y las ramas ya están publicadas (push y fetch funcionan sin red). Devuelve `{ dir, remoteDir, git(...args), cleanup() }`.
- `seedDb(scenario)` y `loadFixture(path)`: devuelven un `CLANKER_HOME` temporal (`{ path, dbPath, env, cleanup() }`) con `clanker.db` sembrada por un escenario o copiada de un `.sqlite`. Pasa `home.env` al proceso que lanzas, o abre `openStore({ path: home.dbPath })` en el test. Siempre `cleanup()` en `afterEach`.
- Los escenarios viven en `packages/testkit/src/scenarios.ts` (`empty`, `loop-running`, `issue-blocked`). Un escenario nuevo es una función que escribe en el Store con `store.tx`.
- Fixtures: `packages/testkit/fixtures/db/<escenario>.sqlite`. No se versionan (`*.sqlite` está ignorado): se generan con el schema vigente con `npm run fixtures -w @clanker/testkit` (corre las migraciones y siembra cada escenario). Si cambias el schema o un escenario, regenéralas.
- Los tests de un paquete que necesiten la base usan `seedDb` (o `openStore({ path: ":memory:" })` si no hace falta un archivo); `loadFixture` es para apuntar la UI, el CLI o un E2E a un `.sqlite` generado.

## UI

- Usa un componente de shadcn antes de escribir uno propio. Agrégalo desde `packages/ui` (`npx shadcn@latest add <componente>`) o pídelo al MCP de shadcn (`.mcp.json`).
- El CLI genera `import { cn } from "cn"`: cámbialo a `import { cn } from "@/lib/utils"` (el lint falla si queda el otro).
- Colores solo desde los tokens de `packages/ui/src/styles/globals.css` (claro y oscuro). Nada de colores sueltos.
- Toda acción tiene atajo de teclado y está en la paleta ⌘K.
- Filas y tarjetas tienen menú contextual.
- Cada tag lleva un tooltip que explica qué significa.
- Los estados vacíos dicen qué hacer, no solo que no hay nada.
- Antes de dar una vista por lista: screenshot en claro y en oscuro, y míralos.

## Git

Conventional Commits (`feat(core): ...`), atómicos. Un PR por issue de Linear (`CLA-N`).

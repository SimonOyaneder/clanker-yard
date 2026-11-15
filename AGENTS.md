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
npm run lint           # eslint desde la raíz
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
- Cada paquete exporta solo su `src/index.ts`. Nada de imports a archivos internos de otro paquete.

## Base de datos

El schema vive en `packages/core/src/store/schema.ts`. Tras cambiarlo: `npm run db:generate -w @clanker/core` deja una carpeta nueva en `packages/core/migrations/` (se commitea). Para triggers u otro SQL que drizzle-kit no modela: `npx drizzle-kit generate --custom --name <x>` desde `packages/core` y escribe el SQL a mano. No edites una migración ya mergeada.

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

# Clanker Yard

Orquestador de agentes de código sobre issues y PRs. Monorepo con npm workspaces (Node 24, TypeScript estricto).

## El diseño es la fuente de verdad

Vive en `docs/design.html` (260 KB, no lo leas entero ni lo edites). Cita siempre la sección por su id, por ejemplo `docs/design.html#d-data`. Para leer una sección en texto plano:

```
python3 scripts/design-section.py          # lista los ids
python3 scripts/design-section.py d-data   # imprime una sección
```

Ids más usados: `devx` (dev setup), `d-data` (schema, API, monorepo), `stack`, `ui`, `d-ui`, `d-flows`, `d-agents`. Si el diseño no cuadra con la realidad, haz lo más simple que respete su intención y deja el desvío escrito en el PR.

Desvíos ya conocidos: `agentEnv` (`d-agents`) incluye `USER` además de `PATH`, `HOME` y `LANG`, y en modo suscripción nunca hereda `ANTHROPIC_*`, `CLAUDE_CODE_OAUTH_TOKEN` ni `CLAUDE_CODE_USE_*` (ver `docs/claude-subscription.md`).

## Instalar, correr, probar

```
nvm use                # Node 24, fijado en .nvmrc
npm ci
npm run typecheck      # tsc --noEmit en cada workspace
npm run lint           # eslint desde la raíz, más `npm run depcheck`
npm test               # vitest desde la raíz (un proyecto por app y paquete)
```

Los tres deben pasar antes de dar algo por listo; la CI corre los mismos en cada PR y en `main`. Un test de un paquete va junto a su código como `src/**/*.test.ts`.

El core es un proceso largo: un callback de timer o de evento (`setInterval`, `.on(...)`) no lanza, porque un throw ahí tumba el core. Atrapa el error y conviértelo en un resultado (abortar un `AbortSignal`, emitir un evento).

UI sola: `npm run dev -w packages/ui` abre la UI en el navegador (puerto 8890) con datos de ejemplo en memoria.

App de escritorio: `npm run dev -w apps/desktop` construye el core y abre Electron (con `CLANKER_HOME=$(mktemp -d)` delante no toca tus datos; sin él usa los reales). Para capturar la ventana de verdad, arráncala con `npx electron-vite dev -- --remote-debugging-port=9333` desde `apps/desktop` y habla CDP con `http://127.0.0.1:9333/json` (`Page.captureScreenshot`, `Runtime.evaluate`, `Emulation.setEmulatedMedia` para claro y oscuro). Ciérrala con `Browser.close` por CDP, no con `pkill`: hay otras Electron corriendo. Cuando exista el E2E con Playwright `_electron` se documenta aquí.

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

Los ids de prueba salen de `newId("run")` o son ULIDs válidos (`run_00000000000000000000000001`): `run_1` pasa el tipo, pero el store rechaza el evento.

Si una tx emite el inicio de algo (`lease.acquired`) y el paso que sigue falla, el camino de error emite el cierre (`lease.released`): la línea de tiempo no puede quedar con un lease que nunca se soltó.

## Secretos y conexiones

Los tokens (PAT de GitHub, OAuth de Linear...) viven detrás de la interfaz `Secrets` del core (`get`, `set`, `delete` por ref); la base guarda solo la ref (`connections.secret_ref`) y los eventos nunca llevan el valor. `createKeychainSecrets` usa el Keychain de macOS con el comando `security` (funciona con `ELECTRON_RUN_AS_NODE`, donde no hay `safeStorage`); `createFileSecrets` cifra un archivo con una llave junto a él, para tests y Linux. `createConnections(store, secrets)` es lo único que escribe `connections` y emite `connection.changed`; el token lo lee solo el core con `connections.token()`.

- GitHub: `connections.setPat(token)` valida el fine-grained PAT (usuario, repos visibles y una lectura de prueba por permiso: contents, pull requests, issues, checks) y lo conecta con la cuenta del token; `connections.githubClient(cuenta)` es el único cliente Octokit, pone el token en cada request y registra la cuota en `sync_cursors` (`rate:github:<cuenta>:<recurso>`), emitiendo `sync.rate_limited` si GitHub corta. Detrás va `GitHubTokenSource` (`pat` hoy, `app` con `refresh` después). `connections.list()` marca `expiresSoon` a 7 días del vencimiento y `expired` después. Los tests levantan un GitHub falso local con respuestas de `packages/core/src/github/fixtures/` (`fake-github.ts`).
- Linear: `connections.linearAuth(origin)` (`packages/core/src/linear/`) hace OAuth con PKCE contra un loopback: levanta un servidor en `127.0.0.1:48721` (`LINEAR_REDIRECT_PORT`), devuelve el `url` de `linear.app/oauth/authorize` (el core no abre el navegador; la API lo expone como `connections.linearAuth`) y, al aprobar, cambia el código por tokens, toma el `urlKey` del workspace como cuenta y conecta (`connection.changed`). Un `linearAuth` nuevo cancela el pendiente y vence a los 5 min. Access token de 24 h y refresh token de 30 días que rota: el access token, el refresh token y el vencimiento viajan juntos como un JSON en un solo secreto (`connection:linear:<workspace>`), y la base solo guarda la ref; `expiresAt` de la conexión es el del refresh token (30 días desde el último refresh). `connections.token("linear", cuenta)` refresca solo si al access token le quedan menos de 5 min, con un único refresh en vuelo por cuenta; si Linear rechaza el refresh (400, 401 o 403) la conexión queda `revoked` (en rojo) con `connection.changed` y hay que reconectar; un fallo de red o un 5xx solo lanza. `connect` no acepta Linear. `connections.disconnect` (también en la API) borra el secreto y la cuenta; no revoca el token en Linear. Los tests usan un Linear falso local (`linear/fake-linear.ts`) con PKCE y rotación del refresh token.
- Paso manual pendiente (Simón): no hay OAuth app de Linear registrada ni `client_id`. Se crea en https://linear.app/settings/api/applications/new (Settings, API, OAuth applications, New): nombre sin la palabra "Linear" (p. ej. "Clanker Yard"), tu nombre como developer, redirect URI exacto `http://127.0.0.1:48721/oauth/linear/callback` (Linear compara la URI completa, por eso el puerto es fijo; si lo cambias, pásalo en `redirectPort`) y distribución privada (solo tu workspace). No se usa client secret: el flujo es PKCE. Copia el `client_id` y pásalo como `createConnections(store, secrets, { linear: { clientId } })`; el arranque del core (CLA-11) debe leerlo de su configuración. Sin `client_id`, `linearAuth` falla con ese mismo mensaje. Los pasos y la URI no se probaron contra Linear real.
- Nunca guardes aquí el token OAuth de la suscripción de Claude (`docs/claude-subscription.md`).
- Los tests no tocan el Keychain real: usan `createFileSecrets` en un directorio temporal, o un `.keychain-db` temporal creado con `security create-keychain` y pasado en `keychain` (ver `secrets.test.ts`).

## App de escritorio

`apps/desktop` es solo el host (`docs/design.html#remoto`, `#d-data`): `main` lanza y vigila el core, `preload` le pasa la conexión a la ventana y `renderer` monta `@clanker/ui` con un `Host` armado sobre el preload.

- `createCoreSupervisor` (`src/main/core-supervisor.ts`) llama a `ensureCore` al arrancar y comprueba cada 2 s con `connectToCore`. Estados: `starting`, `live` (con `port`, `token` y `bootId`, que el preload entrega a la ventana) y `down` con el motivo. No relanza solo: el botón Reintentar de `StatusBanner` llama a `start()`. Si otro proceso (la CLI) levanta el core, pasa a `live` sin más.
- Cerrar la ventana o la app no detiene el core. El menú Archivo → "Salir y detener agentes" pide `system.shutdown({ drain: true })` y sale.
- El core es el bundle `packages/core/dist/main.js` (desktop no lo importa). Electron guarda sus cachés y preferencias en `<datos>/desktop`, así que con `CLANKER_HOME` un arranque de prueba no toca nada del usuario.
- Todo lo de Electron que la UI necesita (menú, notificaciones, editor, tema, estado del core) pasa por `Host` (`packages/ui/src/host.ts`); `Host.core` solo existe donde el host aloja el core. El main valida cada payload que llega por IPC.
- Los datos de la UI siguen siendo `createMemoryAppData` hasta que exista el `AppData` sobre la API.
- `packages/ui/src/styles/globals.css` se exporta como `@clanker/ui/styles.css` (el único archivo interno que otro paquete puede importar) y trae `@source` para que Tailwind compile las clases de la UI desde `apps/desktop`. El Vite del desktop apunta el alias `@` al `src` de la UI.
- Los tests de `core-supervisor` lanzan el core real sobre un `CLANKER_HOME` temporal con su propio bundle (`node scripts/build.ts <outfile>` de `packages/core`), sin pisar `dist/`.

## Trackers

`Tracker` (`packages/core/src/tracker/tracker.ts`) es lo único que el scheduler y los flujos ven de un tracker; las formas normalizadas (`Issue`, `IssueRef`, `StatusCategory`, `IssueFilter`, `TrackerCapabilities`) son de `@clanker/api`. `createLocalTracker(store)` es el adapter `local`: sus issues, comentarios y relaciones viven en `local_issues`, `local_comments` y `local_relations`, y `rev` es el cursor de `changesSince`. `createIssues(store)` es el caché `issues`: `sync(tracker, { projectId, project })` vuelca `listIssues` (la primera vez) o `changesSince` (después, con el cursor en `sync_cursors`, clave `issues:<tracker>:<proyecto>`) y emite `issue.synced`; `issues.list`, `issues.get` y `issues.createLocal` de la API leen y escriben ahí. Un adapter nuevo implementa `Tracker` y declara sus `capabilities`.

## Git remoto (push y fetch)

Solo el core habla con el remoto, y el token nunca llega al entorno de git ni de los hooks del repo. `createGitRemote({ askpass, connections })` (`packages/core/src/git/`) corre `git -c credential.helper= push|fetch <url explícita>` con `GIT_TERMINAL_PROMPT=0` y `GIT_ASKPASS` apuntando a un script que `createAskpass` escribe en un directorio 0700: el script cambia un ticket (60 s, 2 lecturas) por el usuario y la contraseña por un socket unix del core. Se usa a través de `workspaces.push(lease)` (`--force-with-lease` contra `remote_sha`; outcomes `ok`, `lease-rejected` sin reintento y `unauthorized`, que deja la conexión `revoked` con `connections.markRevoked`) y `workspaces.fetch(repo)`; `RepoConfig.remote` trae la URL y la cuenta. Los tests (`packages/testkit/src/git-remote.test.ts`) levantan un servidor git HTTP local con Basic auth sobre un bare temporal: nunca GitHub ni tokens reales.

## Proceso del core

El core corre como proceso propio (`packages/core/src/main.ts`, bundle en `packages/core/dist/main.js` con `npm run build -w @clanker/core`; las migraciones quedan en `packages/core/migrations`, al lado). `--data-dir` (o `CLANKER_HOME`) dice dónde; con `CLANKER_HOME` el core no toca el Keychain (secretos en archivo bajo `secrets/`) y los logs van a `<CLANKER_HOME>/logs`. Lo lanza `ensureCore({ dataDir, logDir, entry, origin })` de `@clanker/api/node`, que también tiene `clankerDirs()` (rutas por SO) y `readCoreJson`/`connectToCore`.

- Orden de arranque: `core.lock` (`wx`; un pid muerto se recupera) → abrir y migrar la base → abrir el puerto → `boot_id` en `meta` → `core.json` (0600). Quien lee `core.json` ya puede llamar a la API.
- Un cierre normal (SIGTERM, SIGINT, `system.shutdown`) borra `core.json` y `core.lock`; un crash los deja y el próximo arranque los recupera.
- Los tests de proceso (`packages/core/src/process/process.test.ts`) construyen el bundle y lanzan el core real sobre un `CLANKER_HOME` temporal. A mano: `CLANKER_HOME=$(mktemp -d) node packages/core/dist/main.js`.

## Brief y artefactos del worktree

`createBriefs({ workspaces, artifacts }).prepare(...)` (`packages/core/src/agents/brief.ts`) arma el `Brief` de cualquier rol y deja en `<worktree>/.clanker-run/` lo que el agente lee si lo necesita: `issue.md`, `diff.patch` contra la base del lease (incluye cambios sin commit y archivos nuevos), `diff-round.patch` (solo con `since`, el `snapshot` que devolvió la ronda anterior), `hunks.json` (`h1`, `h2`... por hunk, en el orden del patch) y `reports/r<n>-<rol>.json`. La carpeta se agrega a `.git/info/exclude` y cada archivo también se guarda en `artifacts` con una ref a la corrida (`r<ronda>/<archivo>`). El brief lleva a lo más 5 criterios (los ítems bajo "Criterios de aceptación" del cuerpo) y 10 learnings, y cita los archivos con rutas relativas al worktree. Se prueba en `packages/testkit` (necesita repos git reales).

## Plantilla clanker-loop

`clankerLoopTemplate` (`packages/core/src/template/`) son los roles y perfiles del equipo clanker-loop como datos: bodies de defs `role` y `profile` por slug, validados por `Role`/`Profile` de `@clanker/api`. `payloads.ts` tiene los esquemas zod de brief y reporte (el brief se pasa a JSON Schema suelto y el reporte estricto), `prompts.ts` los prompts y las instrucciones por modo, `roles.ts` y `profiles.ts` los ensamblan. El core no importa nada de aquí: el nombre de un rol solo vive en la plantilla y en sus tests.

- Un prompt no pide lo que hace el core (push, PR, checks, respuestas en el PR o el tracker) ni nada propio de un repo o empresa: eso llega como contexto del rol (`pack`, `repo`). El test de la plantilla lo verifica.
- Un rol o modo nuevo debe calzar con lo que referencian los flujos de la plantilla: su lista está en `template.test.ts`. Tras cambiar un esquema de reporte, `npx vitest run -u packages/core/src/template` regenera el snapshot; revisa el diff.

## Testkit

`@clanker/testkit` (devDependency de quien lo use; solo se importa desde tests) trae lo necesario para probar sin tocar nada del usuario:

- `tempGitRepo({ commits, branches, remote })`: repo git real en un directorio temporal, aislado de tu config de git. `commits` va sobre `main`, `branches` sale del último commit de `main`, y con `remote: true` `origin` es un bare local donde `main` y las ramas ya están publicadas (push y fetch funcionan sin red). Devuelve `{ dir, remoteDir, git(...args), cleanup() }`.
- `seedDb(scenario)` y `loadFixture(path)`: devuelven un `CLANKER_HOME` temporal (`{ path, dbPath, env, cleanup() }`) con `clanker.db` sembrada por un escenario o copiada de un `.sqlite`. Pasa `home.env` al proceso que lanzas, o abre `openStore({ path: home.dbPath })` en el test. Siempre `cleanup()` en `afterEach`.
- Los escenarios viven en `packages/testkit/src/scenarios.ts` (`empty`, `loop-running`, `issue-blocked`). Un escenario nuevo es una función que escribe en el Store con `store.tx`.
- Fixtures: `packages/testkit/fixtures/db/<escenario>.sqlite`. No se versionan (`*.sqlite` está ignorado): se generan con el schema vigente con `npm run fixtures -w @clanker/testkit` (corre las migraciones y siembra cada escenario). Si cambias el schema o un escenario, regenéralas.
- `createFakeRuntime({ fixtures })`: el runtime `fake` (`CORE_RUNTIME=fake`), un `AgentRuntime` que reproduce guiones YAML `<rol>.r<n>.yaml` (con etiqueta opcional, `dev.r1.plan.yaml`) en vez de llamar a un modelo. Ejemplo en `packages/testkit/fixtures/runs/demo`. El guion se elige por el rol de la sesión y por el modo, la ronda y la issue del brief (gana el que fija más campos de `match`; un empate es un error). Sin guion, o con un reporte que no cumple el esquema del modo, `start`/`resume` rechazan: nunca inventa un reporte. `speed` divide los tiempos de `events` (la opción `speed: Infinity` los salta), `effects` aplica patches con `git apply` en el worktree y `run` se consume con `nextRecipeResult(sessionId, comando)`.
- Los tests de un paquete que necesiten la base usan `seedDb` (o `openStore({ path: ":memory:" })` si no hace falta un archivo); `loadFixture` es para apuntar la UI, el CLI o un E2E a un `.sqlite` generado.

## Motor de flujos

`createFlows({ store, defs, agents, artifacts, roles, workspaceOf })` (`packages/core/src/flows/`) valida, guarda y ejecuta flujos (`docs/design.html#d-flows`). Hoy ejecuta nodos `agent` y `action`; `start` rechaza un flujo con parallel, gate, wait o flow antes de crear nada.

- `flows.start(flujo, sujeto, params, { profile, projectId })` es idempotente por (flujo, sujeto) mientras la corrida siga viva (índice parcial de `runs`). La corrida fija la versión del flujo, de sus roles y del perfil; Agents recibe esas versiones en `roleDef` y `profileDef`.
- Una acción se registra con `registerAction({ name, args, outcomes, effects, run })`. `run(args, ctx)` devuelve `{ outcome, output }`: un outcome de negocio es un resultado y nunca se reintenta; solo una excepción reintenta, según `retry` (default 3 con 10 s, 60 s y 5 min). `ctx.key` es `run:nodo:visita`, igual en todos los reintentos, y `ctx.once(etapa, fn)` guarda cada etapa en `action_effects`.
- Un paso agent necesita un worktree: `workspaceOf(runId)` lo entrega (hoy el que la corrida tiene tomado en Workspaces).
- Los reintentos son la misma fila de `step_runs` con `attempt` mayor (el token de fencing). Un error del entorno del agente (login vencido, cuota agotada) devuelve el paso a pending con `not_before` sin gastar intento.
- Los tests de flujos usan un `AgentRuntime` stub (`engine.test.ts`) y esperan `run.finished` o `run.parked` en los eventos, nunca sleeps; el backoff y los timeouts se prueban con `vi.useFakeTimers()`.

## Runtime de Claude

`createClaudeRuntime({ credentials, home })` (`packages/core/src/agents/claude/`) es el runtime `claude-sdk`: lanza Claude Code con `@anthropic-ai/claude-agent-sdk` (versión fija, súbela a propósito). `credentials` sale de `subscriptionCredentials()` (default: el `claude` del `PATH`, sin leer ni guardar el login) o `apiKeyCredentials(key)`.

- El entorno del agente se arma con lista blanca (`agentEnv`): nunca hereda `GH_TOKEN`, `GITHUB_TOKEN`, `LINEAR_*`, `SSH_AUTH_SOCK` ni `ANTHROPIC_*`. Si una variable nueva debe llegar al agente, se agrega ahí y en su test.
- Bajo `home` deja `transcripts/<sessionId>.jsonl` (mensajes del SDK tal cual, más una línea `clanker/pre_compact` por compactación), `agent-sessions/<sessionId>.json` (lo que `resume` necesita) y `agent-env/` (`gh/` vacía y el `gitconfig` generado).
- Los tests usan un `query` falso inyectado (`options.query`); la CI no llama a Claude. El smoke test real corre solo con `CLANKER_LIVE_CLAUDE=1 npx vitest run packages/core/src/agents/claude/claude-live.test.ts`: una consulta con haiku, gasta cuota.

## UI

- Usa un componente de shadcn antes de escribir uno propio. Agrégalo desde `packages/ui` (`npx shadcn@latest add <componente>`) o pídelo al MCP de shadcn (`.mcp.json`).
- El CLI genera `import { cn } from "cn"`: cámbialo a `import { cn } from "@/lib/utils"` (el lint falla si queda el otro).
- Colores solo desde los tokens de `packages/ui/src/styles/globals.css` (claro y oscuro). Nada de colores sueltos.
- Toda acción tiene atajo de teclado y está en la paleta ⌘K.
- Filas y tarjetas tienen menú contextual.
- Cada tag lleva un tooltip que explica qué significa.
- Los estados vacíos dicen qué hacer, no solo que no hay nada.
- Antes de dar una vista por lista: screenshot en claro y en oscuro, y míralos. No los commitees (`screenshots/` está ignorado).

## Git

Conventional Commits (`feat(core): ...`), atómicos. Un PR por issue de Linear (`CLA-N`).

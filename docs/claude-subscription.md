# Correr agentes de Claude con la suscripción

Investigación de CLA-22. Responde cómo hace el adapter de Claude (`docs/design.html#d-agents`) para usar la suscripción de Claude (Pro/Max) de quien instala Clanker Yard, sin API key, y qué permiten los términos de Anthropic. La API key queda como alternativa (`docs/design.html#decisiones`).

Fecha de la investigación: 2026-11-15. Claude Code 2.1.325, `@anthropic-ai/claude-agent-sdk` 0.3.325 (bundlea Claude Code 2.1.325), macOS.

Convención: **[verificado]** es algo que corrí en esta máquina; **[doc]** es lo que dice la documentación oficial de Anthropic (con link); **[secundario]** es prensa o blogs, sin fuente primaria que pude abrir.

## Resumen

- Usar la suscripción es posible y permitido en un solo escenario: **la persona que paga la suscripción inicia sesión en el binario de Claude Code sin modificar, en su propia máquina, y la app lo lanza**. Anthropic lo dice textual: la política no impide que "an end user sign in to the unmodified Claude Code binary with their own Claude subscription, including where a platform hosts Claude Code" ([legal y compliance](https://code.claude.com/docs/en/legal-and-compliance)).
- Lo que **no** se puede: que la app lea, guarde, reenvíe o use por su cuenta el token OAuth de la suscripción (lo que hacía el plugin de OpenCode), ni ofrecer "iniciar sesión con Claude" en una app propia. Anthropic lo bloquea en el servidor y lo prohíbe en los términos.
- Recomendación: el adapter lanza Claude Code con el Agent SDK (`pathToClaudeCodeExecutable` apuntando al `claude` instalado del usuario) y **no toca credenciales**: el binario lee su propio login. API key (`ANTHROPIC_API_KEY`) como segundo modo, explícito.
- La premisa "OpenCode logra usar Claude con suscripción" ya no es cierta: OpenCode quitó ese soporte en marzo de 2026 por pedidos legales de Anthropic (ver más abajo).

## Cómo lo hacen otros

| Cliente | Cómo usa Claude | Estado | Fuente |
| --- | --- | --- | --- |
| OpenCode | Plugin que usaba el token OAuth de la suscripción y se hacía pasar por Claude Code | Anthropic lo bloqueó en el servidor (9 ene 2026, [secundario](https://falcao.org/posts/anthropic-claude-access-crackdown-ecosystem-fallout/)); OpenCode eliminó el plugin, el prompt y el provider "per legal requests" el 19 mar 2026 [verificado en GitHub](https://github.com/anomalyco/opencode/pull/18186) | PR #18186 |
| Zed | Lanza el agente externo "Claude Agent" por ACP; el agente maneja su propia autenticación y facturación: API key o login de Claude Code "where supported" | Vigente | [Zed docs](https://zed.dev/docs/ai/external-agents) |
| Adaptador ACP de Claude (`agentclientprotocol/claude-agent-acp`) | Implementa un agente ACP "using the official Claude Agent SDK"; trae un `claude` propio o usa el que le indiques con `CLAUDE_CODE_EXECUTABLE` | Vigente | [repo](https://github.com/agentclientprotocol/claude-agent-acp) |
| Conductor | Claude Code con "your Claude subscription, Claude CLI login, an Anthropic API key"; opción "CLI auth for an existing Claude Code login". Avisa que si hay `ANTHROPIC_API_KEY` en el entorno, Claude Code puede usar la API | Vigente | [Conductor docs](https://conductor.build/docs/guides/providers) |
| OpenClaw y otros arneses de terceros | Token OAuth de la suscripción | Cortados de la suscripción desde el 4 abr 2026 y luego sujetos a cambios de política (ver línea de tiempo) | [secundario](https://www.theregister.com/2026/02/20/anthropic_clarifies_ban_third_party_claude_access) |

Patrón: los que siguen funcionando **lanzan el binario oficial** y dejan que él se autentique. Los que sacaban el token y hablaban directo con la API fueron bloqueados. El diseño de Clanker Yard ya va por el primer camino (el core lanza el SDK, que lanza `claude`).

## Qué permiten los términos

Fuentes primarias, leídas hoy:

- [Legal y compliance de Claude Code](https://code.claude.com/docs/en/legal-and-compliance), sección "Authentication and credential use":
  - OAuth "is intended exclusively for purchasers of Claude Free, Pro, Max, Ultra, Team, and Enterprise subscription plans and is designed to support ordinary use of Claude Code and other native Anthropic applications".
  - Quien construye productos, "including those using the Agent SDK, should use API key authentication". Anthropic no permite "offer Claude.ai login into their own applications, or to route requests through Free, Pro, Max, or Ultra plan credentials on behalf of their users", ni "collect, store, or intermediate Claude.ai credentials or session tokens".
  - Excepción explícita: no impide que "an end user sign in to the unmodified Claude Code binary with their own Claude subscription".
  - Condiciones para correr Claude Code dentro de un producto: el binario no se modifica, no se quita ni restringe ningún método de autenticación, y cada usuario se autentica con sus propias credenciales (API key, plan de Claude o proveedor 3P).
  - "Advertised usage limits for Pro, Max, and Ultra plans assume ordinary, individual usage of Claude Code and the Agent SDK."
- [Resumen del Agent SDK](https://code.claude.com/docs/en/agent-sdk/overview): "Unless previously approved, Anthropic does not allow third party developers to offer claude.ai login or rate limits for their products, including agents built on the Claude Agent SDK." Marca: no se puede llamar al producto "Claude Code".
- [Usar el Agent SDK con tu plan](https://support.claude.com/en/articles/15036540-use-the-claude-agent-sdk-with-your-claude-plan) (página de ayuda, leída hoy): con sesión de plan, el Agent SDK, `claude -p` y apps de terceros "still draw from your subscription limits". El cambio anunciado para el 15 jun 2026 (pool aparte de crédito programático) está **pausado**. Desde el 7 oct 2026, Max, Ultra y Team incluyen créditos mensuales de API, que solo aplican si usas una API key de tu organización de Console ([créditos mensuales](https://support.claude.com/en/articles/17154008-monthly-api-credits-for-max-ultra-and-team-plans)).

Línea de tiempo, con fuentes secundarias salvo donde se indica: 9 ene 2026 bloqueo en servidor de tokens de suscripción fuera de Claude Code; 17-20 feb términos actualizados ([The Register](https://www.theregister.com/2026/02/20/anthropic_clarifies_ban_third_party_claude_access)); 19 mar OpenCode retira el soporte (verificado); 4 abr los arneses de terceros salen de los límites de la suscripción ([VentureBeat, 13 may](https://venturebeat.com/ai/anthropic-reinstates-openclaw-and-third-party-agent-usage-on-claude-subscriptions-with-a-catch/)); 13 may anuncio de un crédito "Agent SDK" desde el 15 jun; ese cambio quedó pausado según la página de ayuda. **La política se ha movido varias veces en 2026**: hay que tratarla como inestable.

Qué NO pude determinar: si Anthropic considera "uso ordinario individual" a una app que corre varios agentes en paralelo con una sola suscripción. No hay una definición pública del límite. Es el riesgo principal (ver Riesgos).

## Opciones

| # | Opción | Cómo | Permitido | Estado | Veredicto |
| --- | --- | --- | --- | --- | --- |
| A | **Agent SDK + `claude` del usuario, sin tocar credenciales** | `query({ options: { pathToClaudeCodeExecutable, env } })`; el binario lee su login (Keychain en macOS) | Sí, es el caso de "end user signs in to the unmodified Claude Code binary with their own subscription" | **Verificado** (más abajo) | **Recomendada, modo por defecto** |
| B | Igual que A pero con el `claude` que trae el SDK (sin `pathToClaudeCodeExecutable`) | El SDK usa su binario bundleado; mismo login | Igual que A (binario sin modificar) | **Verificado** (mismo resultado) | Respaldo si el usuario no tiene `claude` instalado |
| C | `claude setup-token` y `CLAUDE_CODE_OAUTH_TOKEN` | El usuario genera un token de 1 año y lo exporta; el binario lo toma con precedencia sobre el login | Zona gris: es el mecanismo oficial para CI propio, pero si la app **guarda** el token cae en "collect, store, or intermediate" | Parcial: verifiqué que la variable se lee y gana sobre el login (con un token falso responde `401 OAuth access token is invalid`); **no generé un token real** (flujo de navegador, crea una credencial en la cuenta) | Solo si el usuario lo exporta en su propio shell y la app lo hereda sin guardarlo. No es el default |
| D | API key de Console (`ANTHROPIC_API_KEY`) | La app pasa la key en `env` | Sí, es el camino que Anthropic recomienda para productos | Verificado que gana sobre el login incluso en `-p` (Claude Code lo avisa); no la probé con una key válida | Alternativa explícita, no default (decisión del diseño) |
| E | Leer el token OAuth del Keychain y hablar directo con la API | Lo que hacía OpenCode | **No**: "collect, store, or intermediate", bloqueado en servidor | Bloqueado, no lo probé | Descartada |
| F | "Iniciar sesión con Claude" propio (OAuth de la app) | Flujo propio | **No**, prohibido salvo aprobación previa | No probado | Descartada |
| G | Proveedor 3P (Bedrock, Vertex, Foundry) | Variables `CLAUDE_CODE_USE_*` | Sí | No probado | Fuera de alcance; el adapter lo admite igual vía `env` |

## Recomendación

1. **Default: opción A.** El adapter no lee, guarda ni transmite ninguna credencial de Claude. Lanza Claude Code sin modificar y este usa el login del usuario. Con `pathToClaudeCodeExecutable` apuntando al `claude` que el usuario ya tiene (la misma versión con la que inició sesión), y `claude` bundleado del SDK como respaldo (opción B).
2. **Alternativa explícita: opción D.** Si el usuario configura una API key en los ajustes de Clanker Yard, el adapter la pasa en `env` y la UI muestra que el modo es "API key". La key se guarda en el almacén seguro del sistema, nunca en SQLite ni en logs.
3. **No ofrecer** `setup-token` desde la app ni guardar su token. Si alguien lo usa, que lo exporte en su shell y la app lo herede (opción C), documentado como "bajo tu responsabilidad".
4. Comprobar en cada arranque y no a ciegas. Al iniciar la sesión del SDK, el mensaje `system:init` trae `apiKeySource`: `"none"` significa suscripción. La UI debe mostrar el modo real (suscripción o API key) para que nadie pague API por accidente.
5. Mantener esto como uso personal: una instalación, una persona, su suscripción. Si Clanker Yard se distribuyera a terceros, cada uno usaría su propio login (lo permitido) y no habría que ofrecer login ni cuota propia (lo prohibido).

## Detalles que descubrí al verificar (importan para el adapter)

- **`USER` tiene que estar en el entorno del subproceso.** En macOS, Claude Code busca el login en el Keychain y sin `USER` responde `Failed to authenticate: OAuth session expired and could not be refreshed` (y en el SDK `assistant.error === "authentication_failed"`), aunque `claude auth status` diga que hay sesión. Con `HOME`, `USER` y `PATH` funciona; con `HOME`, `LOGNAME` y `PATH` falla. El `agentEnv` del diseño dice "PATH, HOME, LANG": tiene que incluir `USER`. No lo verifiqué en Linux (ahí las credenciales viven en `~/.claude/.credentials.json`, según la [doc de autenticación](https://code.claude.com/docs/en/authentication)).
- **Precedencia de credenciales** ([doc](https://code.claude.com/docs/en/authentication)): proveedor cloud, `ANTHROPIC_AUTH_TOKEN`, `ANTHROPIC_API_KEY`, `apiKeyHelper`, `CLAUDE_CODE_OAUTH_TOKEN`, y por último el login de suscripción. Si el entorno heredado trae cualquiera de las anteriores, la suscripción se ignora **sin avisar**. En modo suscripción, `agentEnv` debe partir de una lista blanca (como ya dice el diseño) y nunca heredar `ANTHROPIC_*`, `CLAUDE_CODE_OAUTH_TOKEN` ni `CLAUDE_CODE_USE_*`.
- `--bare` (y por tanto el modo mínimo) **no lee el login ni `CLAUDE_CODE_OAUTH_TOKEN`**: verificado, responde `Not logged in`. El adapter no debe usarlo en modo suscripción.
- `outputFormat: json_schema` funciona con suscripción (verificado: `structured_output` válido, costo reportado 0,00026 USD, equivalente a precio de lista).
- El login de esta máquina es un plan **Team** (`claude auth status`: `subscriptionType: "team"`), no Pro/Max. Funciona igual y el evento de límites también llega. La doc de la barra de estado dice que `rate_limits` aparece solo para Pro/Max/Ultra ([doc](https://code.claude.com/docs/en/statusline)); en la práctica el evento del SDK llegó con Team. Conviene confirmar con un Pro/Max real antes de depender de los campos.

## Snippet mínimo probado

Entorno limpio (`env -i`) con solo `HOME`, `USER` y `PATH`, como lo armaría el adapter. Sin `ANTHROPIC_API_KEY`.

```bash
mkdir probe && cd probe && npm init -y && npm install @anthropic-ai/claude-agent-sdk@0.3.325
```

```js
// probe.mjs
import { query } from "@anthropic-ai/claude-agent-sdk";
import { realpathSync } from "node:fs";

const executable = realpathSync(`${process.env.HOME}/.local/bin/claude`);
const env = { HOME: process.env.HOME, USER: process.env.USER, PATH: "/usr/bin:/bin" };

for await (const m of query({
  prompt: "Responde solo con la palabra: pong",
  options: {
    pathToClaudeCodeExecutable: executable,
    env,
    model: "haiku",
    settingSources: [],
    tools: [],
    persistSession: false,
    maxTurns: 1,
  },
})) {
  if (m.type === "system" && m.subtype === "init") console.log("INIT", m.apiKeySource, m.claude_code_version);
  if (m.type === "rate_limit_event") console.log("RATE", JSON.stringify(m.rate_limit_info));
  if (m.type === "result") console.log("RESULT", m.result, m.total_cost_usd);
}
```

```
$ env -i HOME="$HOME" USER="$USER" PATH="/usr/bin:/bin:$(dirname $(which node))" node probe.mjs
INIT none 2.1.325
RATE {"status":"allowed_warning","resetsAt":1794931200,"rateLimitType":"seven_day","utilization":0.89,"overageStatus":"allowed","overageResetsAt":1796083200,"isUsingOverage":false,"surpassedThreshold":0.75,"unifiedWindows":{"five_hour":{"utilization":0.28,"resetsAt":1794724200,"status":"allowed"},"seven_day":{"utilization":0.89,"resetsAt":1794931200,"status":"allowed_warning","surpassedThreshold":0.75}},"overageEnabled":true}
RESULT pong 0.000122
```

`apiKeySource: "none"` y `claude auth status` con `authMethod: "claude.ai"` confirman que corrió con la suscripción. Lo mismo con el CLI directo:

```
$ env -i HOME="$HOME" USER="$USER" PATH="/usr/bin:/bin:$HOME/.local/bin" \
    claude -p "Responde solo con la palabra: pong" --model haiku --output-format json \
    --no-session-persistence --setting-sources "" --tools "" --max-budget-usd 0.05
{"is_error":false,"result":"pong","total_cost_usd":0.00059549,"terminal_reason":"completed", ...}
```

Sin `pathToClaudeCodeExecutable` (binario bundleado del SDK) el resultado es el mismo (`INIT none 2.1.325`, `pong`). Las pruebas en total costaron unas milésimas de dólar equivalente.

## Plan y uso (barras de 5 h y 7 días) y cuota agotada

Lo que hay, de más a menos estable:

- **Evento `rate_limit_event` del SDK** ([referencia TS](https://code.claude.com/docs/en/agent-sdk/typescript)). Tipado en `sdk.d.ts` 0.3.325: `status` (`allowed` | `allowed_warning` | `rejected`), `resetsAt` (segundos Unix), `rateLimitType` (`five_hour`, `seven_day`, `seven_day_opus`, `seven_day_sonnet`, `seven_day_overage_included`, `overage`), `utilization` (0 a 1), `overageStatus`, `isUsingOverage`, `surpassedThreshold`, `errorCode: "credits_required"`. **Verificado**: llega una vez por consulta, antes del `result`, aunque no haya problema. Además trae `unifiedWindows.five_hour` y `unifiedWindows.seven_day` con su propia `utilization`, `resetsAt` y `status`: son exactamente las dos barras, pero **no están tipadas** en el SDK, así que hay que leerlas como opcionales y no depender de ellas.
- **Barra de estado de Claude Code**: `rate_limits.five_hour.used_percentage` y `rate_limits.seven_day.used_percentage` (0 a 100) con `resets_at` ([doc](https://code.claude.com/docs/en/statusline)). Solo sirve para sesiones interactivas; no la usaría.
- No encontré una API pública documentada para consultar el uso fuera de una sesión. Hay endpoints no documentados que usan herramientas de la comunidad; no los recomiendo (son justo la zona de "intermediate credentials"). Por tanto la lectura de uso es **pasiva**: se guarda el último `rate_limit_event` de cada paso.

Detección de cuota agotada para el breaker del runtime:

1. `rate_limit_event.rate_limit_info.status === "rejected"`: abrir el breaker hasta `resetsAt` (de la ventana que corresponda a `rateLimitType`). Si trae `errorCode: "credits_required"`, la suscripción agotó lo incluido y solo seguiría comprando crédito: abrir y avisar en la UI.
2. Mensaje `assistant` con `error === "rate_limit"` (429 contra tu cuota; `overloaded` es un 529 de capacidad, distinto) o `billing_error`: abrir el breaker.
3. `result` con `is_error`, y el texto empieza con `You've hit your session limit` o `weekly limit` (también `Opus limit` y `Sonnet limit`), textos de la [doc de errores](https://code.claude.com/docs/en/errors).
4. Aviso temprano: `allowed_warning` con `surpassedThreshold` (visto 0,75): mostrar la barra amarilla y que el Scheduler no tome issues nuevas si `utilization` supera un umbral configurable.
5. `assistant.error === "authentication_failed"` o `Login expired`: **no** es cuota; es el login. Estado propio "reautenticar" en la UI (la persona corre `claude auth login`), sin abrir el breaker de cuota. El login actual vence el 2026-12-13 (`claude auth status`), así que ocurrirá.

**No verificado**: la forma exacta de un evento `rejected` ni de los mensajes de error, porque habría que agotar la cuota real de la persona. Antes de dar el breaker por bueno, simularlo en el runtime fake y probarlo una vez cuando la cuota se agote por uso normal. Tampoco verifiqué `CLAUDE_CODE_RETRY_WATCHDOG_MAX_USAGE_LIMIT_WAIT_MS`: la doc de errores dice que fija cuánto espera una solicitud a que se reinicie el límite del plan; si por defecto el CLI espera dentro de la solicitud, el paso parecería colgado en vez de fallar. Revisarlo en la fase 1.

## Riesgos

| Riesgo | Efecto | Mitigación |
| --- | --- | --- |
| Política inestable (varios cambios en 2026) | Lo permitido hoy puede dejar de serlo | Aislar todo en `ClaudeCredentials`; el modo API key funciona sin cambios; releer la [página de ayuda](https://support.claude.com/en/articles/15036540-use-the-claude-agent-sdk-with-your-claude-plan) al empezar el adapter |
| "Ordinary, individual usage" sin definición pública | Varios agentes en paralelo pueden agotar las barras de 5 h y 7 días, o ser tratados como uso no ordinario | Concurrencia configurable con tope bajo por defecto; breaker por cuota; mostrar uso en la UI; no revender ni compartir la suscripción |
| El adapter guarda o lee credenciales | Cae en "collect, store, or intermediate" | Diseño sin credenciales en modo suscripción; la key de API solo en el almacén seguro del sistema |
| Entorno heredado trae `ANTHROPIC_API_KEY` | Cobro por API sin que se note | Lista blanca de variables; mostrar `apiKeySource` y modo en la UI; test que falle si `agentEnv` contiene `ANTHROPIC_*` en modo suscripción |
| Falta `USER` en el entorno | Falso "login expirado" en macOS | Incluir `USER` en `baseEnv`; test del adapter |
| El login vence (el de esta máquina, el 2026-12-13) | Los agentes desatendidos se detienen | Estado "reautenticar" y aviso previo (`claude auth status` da `loginExpiresAt`) |
| Versión del `claude` del usuario distinta a la del SDK | Eventos o flags que no existen (p. ej. `rate_limit_event` pide Claude Code 2.1.181 o más nuevo) | Leer la versión de `system:init` y avisar si es menor al mínimo; no verifiqué una combinación desfasada |
| Marca | "Claude Code" no se puede usar como nombre del producto | Llamarlo "Claude" o "Claude Agent", según las [pautas](https://code.claude.com/docs/en/agent-sdk/overview) |
| Plan de la persona | Esta máquina inicia sesión con un plan Team; Pro/Max pueden diferir en campos y límites | Confirmar con un Pro o Max real en la fase 1 |

## Interfaz `ClaudeCredentials`

Lo mínimo que el adapter necesita; encaja con los dos "ENCHUFE" del diseño (`credentials.executable` y `credentials.env()`).

```ts
type ClaudeCredentials = {
  /** Ruta absoluta a un `claude` sin modificar. Alimenta pathToClaudeCodeExecutable. */
  executable: string;
  /** Variables de entorno de credencial que se mezclan en agentEnv. Subscription: {}. */
  env(): Record<string, string>;
  /** Para la UI: qué modo es, sin exponer secretos. */
  mode: "subscription" | "api-key";
};
```

Dos fábricas, ninguna guarda un token de suscripción:

- `subscription`: `executable` = ruta configurada o `which claude` resuelta con `realpath`; si no existe, el binario bundleado del SDK. `env()` devuelve `{}`. Antes de lanzar, comprobar `claude auth status` (`loggedIn`, `authMethod: "claude.ai"`) para dar un error accionable ("corre `claude auth login`") en vez de un fallo a mitad de corrida.
- `api-key`: `env()` devuelve `{ ANTHROPIC_API_KEY }` leída del almacén seguro del sistema.

Reglas que debe cumplir el adapter, no la interfaz: el `baseEnv` incluye `HOME`, `USER` y `PATH`; en modo suscripción el entorno final no contiene `ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN`, `CLAUDE_CODE_OAUTH_TOKEN` ni `CLAUDE_CODE_USE_*`; no se usa `--bare`; tras `system:init`, `apiKeySource === "none"` en modo suscripción y distinto de `"none"` en modo API key, o el paso falla con un mensaje claro.

## Desvíos del diseño

- `agentEnv` debe incluir `USER` (el diseño lista "PATH, HOME, LANG").
- El diseño dice "Con suscripción el USD es un equivalente a precio de lista": confirmado, el SDK reporta `total_cost_usd` también con suscripción.
- El diseño no menciona el estado "reautenticar" (login vencido) como distinto de cuota agotada; conviene agregarlo al breaker y a la UI.

## Seguimientos

- Adapter de Claude con `ClaudeCredentials` (fase 1).
- Probar con una cuenta Pro o Max y con una cuota realmente agotada (forma de `rejected`).
- Verificar Linux y el comportamiento de `CLAUDE_CODE_RETRY_WATCHDOG_MAX_USAGE_LIMIT_WAIT_MS`.
- Releer la política de Anthropic al empezar el adapter.

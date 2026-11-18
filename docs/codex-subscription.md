# Correr agentes de Codex con la suscripción de ChatGPT

Investigación de CLA-128, 2026-11-17. Codex CLI **0.169.1**, Node 24.18.0, macOS. El molde es `docs/claude-subscription.md`; el contrato que hay que preservar es `docs/design.html#d-agents`.

Convención: **[verificado]** es una prueba ejecutada contra ese binario; **[doc]** es documentación oficial o código del tag `rust-v0.169.1`, no una prueba contra el servicio; **[secundario]** sería una fuente no primaria. No hizo falta usar fuentes secundarias. Cada límite de la investigación se indica explícitamente.

## Resumen

- **[verificado]** `app-server` puede completar un turno con el login de ChatGPT del usuario, bajo `env -i`, sin que Yard lea o copie credenciales. El plan observado fue `self_serve_business_prolite`: no se probaron cuentas Plus ni Pro.
- **No está listo para trasladar directamente los roles actuales.** Los 38 esquemas de salida de la plantilla, contando las variantes con y sin learnings, se rechazan por el campo opcional `decisions` del sobre. Además, apagar los documentos del proyecto no apaga el `AGENTS.md` global.
- **[doc]** OpenAI documenta tanto integrar app-server en un producto como un flujo SIWC propio para apps abiertas/locales. Eso no equivale a una excepción contractual explícita para cualquier app que lance un Codex sin modificar. No hay que trasladar la excepción de Anthropic a OpenAI.
- Recomendación: conservar el login delegado al binario como opción técnica investigada, pero **resolver aislamiento, formato de reporte y encuadre de autorización antes de habilitar el runtime**. No implementar un atajo que copie `auth.json`.

## 1. Términos y autorización

Fuentes primarias que se pudieron abrir sin navegador:

| Fuente | Lo relevante |
| --- | --- |
| [Sign in with ChatGPT Terms](https://openai.com/policies/sign-in-with-chatgpt-terms/), vigentes desde 2026-11-04 | Identificar la app con su nombre; obtener tokens solo por el flujo soportado y autorizado; almacenamiento persistente local bajo control del usuario. Prohíbe compartir, revender o agrupar uso/tokens, rotar cuentas para eludir límites y atender a una persona con la suscripción de otra. |
| SIWC, §3.1 de esos términos | Las solicitudes deben surgir de la actividad del usuario o de automatizaciones expresamente autorizadas. El uso en segundo plano requiere consentimiento expreso. No ofrecer una API general para herramientas ajenas. Usar el plan por SIWC no puede exigir pagar por la app ni subir a una versión paga. |
| [Using your ChatGPT plan in other apps and sites](https://help.openai.com/en/articles/20001542-using-your-chatgpt-plan-in-other-apps-and-sites) | La ayuda incluye Go, Plus, Pro y Business en apps participantes, sujetos a elegibilidad y controles. No concede cuota adicional. Business depende también de permisos y límites del workspace; las apps comerciales fuera del programa deben contactar a OpenAI. |
| [Terms of Use](https://openai.com/policies/terms-of-use/) y [Service Terms](https://openai.com/policies/service-terms/), §4 y §15 | No compartir credenciales/cuenta ni eludir límites. El código generado puede estar sujeto a licencias de terceros. SIWC remite a sus propios términos; Business/Enterprise puede tener otro acuerdo aplicable. |
| [Codex App Server](https://developers.openai.com/codex/app-server/) | Presenta app-server como interfaz para integrar Codex en un producto propio, con autenticación, eventos y aprobaciones. Es evidencia de soporte técnico, no una autorización para compartir una cuenta. |

**[doc]** El [flujo SIWC para apps abiertas/locales](https://developers.openai.com/siwc/token-sharing-open-source) registra un cliente propio y un identificador estable de host, obtiene consentimiento y sus propios tokens. Su [configuración de app-server](https://developers.openai.com/siwc/token-sharing-open-source/codex-app-server) usa un proveedor Responses con `env_key`, `requires_openai_auth=false` y un token de **esa app**, renovado por ella. Es distinto de lanzar el binario que ya tiene un login de Codex.

No encontré en las fuentes leídas una excepción textual equivalente a la de Claude para «binario sin modificar + login existente». El experimento confirma que funciona; **no verifica que distribuir Yard así satisfaga todos los requisitos de SIWC**. Antes de distribuirlo hay que confirmar ese encuadre, o elegir el flujo SIWC propio documentado. Ese segundo camino cambia el diseño de conexiones y requiere una decisión aparte; no se implementó ni se inició un OAuth en esta investigación.

Sobre `auth.json`: la [documentación de autenticación de Codex](https://developers.openai.com/codex/auth/) dice que contiene secretos, debe tratarse como una contraseña y no debe compartirse ni publicarse. No dice que toda lectura local del archivo sea ilegal: Codex mismo lo lee. **Extraer su token para usarlo como credencial de otra app no es el consentimiento/registro propio que documenta SIWC.** Yard no debe leerlo, copiarlo, subirlo ni poner una copia en otro `CODEX_HOME`; tampoco compartir la suscripción. Esto distingue una decisión de seguridad del repo de una prohibición literal que la fuente no formula.

No hubo un 403 en las páginas primarias finalmente utilizadas. Una URL de ayuda inicialmente intentada devolvió 404; el artículo válido es el enlazado arriba.

## 2. Entorno y precedencia de credenciales

**[verificado]** Entorno suficiente: `HOME`, `USER` y `PATH`. Se probó también `CODEX_HOME` apuntando al mismo home de Codex. No se inspeccionó su archivo de credenciales.

| Variable/caso | Resultado observado en 0.169.1 |
| --- | --- |
| `HOME` con el login existente | `account/read { refreshToken:false }` devuelve `account.type:"chatgpt"` y se completa una inferencia. No se probó quitar `HOME`: no se afirma que el binario carezca de otros mecanismos para localizarlo. |
| Sin `USER`, manteniendo `HOME` y `PATH` | La lectura de cuenta y una inferencia funcionan en macOS. La necesidad de `USER` descubierta para Claude no se reproduce aquí. |
| `PATH` | Se usó para encontrar `codex`, Node y comandos hijos. No se buscó un PATH mínimo para todas las herramientas/recetas. |
| `CODEX_HOME` | Es opcional con el home por defecto. Un home vacío de prueba no tiene el login; un directorio explícito inexistente impide arrancar. Ese home de prueba nunca recibió una copia de credenciales. |
| `OPENAI_API_KEY` falsa | El login sigue siendo ChatGPT y el turno se completa. |
| `CODEX_API_KEY` falsa | Igual: no reemplaza el login de este app-server. |
| Ambas keys falsas a la vez | El turno se completa con el login existente. No hay un orden entre ellas que pueda deducirse de este caso: ambas se ignoran en este camino. |
| `CODEX_ACCESS_TOKEN` falsa, no vacía | `account/read` deja de presentar la cuenta ChatGPT. No se probó un token válido ni se equipara este caso a un login vencido. |
| `OPENAI_BASE_URL=https://example.invalid/v1` | La config efectiva sigue con `openai_base_url:null` y el turno se completa. Esa variable no redirigió esta inferencia con el proveedor por defecto. |

**[doc]** No existe una única precedencia válida para todos los comandos y proveedores:

- [app-server crea AuthManager](https://github.com/openai/codex/blob/rust-v0.169.1/codex-rs/app-server/src/lib.rs) con `enable_codex_api_key_env=false`. No hay que extrapolar el comportamiento de `codex exec` al servidor.
- En [`login/src/auth/manager.rs`](https://github.com/openai/codex/blob/rust-v0.169.1/codex-rs/login/src/auth/manager.rs), `load_auth` considera primero `CODEX_API_KEY` **si el llamador la habilita**, después autenticación externa en memoria, después `CODEX_ACCESS_TOKEN` y finalmente el almacén persistente. También aplica las restricciones de métodos/workspace. La prueba con token falso solo cubre la pérdida del fallback observado, no todos esos caminos.
- Un [proveedor personalizado](https://developers.openai.com/codex/auth/#alternative-model-providers) con `requires_openai_auth=false` puede usar `env_key`, un helper o su propio mecanismo. La configuración del proveedor también puede cambiar el destino. No se probó esa variante con credenciales reales.

Recomendación para Yard: lista blanca, no heredar keys/tokens, destinos alternativos ni proxies de forma accidental. Preservar `CODEX_HOME` solo cuando es el del usuario; mantener el aislamiento de git/gh ya existente en los otros runtimes. Verificar el modo real con `account/read`, no inferirlo de que una variable esté ausente. Linux, keyring y configuraciones de proveedores empresariales quedan **sin verificar**.

## 3. Configuración personal: qué se puede aislar

**[verificado]** `codex app-server --help` no ofrece `--ignore-user-config`. `--strict-config` está disponible, pero significa «rechazar claves desconocidas», **no** «ignorar configuración». La ayuda de `codex exec` sí lista `--ignore-user-config`.

| Superficie | Evidencia y limitación |
| --- | --- |
| MCP | Con un home sintético, `-c 'mcp_servers={}'` **conservó** el servidor centinela heredado; `-c mcp_servers.research_sentinel.enabled=false` sí lo marcó deshabilitado. Las tablas se mezclan, no se vacían con `{}`. Para los turnos reales se descubrieron los nombres mediante `config/read {cwd}` y se enviaron overrides `mcp_servers.<nombre>.enabled=false` en `thread/start.config`. No se debe copiar esta estrategia como garantía ante cambios de configuración concurrentes. |
| Capas del proyecto | `config/read` sin `cwd` y con el `cwd` del experimento devolvieron conjuntos de MCP distintos. Intentar deshabilitar por CLI un nombre que solo existe en la capa de proyecto produjo `invalid transport`: el override puede crear una entrada incompleta al cargar la config de arranque. Enumerar únicamente la config de usuario no basta. |
| `notify` | `-c 'notify=[]'` reemplazó la lista centinela del home sintético; la config efectiva quedó vacía. |
| Hooks | Se aplicó `features.codex_hooks=false`; se verificó el valor efectivo. **[doc]** [`core/src/session/environment.rs`](https://github.com/openai/codex/blob/rust-v0.169.1/codex-rs/core/src/session/environment.rs) condiciona la carga de hooks a esa feature. No se ejecutó un hook personal ni se verificaron todas las variantes de hooks administrados. |
| Plugins/apps | Se aplicaron `features.plugins=false` y `features.apps=false`, observadas en la config efectiva. No se instaló un plugin centinela: no se afirma haber probado cada contribución de plugins o requisitos administrados. |
| Skills | Se aceptaron `skills.include_instructions=false`, `skills.bundled.enabled=false` y `cloud.skills.enabled=false`. **[doc]** [`SkillsConfig`](https://github.com/openai/codex/blob/rust-v0.169.1/codex-rs/config/src/skills_config.rs) distingue instrucciones, skills incluidas y reglas por nombre/ruta. Ocultar el bloque de instrucciones **no demuestra** desactivar descubrimiento e invocación de toda skill personal. Esa exclusión completa quedó sin verificar. |
| `AGENTS.md` del proyecto | `project_doc_max_bytes=0` vació esa parte de la carga en las pruebas. **[doc]** [`load_project_instructions`](https://github.com/openai/codex/blob/rust-v0.169.1/codex-rs/core/src/agents_md.rs) retorna sin documentos con presupuesto cero. |
| `AGENTS.md` global | **No se excluyó.** Incluso con presupuesto cero, `instructions=""`, `baseInstructions` propio y `developerInstructions=""`, `thread/start.instructionSources` seguía incluyendo el global. Solo se registró su presencia, no su contenido. **[doc]** El [proveedor global](https://github.com/openai/codex/blob/rust-v0.169.1/codex-rs/codex-home/src/instructions/mod.rs) lo lee del home de Codex independientemente del presupuesto de documentos del proyecto. |
| Perfil | `codex --help` describe `--profile <nombre>` como una **capa sobre** la config base. La antigua clave `profile="research"` fue rechazada en el experimento y pidió `<nombre>.config.toml`. No se creó un perfil en el home personal ni se verificó que un perfil consiga exclusión total. |

El [`merge` de configuración](https://github.com/openai/codex/blob/rust-v0.169.1/codex-rs/config/src/merge.rs) explica por qué `{}` no es un interruptor general. Tampoco `thread/start.config` es un documento de configuración desde cero: aplica overrides a las capas.

**Conclusión:** no se encontró ni verificó una combinación que mantenga el login existente y excluya **todas** las superficies pedidas. No modificar archivos personales ni usar una copia/symlink de credenciales como supuesto arreglo. Hace falta una capacidad soportada de aislamiento o una decisión explícita sobre el contexto nativo antes de prometer ese comportamiento en Yard.

## 4. Sandbox, worktrees y ToolPolicy

**[verificado]** Se creó un repositorio desechable y un worktree detached con el gitdir común fuera de su `cwd`. Se ejecutaron comandos reales por `command/exec` con `sandboxPolicy`, sin un turno de modelo. Esto prueba al ejecutor del sandbox, no que un agente elija por sí mismo el comando correcto.

| Prueba | Resultado |
| --- | --- |
| `readOnly`, red apagada: escribir en un archivo del cwd | Exit 1, `Operation not permitted`. |
| `workspaceWrite`, `writableRoots:[]`, red apagada: escribir en el cwd | Exit 0. |
| Mismo sandbox: `git add` | Exit 0, aun con el gitdir fuera del cwd. |
| Mismo sandbox, sin raíces adicionales: escribir, `git add`, `git commit`, contar commits | Exit 0; el contador avanzó. No hizo falta conceder todo el repo como raíz escribible en este macOS. |
| Raíz adicional del `.git` común: add/commit | También exit 0; no demuestra que esa raíz sea necesaria. |
| `npm ci --ignore-scripts` con una dependencia, lockfile y caché vacía; red apagada | Exit 1, `ENOTFOUND registry.npmjs.org`. |
| Misma instalación con otra caché vacía y `networkAccess:true` | Exit 0, instaló una dependencia. |

No se probaron Linux/Windows, submódulos ni una receta con scripts de instalación. Los comandos de git dieron avisos de las herramientas de desarrollo de macOS, pero finalizaron con exit 0. No generalizar este resultado a cualquier disposición de worktrees.

**[doc]** La config TOML usa `sandbox_workspace_write.writable_roots` y `network_access`; el protocolo usa `workspaceWrite`, `writableRoots` y `networkAccess`. `thread/start` recibe `sandbox:"workspace-write"`; `turn/start` y `command/exec` admiten el objeto `sandboxPolicy`. No mezclar los formatos. `approvalPolicy:"never"` elimina la petición de aprobación, **no** concede permisos ni red.

Mapeo recomendado, todavía **no implementado ni verificado como política completa de herramientas**:

| ToolPolicy de Yard | Criterio para Codex |
| --- | --- |
| `"all"` | El hermano Claude y `docs/design.html#d-agents` dan libertad total. `workspace-write` no es equivalente. Si se conserva ese contrato, correspondería `danger-full-access` + `never`, con el entorno sin credenciales remotas del repo; no probarlo implícitamente como default seguro. |
| Rol de solo lectura | `read-only` + `never`, sin red de comandos salvo autorización explícita; además deshabilitar las herramientas que su allow/deny excluye, MCP, plugins y subagentes según corresponda. |
| Listas arbitrarias allow/deny | No traducir nombres Claude como `Bash`, `Edit` o `Task` a un modo de filesystem y darlo por equivalente. Hace falta comprobar la disponibilidad real de herramientas de Codex; rechazar una política que el runtime no pueda cumplir en lugar de ampliar permisos en silencio. |

`read-only` no significa «solo puede leer el cwd» ni elimina por sí mismo la herramienta de shell. `networkAccess:false` se refiere a los comandos sandboxeados, no impide que el servidor hable con el modelo. Tampoco el sandbox sustituye la regla del repo de que solo el core publica/pushea.

## 5. Reportes: modo estricto y matriz de la plantilla

**[doc]** El [test oficial de outputSchema](https://github.com/openai/codex/blob/rust-v0.169.1/codex-rs/app-server/tests/suite/v2/output_schema.rs) comprueba que `turn/start.outputSchema` sale como `text.format` con `name:"codex_output_schema"`, `type:"json_schema"` y **`strict:true`**. El esquema es por turno: hay que volver a enviarlo en el siguiente. No lo valida el Ajv de Claude.

**[verificado]** Se enumeraron los 19 modos de `clankerLoopTemplate.roles` usando `outputSchemaFor(mode, false)` y `outputSchemaFor(mode, true)`, como hace `packages/core/src/agents/claude/report-schema.test.ts`. Son **38 variantes, 18 JSON distintos byte a byte**. Cada JSON distinto se envió realmente a Codex; las filas iguales comparten ese mismo resultado, no turnos adicionales.

| Rol | Modos cubiertos | Sin learnings | Con learnings |
| --- | --- | --- | --- |
| dev | plan, implement, fix, council, conflict | Rechazados | Rechazados |
| review-bugs | review, re-review | Rechazados | Rechazados |
| review-tests | review, re-review | Rechazados | Rechazados |
| review-patterns | review, re-review | Rechazados | Rechazados |
| review-lore | review, re-review | Rechazados | Rechazados |
| committer | plan, route | Rechazados | Rechazados |
| triage | bot, coverage, ci | Rechazados | Rechazados |
| plan-check | check | Rechazado | Rechazado |

En los 18 casos `turn/start` respondió `inProgress`, luego llegó `error` con `willRetry:false` y finalmente `turn/completed` con `status:"failed"`. El error observado fue idéntico:

```text
Invalid schema for response_format 'codex_output_schema':
'schema.required' is required to include every key in properties. Missing 'decisions'.
type: invalid_request_error
param: text.format.schema
code: invalid_json_schema
status: 400
codexErrorInfo: other
```

Ese es el rechazo **observado**, no una prueba de que sea el único problema de cada payload. No se corrigieron progresivamente los esquemas ni se declaró compatible el resto del esquema al ocultarse detrás de ese primer error.

También se enviaron controles pequeños independientes:

| Esquema control | Resultado real |
| --- | --- |
| Objeto cerrado, `answer` string requerida | `completed`, JSON válido con `answer:"pong"`. |
| Mismo objeto con `required:[]` | Rechazado por faltar `answer` en required. |
| `answer` requerida, omitiendo `additionalProperties` del objeto | Rechazado: debe estar presente y ser `false` con strict. |
| `answer` requerida con `anyOf:[{type:"string"},{type:"null"}]`, objeto cerrado | `completed`. Solo demuestra esa unión nullable, no todas las uniones de la plantilla. |
| `answer` requerida con `oneOf` string/número | Rechazado: `schema.properties.answer.oneOf` no está permitido con strict. |

Recomendación: definir una representación de transporte de Codex y su normalización a `Report`, con pruebas por modo y roundtrip. Hacer una propiedad requerida y nullable no es lo mismo que volverla opcional en el contrato del core. **No modificar `claudeSchemaError`, el sobre compartido ni los payloads de otros runtimes en esta issue.** No se implementó ni se validó todavía un normalizador.

## 6. Concurrencia y renovación

**[verificado]** Dos procesos app-server independientes, inicializados al mismo tiempo y con el mismo home de Codex, pudieron leer los límites concurrentemente y devolvieron el mismo tipo de plan, sin error. No hubo un refresh solicitado por el experimento: `account/read` usó `refreshToken:false`.

**[doc]** En ese tag hay un [semáforo de refresh por AuthManager](https://github.com/openai/codex/blob/rust-v0.169.1/codex-rs/login/src/auth/manager.rs), [bloqueo `auth.json.lock` para commits de credenciales](https://github.com/openai/codex/blob/rust-v0.169.1/codex-rs/login/src/auth/storage_commit.rs) y [comparación de la generación antes de persistir](https://github.com/openai/codex/blob/rust-v0.169.1/codex-rs/login/src/auth/storage.rs). El bloqueo de escritura no es, por sí solo, una prueba de que dos procesos serialicen todo el intercambio de refresh por red.

**Sin verificar:** dos inferencias simultáneas, renovación concurrente de un token próximo a vencer, recuperación después de una rotación y retomar simultáneamente una misma sesión persistida. Los turnos de inferencia de esta investigación fueron efímeros y secuenciales. No se revocó, venció, renovó deliberadamente ni duplicó el login para fabricar esos casos.

No prometer seguridad de refresh multi-proceso por haber leído el mismo plan dos veces. Para la primera implementación conviene estudiar un solo app-server con threads separados por corrida; el protocolo admite múltiples threads. Esa arquitectura también necesita sus pruebas de interrupción, fencing y aislamiento; esta investigación no la dio por validada.

## 7. Uso del plan: lectura y notificaciones

**[verificado]** `account/rateLimits/read` funciona sin iniciar un turno. Este es un extracto sanitizado del resultado observado, no el objeto completo:

```json
{
  "ordinaryUsageAllowed": true,
  "rateLimits": {
    "limitId": "codex",
    "limitName": null,
    "normalModelSlug": null,
    "primary": { "usedPercent": 4, "windowDurationMins": 10080, "resetsAt": 1795542935 },
    "secondary": null,
    "credits": { "hasCredits": true, "unlimited": false, "balance": null },
    "individualLimit": null,
    "spendControlReached": false,
    "planType": "self_serve_business_prolite",
    "rateLimitReachedType": null
  }
}
```

La respuesta completa también trajo `rateLimitsByLimitId` con una única entrada `codex`, `accountId`, `rateLimitResetCredits` y `rateLimitUpsell`. Se omitieron los identificadores de cuenta y de créditos de reset. No se usaron esos créditos.

**[doc]** Los [tipos del protocolo de cuenta](https://github.com/openai/codex/blob/rust-v0.169.1/codex-rs/app-server-protocol/src/protocol/v2/account.rs) y los bindings generados por **este binario** distinguen:

- `rateLimitsByLimitId` es un mapa de **buckets de medición**, no una lista de cuentas o planes Plus/Pro/Business. `rateLimits` es la vista compatible de un bucket. No asumir dos ventanas de 5 h/7 días: aquí hubo solo una de 10080 minutos.
- `ordinaryUsageAllowed:boolean|null` es permiso del backend para uso ordinario incluido, validado para la cuenta activa. `false` no es «login vencido» ni se convierte en `true` porque un porcentaje baje o llegue una fecha de reset. `null` significa desconocido. Su interacción exacta con crédito/reserva en una cuenta bloqueada no se reprodujo.
- `credits` puede ser null; cuando existe tiene `hasCredits:boolean`, `unlimited:boolean`, `balance:string|null`. No convertir un null en cero ni asumir que el balance expresa dólares. Los créditos de reset son un recurso distinto.
- `rateLimitReachedType` puede ser null o `rate_limit_reached`, `workspace_owner_credits_depleted`, `workspace_member_credits_depleted`, `workspace_owner_usage_limit_reached`, `workspace_member_usage_limit_reached`. Se leyeron los tipos; no se provocó ninguno.

**[verificado]** Después de una inferencia llegó `account/rateLimits/updated` con **solo `{rateLimits: ...}`**, no el objeto completo de `read`. En esa actualización `spendControlReached` fue null, mientras la lectura previa tenía false. **[doc]** La notificación es parcial: los null de metadatos no borran automáticamente el último valor conocido. No usarla para inferir recuperación de `ordinaryUsageAllowed`; releer el snapshot cuando haga falta.

**¿Es gratis leerlo?** El [handler de lectura](https://github.com/openai/codex/blob/rust-v0.169.1/codex-rs/app-server/src/request_processors/account_processor.rs) consulta el backend de uso y, salvo que se omitan, detalles de créditos de reset; no llama a inferencia. Se verificó la lectura sin turno, no una factura ni la contabilidad interna del proveedor. No hay evidencia de consumo de tokens de modelo por esa lectura, pero no es una garantía de sondeo ilimitado o sin coste de red. El protocolo admite `excludeResetCreditDetails:true` para lecturas de fondo; no se midió esa variante.

No se tuvo acceso a un segundo plan, múltiples buckets, `ordinaryUsageAllowed:false`, balances numéricos ni Business con restricciones distintas. La ayuda oficial explica esos controles, pero no sustituye una captura real de esos casos.

## 8. Errores: solicitud RPC frente a turno

| Caso | Canal y estado | Evidencia |
| --- | --- | --- |
| Modelo inexistente | `thread/start` aceptó el nombre y `turn/start` respondió `inProgress`; luego `error {willRetry:false}` y `turn/completed {status:"failed"}`. Ambos errores tenían `codexErrorInfo:"modelNotFound"` y mensaje de modelo no soportado con cuenta ChatGPT. | **[verificado]**, con un nombre ficticio. No fue un rechazo JSON-RPC inmediato. |
| Esquema no aceptado | ACK `inProgress`; `error`, `willRetry:false`; turno `failed`, `codexErrorInfo:"other"`, mensaje upstream 400/`invalid_json_schema`. | **[verificado]**, matriz anterior. No se debe clasificar como cuota ni reintentar sin cambiar la entrada. |
| Config inválida al arrancar | Error por stderr y ningún handshake; se cerró/esperó el proceso. | **[verificado]**, perfil antiguo y entradas MCP incompletas. No todo fallo llegará por JSON-RPC. |
| Login vencido/401 | El protocolo declara `unauthorized` dentro de `TurnError.codexErrorInfo`; un error de request puede llegar en `{id,error:{code,message,data?}}`. El servidor puede intentar recuperación antes de informar un fallo final. | **[doc]**; no se venció ni revocó el login real y no se capturó su secuencia exacta. Un token falso no prueba el comportamiento de un refresh rechazado. |
| Cuota agotada | El protocolo declara `usageLimitExceeded` y, por separado, `rateLimitExceeded`. `error` lleva `willRetry`; el cierre del turno lleva `status` y `error`. | **[doc]**; no se agotó la cuota ni se observó qué combinación exacta emite esta cuenta. No asumir que siempre es un error RPC ni que ambos códigos significan la misma causa. |

Los bindings de 0.169.1 exponen `ErrorNotification {error,willRetry,threadId,turnId}` y `Turn {status,error,...}`. Un ACK de `turn/start` no es éxito del agente. El adapter debe atender tanto errores de request/proceso como eventos y el cierre del turno; deduplicar el mismo fallo entre evento y cierre. La secuencia real de login/cuota queda pendiente para el fake y una futura captura por uso normal, no mediante daño deliberado al login o consumo forzado.

## 9. Snippet mínimo probado con env -i

Guardar como `probe.mjs` y ejecutarlo desde una carpeta de prueba dentro del checkout. Requiere el `codex` ya instalado y autenticado. No instala paquetes ni inicia un OAuth. El modelo usado existía en `model/list` de la cuenta observada; para otra cuenta hay que elegir uno disponible.

**Este es un smoke test, no la configuración de aislamiento terminada.** Deshabilita los MCP descubiertos para el thread, notificaciones y varias extensiones, pero **no consigue quitar el AGENTS global** ni demuestra exclusión completa de skills. `INSTRUCTION_FILES` permite ver esa limitación sin imprimir rutas o contenido.

```js
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { once } from "node:events";

const settings = [
  "features.plugins=false", "features.apps=false", "features.codex_hooks=false",
  "notify=[]", "project_doc_max_bytes=0", "skills.include_instructions=false",
  "skills.bundled.enabled=false", "cloud.skills.enabled=false",
  'web_search="disabled"', "memories.use_memories=false",
  "memories.generate_memories=false",
];
const proc = spawn("codex", ["app-server", ...settings.flatMap(s => ["-c", s])], {
  stdio: ["pipe", "pipe", "ignore"],
});
const exited = once(proc, "exit");
const lines = createInterface({ input: proc.stdout });
const send = message => proc.stdin.write(JSON.stringify(message) + "\n");
const deadline = setTimeout(() => proc.kill("SIGTERM"), 90_000);
const force = setTimeout(() => proc.kill("SIGKILL"), 95_000);
let completed = false;
try {
  send({ id: 1, method: "initialize", params: {
    clientInfo: { name: "clanker_yard_research", title: "Clanker Yard research", version: "0.0.0" },
  } });
  for await (const line of lines) {
    const m = JSON.parse(line);
    if (m.error) throw new Error(`RPC error ${m.error.code}`);
    if (m.id === 1) {
      send({ method: "initialized", params: {} });
      send({ id: 2, method: "account/read", params: { refreshToken: false } });
    }
    if (m.id === 2) {
      if (m.result.account?.type !== "chatgpt") throw new Error("Not a ChatGPT login");
      console.log("AUTH", m.result.account.type);
      send({ id: 3, method: "config/read", params: { cwd: process.cwd() } });
    }
    if (m.id === 3) {
      const config = Object.fromEntries(Object.keys(m.result.config.mcp_servers ?? {})
        .map(name => [`mcp_servers.${name}.enabled`, false]));
      send({ id: 4, method: "thread/start", params: {
        cwd: process.cwd(), model: "gpt-5.6-luna", ephemeral: true,
        sandbox: "read-only", approvalPolicy: "never", config,
        baseInstructions: "Protocol test. Do not call tools. Return the requested JSON.",
      } });
    }
    if (m.id === 4) {
      console.log("INSTRUCTION_FILES", m.result.instructionSources?.length ?? 0);
      send({ id: 5, method: "turn/start", params: {
        threadId: m.result.thread.id, effort: "low",
        input: [{ type: "text", text: 'Return {"answer":"pong"}. No tools.' }],
        outputSchema: {
          type: "object", properties: { answer: { type: "string", enum: ["pong"] } },
          required: ["answer"], additionalProperties: false,
        },
      } });
    }
    if (m.method === "item/completed" && m.params.item.type === "agentMessage") {
      const answer = JSON.parse(m.params.item.text).answer;
      if (answer !== "pong") throw new Error("Unexpected answer");
      console.log("ANSWER", answer);
    }
    if (m.method === "turn/completed") {
      completed = m.params.turn.status === "completed";
      console.log("TURN", m.params.turn.status);
      break;
    }
  }
  if (!completed) throw new Error("No completed turn");
} finally {
  proc.stdin.end();
  const stop = setTimeout(() => proc.kill("SIGTERM"), 2000);
  const kill = setTimeout(() => proc.kill("SIGKILL"), 5000);
  try { await exited; } finally {
    clearTimeout(deadline); clearTimeout(force); clearTimeout(stop); clearTimeout(kill);
    lines.close();
  }
}
```

```sh
env -i HOME="$HOME" USER="$USER" \
  PATH="$HOME/.local/bin:$(dirname "$(command -v node)"):/usr/bin:/bin" \
  node probe.mjs
```

Salida observada:

```text
AUTH chatgpt
INSTRUCTION_FILES 1
ANSWER pong
TURN completed
```

La prueba esperó la salida de cada proceso y cerró stdin; los plazos también permiten terminarlo si no cierra. No se dejó un servidor de prueba corriendo.

## 10. Versión mínima y evidencia reproducible

**[verificado]** `codex --version` devolvió `codex-cli 0.169.1`. `codex app-server generate-ts --out <carpeta-de-prueba>` generó los tipos utilizados para preparar las solicitudes. Los tipos generados, los homes sintéticos y las transcripciones de diagnóstico no se incorporan al producto.

No se ejecutaron versiones anteriores ni se identificó el primer release de cada campo. Por tanto, **0.169.1 es el mínimo probado propuesto para `MIN_CODEX_VERSION`, no el mínimo histórico demostrado**. Tampoco existe en esta investigación una versión que demuestre todos los requisitos de aislamiento. No fijar una versión anterior por inferencia; si se decide soportarla, ejecutar la misma matriz y verificar presencia/capacidad de los campos.

Pruebas realizadas: entorno y variables falsas; mezcla de config sintética; lectura concurrente de límites; turnos mínimos; 18 esquemas distintos de la plantilla y cuatro controles adicionales; modelo inexistente; comandos reales del sandbox sobre un worktree y `npm ci` con cachés vacías. Las pruebas negativas conservaron sus rechazos como resultados de investigación, no como tests de producto que deban pasar.

Además, `npx vitest run packages/core/src/agents/claude/report-schema.test.ts` pasó **21 tests**: el contrato de Claude sigue intacto. No se agregaron, borraron ni modificaron tests de producción ni se corrió la suite completa. `npm run typecheck`, `npm run lint` y `npm test` siguen siendo los checks del repo que corre el core.

## Recomendación y siguientes issues

1. **No habilitar aún el runtime para los perfiles existentes.** El primer paso es resolver el formato estricto y el aislamiento: normalización local del transporte con roundtrip de cada modo; exclusión verificable de global AGENTS, skills y configuración de herramientas, sin tocar archivos personales. Si el binario no lo permite, pedir capacidad upstream o decidir explícitamente otro modo de autenticación/contexto.
2. **Conexión/autorización:** confirmar si el uso personal del binario con login existente es el encuadre admitido para Yard. Si se elige SIWC propio, tratar registro, consentimiento de automatizaciones, almacenamiento seguro y refresh como un cambio de plan explícito, no reutilizar tokens de Codex a escondidas.
3. **Runtime:** mantener el contrato de ToolPolicy, procesos registrados en `procs`, interrupción y recuperación del repo. Evaluar un servidor con varios threads antes de escoger un proceso por corrida. No declarar seguro el refresh paralelo hasta comprobarlo sin arriesgar una cuenta.
4. **Uso/breaker:** usar la lectura de límites, no una inferencia de prueba para cada sondeo; manejar buckets/ventanas opcionales y actualizaciones parciales. Probar `ordinaryUsageAllowed:false`, cuota, login y errores de request con un fake basado en tipos/código oficiales, y etiquetar lo que aún necesita captura real.
5. **Versión:** partir de 0.169.1 como baseline probado, con pruebas de capacidades; no anunciar que resuelve los bloqueantes de este documento.

### Actualizaciones de seguimiento pendientes por falta de acceso

Se intentó leer [CLA-131](https://linear.app/clanker-yard/issue/CLA-131), [CLA-133](https://linear.app/clanker-yard/issue/CLA-133) y [CLA-140](https://linear.app/clanker-yard/issue/CLA-140). Las tres páginas solo devolvieron `Loading…`. No había herramienta Linear directa disponible; el MCP de Linear consultado mediante app-server informó `notLoggedIn` y no expuso herramientas. **No se pudo revisar su contenido ni actualizar ninguna.** Tampoco se tuvo acceso a los «Riesgos abiertos» del proyecto. No se atribuye a esos números un alcance que no se pudo leer.

Actualización concreta pendiente: revisar esos tres cuerpos y agregar en el seguimiento que implemente cada parte los siguientes criterios, enlazando este documento:

- «Antes de habilitar Codex con la plantilla, adaptar el wire schema estricto y validar el roundtrip de los 19 modos, con/sin learnings: hoy los 18 JSON distintos son rechazados por `decisions` opcional».
- «No dar por aislado app-server con `{}`/strict-config/perfil ni `project_doc_max_bytes=0`: global AGENTS sigue cargándose; demostrar también exclusión de skills, MCP y extensiones sin copiar credenciales».
- «Separar lectura de uso de inferencia, preservar `ordinaryUsageAllowed` y actualizaciones parciales; el plan observado es solo `self_serve_business_prolite`. Concurrencia con refresh, Plus/Pro y login/cuota reales siguen pendientes».
- «Confirmar el encuadre del login delegado frente a SIWC propio antes de distribuirlo; no introducir copia de auth.json como solución de aislamiento».

La propuesta cambia cualquier plan que suponga reportes compatibles sin adaptación o aislamiento completo ya resuelto. **Queda impedida su incorporación a Linear, no realizada.**

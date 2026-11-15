import { eventIterator, oc } from "@orpc/contract";
import * as z from "zod";
import { ClaudeMode, ClaudeStatus, Connection, ConnectionProvider, GitHubPatForm } from "./connections";
import {
  ArtifactHash,
  ArtifactKind,
  DecisionId,
  Event,
  EventFilter,
  IssueId,
  ProjectId,
  RepoId,
  RunId,
  StepRunId,
} from "./domain";
import { Decision, DecisionFilter } from "./decisions";
import { DefFilter, DefRecord, DefRef } from "./defs";
import { LegacyImportInput, LegacyImportResult } from "./import";
import { DayMetrics, DayMetricsFilter, MetricsFilter, ModelMetrics, ProjectSummary, RoleMetrics } from "./metrics";
import { ClankerProject, NewProject, ProjectPatch } from "./projects";
import { CachedPr, PrFilter, PrRef, PrState } from "./prs";
import { QueueEntry } from "./queue";
import type { ContractMeta } from "./mcp";
import { DetectedRepo, NewRepo, RecipeTestResult, Repo } from "./repos";
import { Run, RunDetail, RunFilter, StartRun, StepDetail, TranscriptPage, TranscriptQuery } from "./runs";
import { CachedIssue, IssueFilter, NewLocalIssue } from "./tracker";

/**
 * Versión mayor de la API. Sube cuando el contrato cambia de forma incompatible; el core la
 * informa en `system.health` y la app, si difiere de la suya, relanza el core (`d-data`, "Handshake").
 */
export const API_MAJOR = 1;

const base = oc.$meta<ContractMeta>({});

/** Los kinds de `defs` que `list` y `get` sirven: los que ya tienen esquema (`context` no). */
const DEF_MCP_KINDS = ["flow", "role", "profile", "recipe", "pack"] as const;

const system = {
  /** Handshake de versión: la app lo compara con su `apiMajor` para decidir si relanza el core. */
  health: base.output(
    z.object({
      coreVersion: z.string(),
      apiMajor: z.int().nonnegative(),
      schemaVersion: z.int().nonnegative(),
      bootId: z.string(),
      activeRuns: z.int().nonnegative(),
    }),
  ),
  /** Datos del proceso del core; `health` solo lleva lo que necesita el handshake. */
  info: base.output(
    z.object({
      pid: z.int().positive(),
      /** ms epoch */
      startedAt: z.int().nonnegative(),
      dataDir: z.string(),
      platform: z.enum(["darwin", "linux", "win32"]),
    }),
  ),
  /** Con `drain` el core no toma pasos nuevos y espera las acciones en curso antes de salir. */
  shutdown: base.input(z.object({ drain: z.boolean() })),
};

const events = {
  /** Eventos con `seq > after`, en orden de `seq`. */
  list: base
    .meta({ mcp: { resource: "run_timeline" } })
    .input(
      z.object({
        after: z.int().nonnegative().default(0),
        limit: z.int().min(1).max(500).default(100),
        filter: EventFilter.default({}),
      }),
    )
    .output(z.array(Event)),
  /**
   * Rellena desde `after` (o desde el `Last-Event-ID` del reconectado) y sigue en vivo, sin
   * duplicados. El `id` de cada mensaje SSE es su `seq`.
   */
  stream: base
    .input(
      z.object({
        after: z.int().nonnegative().optional(),
        filter: EventFilter.default({}),
      }),
    )
    .output(eventIterator(Event)),
};

const connections = {
  /** Cuentas conectadas, sin sus tokens. */
  list: base.output(z.array(Connection)),
  /**
   * Valida el fine-grained PAT contra GitHub (usuario, repos y un check por permiso) y lo conecta con
   * la cuenta a la que pertenece. Rechaza el token con un mensaje accionable si GitHub lo rechaza, si
   * no ve repos o si le falta un permiso. Sin `meta.mcp`: un token no pasa por el MCP.
   */
  setPat: base.input(z.object({ token: z.string().min(1) })).output(Connection),
  /** El link y la lista de permisos para crear el PAT. */
  githubPatForm: base.output(GitHubPatForm),
  /**
   * Inicia el login de Linear (OAuth con PKCE) y devuelve el `url` que hay que abrir en el navegador: el
   * core no lo abre. Responde en cuanto el core escucha el redirect; la cuenta aparece al aprobar, con un
   * `connection.changed`. Falla con `BAD_REQUEST` si el core no tiene el `client_id` de la OAuth app o el
   * puerto del redirect está ocupado. Sin `meta.mcp`: el login lo hace una persona.
   */
  linearAuth: base.output(z.object({ url: z.url() })),
  /**
   * Prueba Claude con una llamada mínima (haiku, un turno, sin herramientas): detecta el `claude`
   * instalado y su versión, el login y el plan, y lee cuánto va usado de la cuota. `mode` por defecto es
   * el activo: la API key si hay una guardada, y si no la suscripción. Un resultado concluyente deja la
   * cuenta `claude` conectada (o `expired` / `revoked`) y emite `connection.changed`. Gasta un poco de
   * cuota, así que la UI la llama al pulsar [Probar], no al pintar. `BAD_REQUEST` si pide `api-key` sin
   * tener una guardada. Sin `meta.mcp`: un agente no debe gastar la cuota de la persona.
   */
  testClaude: base.input(z.object({ mode: ClaudeMode.optional() }).default({})).output(ClaudeStatus),
  /**
   * Guarda una API key de Anthropic como alternativa a la suscripción (en `Secrets`, nunca en la base) y
   * la deja activa: desde entonces los agentes la usan. Antes la prueba con una llamada mínima y no
   * guarda nada si Anthropic la rechaza (`BAD_REQUEST`). Para volver a la suscripción:
   * `disconnect({ provider: "claude", account: "api-key" })`. Sin `meta.mcp`: un token no pasa por el MCP.
   */
  setClaudeApiKey: base.input(z.object({ key: z.string().min(1) })).output(Connection),
  /** Borra el token y la cuenta; no hace nada si no estaba conectada. Emite `connection.changed`. */
  disconnect: base
    .input(z.object({ provider: ConnectionProvider, account: z.string().min(1) }))
    .output(z.void()),
};

const artifacts = {
  /** El contenido tal cual se guardó. Si no existe ese hash, falla con `NOT_FOUND`. */
  get: base.input(z.object({ hash: ArtifactHash })).output(
    z.object({
      hash: ArtifactHash,
      kind: ArtifactKind,
      mime: z.string(),
      size: z.int().nonnegative(),
      content: z.instanceof(Blob),
    }),
  ),
};

const issues = {
  /** Del caché, no del tracker. Orden: prioridad (urgente primero, sin prioridad al final) y luego la creación. */
  list: base
    .input(IssueFilter.extend({ projectId: ProjectId.optional() }))
    .output(z.array(CachedIssue)),
  /** Del caché, con sus relaciones. */
  get: base.input(z.object({ id: IssueId })).output(CachedIssue),
  /**
   * Crea una issue en el tracker local (demos y fixtures) y la deja en el caché. El proyecto debe
   * existir y ser de tracker `local`; si no, falla con `NOT_FOUND` o `BAD_REQUEST`.
   */
  createLocal: base
    .input(NewLocalIssue.extend({ projectId: ProjectId }))
    .output(CachedIssue),
};

const projects = {
  list: base.meta({ mcp: { tool: "list", kind: "project" } }).output(z.array(ClankerProject)),
  /** Falla con `NOT_FOUND` si no existe. */
  get: base
    .meta({ mcp: { tool: "get", kind: "project" } })
    .input(z.object({ id: ProjectId }))
    .output(ClankerProject),
  /**
   * Falla con `BAD_REQUEST` si el slug o el par (tracker, trackerRef) ya existen, si el flujo o el
   * perfil por defecto no existen, o si un repo no está registrado (`repos.add`), se repite o comparte
   * un label con otro repo del proyecto.
   */
  create: base.input(NewProject).output(ClankerProject),
  /** Cambia solo los campos presentes; las mismas validaciones que `create`. */
  update: base.input(ProjectPatch.extend({ id: ProjectId })).output(ClankerProject),
  /**
   * La cola del proyecto, calculada por el core a partir del caché de issues, sus corridas y sus PRs:
   * primero las `ready` (en el orden en que se lanzarían), luego `waiting` y `blocked`, cada una con su
   * motivo. `NOT_FOUND` si el proyecto no existe; `BAD_REQUEST` si el core no tiene adapter de su tracker.
   */
  queue: base.input(z.object({ id: ProjectId })).output(z.array(QueueEntry)),
  /** Totales, rondas y costo por rol de las corridas cerradas del proyecto. `NOT_FOUND` si no existe. */
  summary: base.input(z.object({ id: ProjectId })).output(ProjectSummary),
};

const prs = {
  /**
   * Lee el PR de GitHub (una query GraphQL de detalle) y lo entrega normalizado con las reglas del pack
   * de la org del repo. `NOT_FOUND` si el repo o el PR no existen o la cuenta no los ve; `BAD_REQUEST`
   * si la cuenta no está conectada.
   */
  get: base.input(PrRef).output(PrState),
  /**
   * Los PRs que Watch conoce, del caché de `pull_requests` y sin tocar GitHub: los que abrió el sistema
   * y los que descubrió en tu búsqueda de PRs abiertos, ordenados por repo y número.
   */
  list: base.input(PrFilter.default({})).output(z.array(CachedPr)),
  /**
   * Como `get`, pero además deja el resultado en el caché y, si el estado cambió, avisa a los waits que
   * esperan este PR: sirve para no esperar al polling. Los mismos errores que `get`.
   */
  refresh: base.input(PrRef).output(PrState),
};

const repos = {
  /** Por nombre. */
  list: base.output(z.array(Repo)),
  /**
   * Registra el checkout de `path`, que debe ser la raíz de un repo de git: el nombre, la branch por
   * defecto y el remoto de GitHub salen de él. `BAD_REQUEST` si no es la raíz de un repo o ya está
   * registrado.
   */
  add: base.input(NewRepo).output(Repo),
  /**
   * Los repos de git que hay en `folder` (la propia carpeta si es un repo; si no, sus subcarpetas
   * directas), cada uno con su receta: encontrada, falta o inválida. No registra nada.
   */
  detect: base.input(z.object({ folder: z.string().min(1) })).output(z.array(DetectedRepo)),
  /**
   * Corre la receta de un repo sobre un worktree desechable: `requires`, `setup.worktree`, `setup.guard`
   * y `setup.slot`, con un slot libre del pool de mantenimiento (si la receta define `slots`). La salida va en vivo por los eventos
   * `recipe.test_started`, `recipe.test_output` y `recipe.test_finished` (payload con `repoId`) y la
   * llamada vuelve al terminar. `BAD_REQUEST` si el repo no tiene receta o es inválida, o si ya hay una
   * prueba en curso de ese repo, o si los slots de mantenimiento están ocupados; `NOT_FOUND` si no está registrado.
   */
  testRecipe: base.input(z.object({ repoId: RepoId })).output(RecipeTestResult),
};

const runs = {
  /** De la más reciente a la más antigua. Sin pasos: están en `get`. */
  list: base
    .meta({ mcp: { tool: "list", kind: "run" } })
    .input(RunFilter.default({}))
    .output(z.array(Run)),
  /** Con sus pasos, sus outcomes y el costo. `NOT_FOUND` si no existe. */
  get: base
    .meta({ mcp: { tool: "get", kind: "run" } })
    .input(z.object({ id: RunId }))
    .output(RunDetail),
  /**
   * Lo del panel de un paso que `get` no trae: sus sesiones de agente con el reporte validado, sus
   * artefactos (el brief que recibió y lo que dejó; contenido con `artifacts.get`) y, en una acción,
   * los comandos que corrió con su salida y su código de salida. `NOT_FOUND` si no existe el paso.
   */
  step: base
    .meta({ mcp: { resource: "step_report" } })
    .input(z.object({ id: StepRunId }))
    .output(StepDetail),
  /**
   * El transcript completo de una sesión de agente, normalizado y paginado por `cursor` (un offset
   * en el archivo, no un número de página: sirve para seguir una sesión que todavía escribe). Una sesión
   * sin transcript (el runtime no lo guarda, o aún no escribió) devuelve una página vacía.
   * `NOT_FOUND` si no existe la sesión.
   */
  transcript: base.input(TranscriptQuery).output(TranscriptPage),
  /**
   * Lanza el flujo del proyecto (o `flow`) sobre una issue del proyecto y vuelve sin esperar: el
   * progreso llega por `events.stream` filtrando por el `runId`. Reclama la issue en su tracker
   * (asignada a ti y en progreso) y pasa `repo` y `base` al flujo si los declara: el repo sale de los
   * labels de la issue (ver `ProjectRepo`) y la base es su branch por defecto; `flowParams` del
   * proyecto y `params` los pisan. Es idempotente: si ya hay una corrida viva de ese flujo sobre la
   * issue devuelve esa. `BAD_REQUEST` si el proyecto no está activo, no hay flujo, faltan params o falta
   * el perfil, o el tracker no puede reclamar la issue; `NOT_FOUND` si el proyecto o la issue no existen.
   */
  start: base.input(StartRun).output(RunDetail),
};

const imports = {
  /**
   * Importa el historial del clanker-loop (`docs/design.html#d-data`, "Migración desde el clanker-loop"):
   * proyectos, issues, PRs y las corridas de `metrics.jsonl` con sus métricas. Solo lee `from` y se puede
   * repetir: cada corrida lleva una clave de origen y lo ya importado no se duplica. Emite `import.completed`.
   * Sin `meta.mcp`: lee archivos del disco de la persona. `BAD_REQUEST` si `from` no es una carpeta del
   * loop (sin `metrics.jsonl`) o una fila no cumple el formato.
   */
  legacy: base.input(LegacyImportInput).output(LegacyImportResult),
};

const metrics = {
  /** Por costo, de más a menos. */
  byRole: base.input(MetricsFilter.default({})).output(z.array(RoleMetrics)),
  /** Por día de cierre, del más antiguo al más reciente. */
  byDay: base.input(DayMetricsFilter.default({ utcOffsetMinutes: 0 })).output(z.array(DayMetrics)),
  /** Por costo, de más a menos. */
  byModel: base.input(MetricsFilter.default({})).output(z.array(ModelMetrics)),
};

const decisions = {
  /** La bandeja: de la más reciente a la más antigua. Sin filtro trae todas, resueltas incluidas. */
  list: base
    .meta({ mcp: { tool: "list", kind: "decision" } })
    .input(DecisionFilter.default({}))
    .output(z.array(Decision)),
  /** `NOT_FOUND` si no existe. */
  get: base
    .meta({ mcp: { tool: "get", kind: "decision" } })
    .input(z.object({ id: DecisionId }))
    .output(Decision),
  /**
   * Resuelve la decisión que tiene estacionada una corrida y la devuelve ya cerrada. La opción es una
   * de `options`: en un gate, el outcome con que sigue el flujo; en un `needs_human`, `retry`,
   * `force:<outcome>` o `cancel`; en el tope de una corrida, `continue` o `cancel`. La corrida vuelve a
   * la cola de su carril. `NOT_FOUND` si no existe; `BAD_REQUEST` si ya se resolvió, no tiene una
   * corrida esperándola o la opción no es suya.
   */
  resolve: base.input(z.object({ id: DecisionId, option: z.string().min(1) })).output(Decision),
};

/** Flujos, roles, perfiles, recetas y packs: lo versionado en `defs`, leído por kind. */
const defs = {
  /** Las vigentes del kind con su versión vigente, por slug; las archivadas solo con `includeArchived`. */
  list: base
    .meta({ mcp: { tool: "list", kind: DEF_MCP_KINDS } })
    .input(DefFilter)
    .output(z.array(DefRecord)),
  /** `NOT_FOUND` si el id no existe en ese kind o no tiene esa versión. */
  get: base
    .meta({ mcp: { tool: "get", kind: DEF_MCP_KINDS } })
    .input(DefRef)
    .output(DefRecord),
};

export const contract = { system, events, connections, artifacts, issues, projects, prs, repos, runs, decisions, metrics, defs, imports };
export type Contract = typeof contract;

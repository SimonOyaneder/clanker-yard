import { eventIterator, oc } from "@orpc/contract";
import * as z from "zod";
import { Connection, ConnectionProvider, GitHubPatForm } from "./connections";
import {
  ArtifactHash,
  ArtifactKind,
  type DefKind,
  Event,
  EventFilter,
  IssueId,
  ProjectId,
  RunId,
} from "./domain";
import { ClankerProject, NewProject, ProjectPatch } from "./projects";
import { Run, RunDetail, RunFilter, StartRun } from "./runs";
import { CachedIssue, IssueFilter, NewLocalIssue } from "./tracker";

/**
 * Convención `.meta({ mcp })` (`docs/design.html#d-data`, "Tools MCP desde el mismo contrato").
 * Un procedimiento que se expone como tool MCP lo declara aquí, en el contrato, con una de dos formas:
 *
 * - CRUD por kind de def: `.meta({ mcp: { tool: "list", kind: "flow" } })`. Las tools `list`, `get`,
 *   `create`, `update` y `delete` reciben `{ kind, id?, data?, dryRun? }` y despachan al procedimiento
 *   marcado para ese kind.
 * - Acción: `.meta({ mcp: { action: "retry_step", annotations: { idempotentHint: true } } })`. Una tool
 *   por acción, con el input zod del procedimiento tal cual.
 *
 * Regla de anotaciones: `list` y `get` van con `readOnlyHint`, `update` con `idempotentHint`, `delete` e
 * `interrupt_run` con `destructiveHint`, y todas con `openWorldHint: false` salvo las que publican en
 * GitHub o Linear. El generador (todavía no existe) debe fallar si un procedimiento con `meta.mcp` no
 * declara anotaciones.
 */
export type McpMeta =
  | {
      tool: "list" | "get" | "create" | "update" | "delete";
      kind: DefKind;
    }
  | { action: string; annotations?: McpAnnotations };

export interface McpAnnotations {
  readOnlyHint?: boolean;
  idempotentHint?: boolean;
  destructiveHint?: boolean;
  openWorldHint?: boolean;
}

export interface ContractMeta {
  mcp?: McpMeta;
}

/**
 * Versión mayor de la API. Sube cuando el contrato cambia de forma incompatible; el core la
 * informa en `system.health` y la app, si difiere de la suya, relanza el core (`d-data`, "Handshake").
 */
export const API_MAJOR = 1;

const base = oc.$meta<ContractMeta>({});

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
  list: base.output(z.array(ClankerProject)),
  /** Falla con `NOT_FOUND` si no existe. */
  get: base.input(z.object({ id: ProjectId })).output(ClankerProject),
  /**
   * Falla con `BAD_REQUEST` si el slug o el par (tracker, trackerRef) ya existen, o si el flujo o el
   * perfil por defecto no existen.
   */
  create: base.input(NewProject).output(ClankerProject),
  /** Cambia solo los campos presentes; las mismas validaciones que `create`. */
  update: base.input(ProjectPatch.extend({ id: ProjectId })).output(ClankerProject),
};

const runs = {
  /** De la más reciente a la más antigua. Sin pasos: están en `get`. */
  list: base.input(RunFilter.default({})).output(z.array(Run)),
  /** Con sus pasos, sus outcomes y el costo. `NOT_FOUND` si no existe. */
  get: base.input(z.object({ id: RunId })).output(RunDetail),
  /**
   * Lanza el flujo del proyecto (o `flow`) sobre una issue del proyecto y vuelve sin esperar: el
   * progreso llega por `events.stream` filtrando por el `runId`. Es idempotente: si ya hay una corrida
   * viva de ese flujo sobre la issue devuelve esa. `BAD_REQUEST` si el proyecto no está activo, no hay
   * flujo, faltan params o falta el perfil; `NOT_FOUND` si el proyecto o la issue no existen.
   */
  start: base.input(StartRun).output(RunDetail),
};

export const contract = { system, events, connections, artifacts, issues, projects, runs };
export type Contract = typeof contract;

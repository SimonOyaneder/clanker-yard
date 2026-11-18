import {
  contract as apiContract,
  MCP_KIND_SCHEMAS,
  type ContractMeta,
  type KindSchema,
  type McpAnnotations,
  type McpKind,
  type McpMeta,
  type McpResourceName,
} from "@clanker/api";
import * as z from "zod";

type Contract = Record<string, unknown>;

/** Cómo llamar al procedimiento que sirve una tool o un resource. */
export interface McpRoute {
  /** Ruta en el router, por ejemplo `["runs", "get"]`. */
  path: string[];
  /** Sirve a varios kinds: su input lleva `kind`. */
  shared: boolean;
  hasInput: boolean;
}

export interface McpTool {
  name: string;
  description: string;
  annotations: McpAnnotations;
  inputSchema: z.ZodObject;
  /** Por kind en `list` y `get`; una acción tiene la suya bajo la clave `""`. */
  routes: ReadonlyMap<string, McpRoute>;
}

export interface McpPlan {
  tools: McpTool[];
  /** `clanker://schema/<kind>` de cada kind que alguna tool sirve. */
  schemas: ReadonlyMap<McpKind, object>;
  resources: Record<McpResourceName, McpRoute>;
}

export interface GenerateOptions {
  kindSchemas?: Partial<Record<McpKind, KindSchema>>;
}

type WriteToolName = "create" | "update" | "delete";
type ToolName = "list" | "get" | WriteToolName;

/** Anotaciones de las tools por kind (`docs/design.html#d-data`); la regla está en `McpMeta`. */
const READ_ONLY: McpAnnotations = { readOnlyHint: true, openWorldHint: false };
const TOOL_ANNOTATIONS: Record<ToolName, McpAnnotations> = {
  list: READ_ONLY,
  get: READ_ONLY,
  create: { destructiveHint: false, openWorldHint: false },
  update: { destructiveHint: false, idempotentHint: true, openWorldHint: false },
  delete: { destructiveHint: true, idempotentHint: true, openWorldHint: false },
};

const isWrite = (name: ToolName): name is WriteToolName => name === "create" || name === "update" || name === "delete";

/** Lo que se le dice al modelo de cada tool de escritura; `kinds` son los que sirve. */
const WRITE_DESCRIPTIONS: Record<WriteToolName, (kinds: string[]) => string> = {
  create: (kinds) =>
    `Crea una entidad nueva (${kinds.join(", ")}) con la versión 1. El esquema de su body está en el resource clanker://schema/<kind>. Con dryRun valida y devuelve los errores sin guardar; un flujo se valida además contra los roles, acciones y subflujos que existen.`,
  update: (kinds) =>
    `Reemplaza el body de una entidad (${kinds.join(", ")}) y guarda una versión nueva: las corridas en curso siguen con la suya. Con dryRun devuelve los errores o el diff contra la versión vigente sin guardar. Para deshacer, \`get\` con una \`version\` anterior y \`update\` con su body. Las defs builtin y de packs no se editan: crea una de scope user con el mismo slug.`,
  delete: (kinds) =>
    `Archiva una entidad (${kinds.join(", ")}); no la borra, conserva sus versiones y nunca toca las corridas que la usaron ni su historial. Se deshace desde la UI.`,
};

const RESOURCE_NAMES: readonly McpResourceName[] = ["run_timeline", "step_report"];

/**
 * Recorre el contrato y arma lo que el MCP expone, sin tocar el SDK: las tools por kind (`list`, `get`,
 * `create`, `update` y `delete`), las acciones, los esquemas y los procedimientos de los resources. Lanza con un mensaje accionable si
 * un procedimiento con `meta.mcp` no cumple la convención (anotaciones, esquema del kind), porque el
 * MCP se arma al arrancar el core y un contrato mal marcado no debe llegar a un cliente.
 */
export function generateMcp(contract: Contract = apiContract, { kindSchemas = MCP_KIND_SCHEMAS }: GenerateOptions = {}): McpPlan {
  const byTool = new Map<ToolName, Map<string, McpRoute>>();
  /** El input de cada tool de escritura: la tool lo toma tal cual, así que lo sirve un solo procedimiento. */
  const writeInputs = new Map<WriteToolName, { where: string; input: z.ZodObject; shared: boolean }>();
  const actions: McpTool[] = [];
  const resources = new Map<McpResourceName, McpRoute>();
  const filters = new Map<McpKind, z.ZodObject>();

  for (const { path, procedure } of procedures(contract, [])) {
    const meta: McpMeta | undefined = procedure["~orpc"].meta.mcp;
    if (!meta) continue;
    const where = path.join(".");
    const input = procedure["~orpc"].inputSchema;
    const route = (shared: boolean): McpRoute => ({ path, shared, hasInput: input !== undefined });

    if ("resource" in meta && meta.resource !== undefined) {
      if (resources.has(meta.resource)) throw new Error(`${where}: el resource "${meta.resource}" ya lo declara otro procedimiento.`);
      resources.set(meta.resource, route(false));
    }

    if ("tool" in meta) {
      if (isWrite(meta.tool)) {
        const written = writeInputs.get(meta.tool);
        if (written && written.where !== where) {
          throw new Error(`${where}: la tool "${meta.tool}" ya la sirve ${written.where}; una tool de escritura toma el input de un solo procedimiento.`);
        }
        if (!input) throw new Error(`${where}: la tool "${meta.tool}" necesita un input.`);
        writeInputs.set(meta.tool, { where, input: objectOf(where, input), shared: typeof meta.kind !== "string" });
      }
      const kinds = typeof meta.kind === "string" ? [meta.kind] : meta.kind;
      const routes = byTool.get(meta.tool) ?? new Map<string, McpRoute>();
      byTool.set(meta.tool, routes);
      for (const kind of kinds) {
        if (!kindSchemas[kind]) throw new Error(`${where}: el kind "${kind}" no tiene esquema; agrégalo a MCP_KIND_SCHEMAS.`);
        if (routes.has(kind)) throw new Error(`${where}: la tool "${meta.tool}" ya tiene un procedimiento para el kind "${kind}".`);
        routes.set(kind, route(typeof meta.kind !== "string"));
        if (meta.tool === "list" && input) filters.set(kind, filterOf(where, input, typeof meta.kind !== "string"));
      }
    } else if ("action" in meta) {
      if (!meta.annotations) throw new Error(`${where}: la acción "${meta.action}" no declara anotaciones (readOnlyHint, destructiveHint...).`);
      actions.push({
        name: meta.action,
        description: meta.description,
        annotations: meta.annotations,
        inputSchema: input === undefined ? z.strictObject({}) : objectOf(where, input),
        routes: new Map([["", route(false)]]),
      });
    }
  }

  const tools = [...byTool].map(([name, routes]) => (isWrite(name) ? writeTool(name, routes, writeInputs.get(name)!) : crudTool(name, routes, filters)));
  const schemas = new Map<McpKind, object>();
  for (const tool of tools) {
    for (const kind of tool.routes.keys() as Iterable<McpKind>) {
      const { schema, io } = kindSchemas[kind]!;
      schemas.set(kind, z.toJSONSchema(schema, { io }));
    }
  }
  const allTools = [...tools, ...actions];
  const names = new Set<string>();
  for (const { name } of allTools) {
    if (names.has(name)) throw new Error(`El MCP ya declara una tool llamada "${name}".`);
    names.add(name);
  }
  return { tools: allTools, schemas, resources: requireAll(resources) };
}

function crudTool(name: "list" | "get", routes: Map<string, McpRoute>, filters: Map<McpKind, z.ZodObject>): McpTool {
  const kind = z.enum(nonEmpty([...routes.keys()])).describe("Qué entidad.");
  if (name === "get") {
    return {
      name,
      description: "Trae una entidad por kind y id. Los esquemas están en los resources clanker://schema/<kind>.",
      annotations: TOOL_ANNOTATIONS.get,
      inputSchema: z.object({
        kind,
        id: z.string().min(1).describe("El id de la entidad (`list` los muestra)."),
        version: z.int().positive().optional().describe("Solo para flow, role, profile, recipe y pack: una versión anterior; sin ella, la vigente."),
      }),
      routes,
    };
  }
  const filterDocs = [...filters].map(([k, schema]) => `- ${k}: ${describeFields(schema)}`).join("\n");
  return {
    name,
    description: `Lista las entidades de un kind. Los esquemas están en los resources clanker://schema/<kind>. Filtros por kind (los que no aparecen no tienen):\n${filterDocs}`,
    annotations: TOOL_ANNOTATIONS.list,
    inputSchema: z.object({
      kind,
      filter: z.record(z.string(), z.unknown()).optional().describe("Campos del filtro del kind, como `{ \"status\": [\"running\"] }`."),
    }),
    routes,
  };
}

function writeTool(name: WriteToolName, routes: Map<string, McpRoute>, { input, shared }: { input: z.ZodObject; shared: boolean }): McpTool {
  const kinds = [...routes.keys()];
  const kind = z.enum(nonEmpty(kinds)).describe("Qué entidad.");
  // Un procedimiento compartido recibe `kind` en su input: la tool lo declara con los kinds que sirve.
  const fields = shared ? input.omit({ kind: true }).shape : input.shape;
  return {
    name,
    description: WRITE_DESCRIPTIONS[name](kinds),
    annotations: TOOL_ANNOTATIONS[name],
    inputSchema: z.object({ kind, ...fields }),
    routes,
  };
}

/** `a?: string, b: string[]`: lo justo para que el cliente sepa qué filtros existen sin leer un JSON Schema entero. */
function describeFields(schema: z.ZodObject): string {
  const { properties = {}, required = [] } = z.toJSONSchema(schema, { io: "input" }) as {
    properties?: Record<string, FieldSchema>;
    required?: string[];
  };
  const fields = Object.entries(properties).map(([key, field]) => `${key}${required.includes(key) ? "" : "?"}: ${describeType(field)}`);
  return fields.length === 0 ? "sin filtros" : fields.join(", ");
}

interface FieldSchema {
  type?: string;
  enum?: unknown[];
  items?: FieldSchema;
}

function describeType(field: FieldSchema): string {
  if (field.enum) return field.enum.map(String).join("|");
  if (field.type === "array") return `${describeType(field.items ?? {})}[]`;
  return field.type ?? "json";
}

/** Lo que el generador lee de un `ContractProcedure`. */
interface ProcedureDef {
  "~orpc": { meta: ContractMeta; inputSchema?: unknown };
}

const isProcedure = (node: unknown): node is ProcedureDef => typeof node === "object" && node !== null && "~orpc" in node;

/** Los procedimientos del contrato con su ruta, en el orden en que están declarados. */
function* procedures(node: unknown, path: string[]): Generator<{ path: string[]; procedure: ProcedureDef }> {
  if (isProcedure(node)) {
    yield { path, procedure: node };
  } else if (typeof node === "object" && node !== null) {
    for (const [key, child] of Object.entries(node)) yield* procedures(child, [...path, key]);
  }
}

/** El filtro de un `list` como objeto, sin el `kind` que un procedimiento compartido recibe aparte. */
function filterOf(where: string, input: unknown, shared: boolean): z.ZodObject {
  const object = objectOf(where, input);
  return shared ? object.omit({ kind: true }) : object;
}

/** El input de un procedimiento marcado debe ser un objeto zod (con o sin default): así se arma el de la tool. */
function objectOf(where: string, input: unknown): z.ZodObject {
  let schema = input;
  while (schema instanceof z.ZodDefault || schema instanceof z.ZodOptional) schema = schema.unwrap();
  if (!(schema instanceof z.ZodObject)) throw new Error(`${where}: el input de un procedimiento con meta.mcp debe ser un objeto zod.`);
  return schema;
}

function requireAll(found: Map<McpResourceName, McpRoute>): Record<McpResourceName, McpRoute> {
  const [timeline, report] = RESOURCE_NAMES.map((name) => {
    const route = found.get(name);
    if (!route) throw new Error(`Ningún procedimiento declara meta.mcp.resource "${name}".`);
    return route;
  });
  return { run_timeline: timeline!, step_report: report! };
}

function nonEmpty<T>(items: T[]): [T, ...T[]] {
  const [first, ...rest] = items;
  if (first === undefined) throw new Error("No hay ninguna entidad que exponer.");
  return [first, ...rest];
}

import type { IncomingMessage, ServerResponse } from "node:http";
import { contract, devContract, Event, MCP_KIND_SCHEMAS, StepDetail, type McpKind } from "@clanker/api";
import { McpServer, ResourceTemplate, type CallToolResult, type ReadResourceResult } from "@modelcontextprotocol/server";
import { NodeStreamableHTTPServerTransport } from "@modelcontextprotocol/node";
import { createRouterClient, ORPCError } from "@orpc/server";
import * as z from "zod";
import type { DevRouter } from "../server/dev-router";
import type { CoreRouter } from "../server/router";
import { generateMcp, type McpPlan, type McpRoute, type McpTool } from "./generate";

/** Eventos por página de `events.list` al leer la línea de tiempo de una corrida (el máximo del contrato). */
const TIMELINE_PAGE = 500;

type Call = (route: McpRoute, input: unknown) => Promise<unknown>;

/**
 * El MCP de la app (`docs/design.html#mcp`): un `McpServer` por request, sin sesión, armado desde el
 * contrato (`generateMcp`) y que llama al router en proceso con origin `mcp`: la misma validación y los
 * mismos eventos que la UI. Falla al crearse si el contrato está mal marcado. Con `dev`, `router` trae además el
 * router `dev` y el MCP suma sus tools (`devContract`).
 */
export function createMcpHandler(
  router: CoreRouter | (CoreRouter & { dev: DevRouter }),
  coreVersion: string,
  { dev }: { dev: boolean },
): (req: IncomingMessage, res: ServerResponse) => Promise<void> {
  const plan = generateMcp(dev ? { ...contract, dev: devContract } : contract);
  const client = createRouterClient(router, { context: { origin: "mcp" } });
  const call: Call = (route, input) => procedureAt(client, route.path)(route.hasInput ? input : undefined);

  return async (req, res) => {
    const server = buildServer(plan, call, coreVersion);
    const transport = new NodeStreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    res.on("close", () => {
      void transport.close();
      void server.close();
    });
    try {
      await server.connect(transport);
      await transport.handleRequest(req, res);
    } catch (error) {
      console.error(error);
      if (!res.headersSent) res.writeHead(500).end();
    }
  };
}

function buildServer(plan: McpPlan, call: Call, coreVersion: string): McpServer {
  const server = new McpServer({ name: "clanker-yard", version: coreVersion });

  for (const tool of plan.tools) {
    server.registerTool(
      tool.name,
      { description: tool.description, inputSchema: tool.inputSchema, annotations: tool.annotations },
      async (args): Promise<CallToolResult> => {
        try {
          return json(await call(...toolCall(tool, args)));
        } catch (error) {
          // Un pedido inválido o algo que no existe: se le explica al modelo para que corrija; el resto es un bug del core.
          if (error instanceof ORPCError) return { isError: true, content: [{ type: "text", text: `${error.code}: ${error.message}` }] };
          throw error;
        }
      },
    );
  }

  for (const [kind, schema] of plan.schemas) {
    server.registerResource(
      `schema-${kind}`,
      `clanker://schema/${kind}`,
      { description: `JSON Schema ${MCP_KIND_SCHEMAS[kind].io === "output" ? `de lo que \`get\` devuelve para ${kind}` : `del body de un ${kind}`}.`, mimeType: "application/json" },
      (uri) => resource(uri, schema),
    );
  }

  const flowGet = routeOf(plan, "get", "flow");
  const flowList = routeOf(plan, "list", "flow");
  server.registerResource(
    "flow",
    new ResourceTemplate("clanker://flow/{id}", {
      list: async () => ({
        resources: z
          .array(z.object({ id: z.string(), slug: z.string() }))
          .parse(await call(flowList, withKind(flowList, "flow", undefined)))
          .map(({ id, slug }) => ({ uri: `clanker://flow/${id}`, name: slug })),
      }),
    }),
    { description: "La definición de un flujo con su versión vigente.", mimeType: "application/json" },
    async (uri, { id }) => resource(uri, await call(flowGet, withKind(flowGet, "flow", { id }))),
  );

  server.registerResource(
    "run-timeline",
    new ResourceTemplate("clanker://run/{id}/timeline", { list: undefined }),
    { description: "La línea de tiempo de una corrida: sus eventos en orden.", mimeType: "application/json" },
    async (uri, { id }) => resource(uri, await timeline(call, plan.resources.run_timeline, String(id))),
  );

  server.registerResource(
    "step-report",
    new ResourceTemplate("clanker://step/{id}/report", { list: undefined }),
    { description: "El reporte de un paso: el de cada sesión de agente que lo corrió, con su estado.", mimeType: "application/json" },
    async (uri, { id }) => {
      const { sessions } = StepDetail.parse(await call(plan.resources.step_report, { id: String(id) }));
      return resource(uri, sessions.map(({ id: session, role, status, error, report }) => ({ session, role, status, error, report })));
    },
  );

  return server;
}

/** La ruta y el input de procedimiento de una llamada a `list` o `get` (o a una acción). */
function toolCall(tool: McpTool, args: Record<string, unknown>): [McpRoute, unknown] {
  const action = tool.routes.get("");
  if (action) return [action, args];
  const { kind, filter, ...rest } = args;
  const route = tool.routes.get(String(kind))!;
  // `list` agrupa los campos del filtro bajo `filter`; el procedimiento los recibe sueltos.
  return [route, withKind(route, String(kind), tool.name === "list" ? filter : rest)];
}

/** Un procedimiento que sirve a varios kinds los recibe en su input. */
const withKind = (route: McpRoute, kind: string, input: unknown) => (route.shared ? { ...fields(input), kind } : input);

const fields = (value: unknown): Record<string, unknown> => (typeof value === "object" && value !== null ? { ...value } : {});

function routeOf(plan: McpPlan, tool: "list" | "get", kind: McpKind): McpRoute {
  const route = plan.tools.find((t) => t.name === tool)?.routes.get(kind);
  if (!route) throw new Error(`El MCP necesita un procedimiento con meta.mcp { tool: "${tool}", kind: "${kind}" } para servir sus resources.`);
  return route;
}

async function timeline(call: Call, route: McpRoute, runId: string): Promise<Event[]> {
  const events: Event[] = [];
  for (;;) {
    const page = z.array(Event).parse(await call(route, { after: events.at(-1)?.seq ?? 0, limit: TIMELINE_PAGE, filter: { runId } }));
    events.push(...page);
    if (page.length < TIMELINE_PAGE) return events;
  }
}

const json = (value: unknown): CallToolResult => ({ content: [{ type: "text", text: JSON.stringify(value ?? null) }] });

const resource = (uri: URL, value: unknown): ReadResourceResult => ({
  contents: [{ uri: uri.href, mimeType: "application/json", text: JSON.stringify(value) }],
});

type Procedure = (input: unknown) => Promise<unknown>;

/** El procedimiento de `path` en el cliente en proceso. La ruta sale del contrato, así que existe. */
function procedureAt(client: object, path: readonly string[]): Procedure {
  let node: unknown = client;
  for (const key of path) node = Reflect.get(Object(node), key);
  if (typeof node !== "function") throw new Error(`No hay un procedimiento en ${path.join(".")}.`);
  return node as Procedure;
}

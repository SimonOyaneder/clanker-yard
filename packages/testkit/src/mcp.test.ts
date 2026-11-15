import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createClient, type Client, type Event } from "@clanker/api";
import { createConnections, createFileSecrets, createRepos, openStore, startCore, type Core, type Store } from "@clanker/core";
import { Client as McpClient, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { createFakeRuntime } from "./fake-runtime";
import { tempGitRepo, type TempGitRepo } from "./git";
import { seedDb, type TestHome } from "./home";

// El MCP de lectura contra un core real (Flows, Agents con el runtime fake y la API) sobre un
// CLANKER_HOME temporal, hablado con el cliente MCP del SDK por Streamable HTTP, como lo haría Claude Code.

const juguete = fileURLToPath(new URL("../fixtures/runs/juguete", import.meta.url));

let home: TestHome;
let store: Store;
let repo: TempGitRepo;
let core: Core;
let api: Client;
let mcp: McpClient;

beforeEach(async () => {
  home = seedDb("empty");
  store = openStore({ path: home.dbPath });
  repo = tempGitRepo({});
  core = await startCore({
    store,
    dataDir: home.path,
    connections: createConnections(store, createFileSecrets({ dir: join(home.path, "secrets") })),
    runtimes: [createFakeRuntime({ fixtures: juguete, speed: Infinity })],
    env: { CORE_RUNTIME: "fake" },
    coreVersion: "0.0.0",
    onShutdown: () => {},
  });
  api = createClient({ url: core.server.url, token: core.server.token, origin: "cli" });
  mcp = new McpClient({ name: "test", version: "0.0.0" });
  await mcp.connect(new StreamableHTTPClientTransport(new URL(mcpUrl()), { requestInit: { headers: { authorization: `Bearer ${core.server.token}` } } }));
});

afterEach(async () => {
  await mcp.close();
  await core.close();
  store.close();
  repo.cleanup();
  home.cleanup();
});

const mcpUrl = () => `http://127.0.0.1:${core.server.port}/mcp`;

/** El JSON que devuelve una tool; falla si la tool respondió con error. */
async function call(name: string, args: Record<string, unknown>): Promise<unknown> {
  const result = await mcp.callTool({ name, arguments: args });
  const [content] = result.content as { type: string; text: string }[];
  if (result.isError) throw new Error(content!.text);
  return JSON.parse(content!.text);
}

async function read(uri: string): Promise<unknown> {
  const { contents } = await mcp.readResource({ uri });
  return JSON.parse((contents[0] as { text: string }).text);
}

/** Un proyecto local con la plantilla `juguete` y una corrida terminada. */
async function finishedRun() {
  const repoId = createRepos(store).add({ name: "demo", path: repo.dir });
  const project = await api.projects.create({ slug: "demo", name: "Demo", tracker: "local", defaultFlowId: "juguete", defaultProfileId: "juguete", flowParams: { repo: repoId } });
  const issue = await api.issues.createLocal({ projectId: project.id, title: "Saluda" });
  const { id } = await api.runs.start({ projectId: project.id, issueId: issue.id });
  await vi.waitFor(async () => expect((await api.runs.get({ id })).status).toBe("done"));
  return { project, runId: id };
}

describe("tools", () => {
  test("lista solo list y get, de solo lectura", async () => {
    const { tools } = await mcp.listTools();

    expect(tools.map(({ name, description, inputSchema, annotations }) => ({ name, description, inputSchema, annotations }))).toMatchSnapshot();
    expect(tools.map((t) => t.annotations?.readOnlyHint)).toEqual([true, true]);
  });

  test("list y get de los kinds de defs: los builtin del core", async () => {
    const flows = (await call("list", { kind: "flow" })) as { id: string; slug: string; scope: string; body: { id: string } }[];

    const juguete = flows.find((f) => f.slug === "juguete");

    expect(flows.map((f) => f.slug)).toEqual(expect.arrayContaining(["juguete", "techlead-clasico", "pr-feedback"]));
    expect(juguete).toMatchObject({ scope: "builtin", body: { id: "juguete" } });
    expect(await call("get", { kind: "flow", id: juguete!.id })).toEqual(juguete);
    expect(await call("get", { kind: "flow", id: juguete!.id, version: 1 })).toMatchObject({ version: 1 });
    expect(await call("list", { kind: "role" })).toEqual(expect.arrayContaining([expect.objectContaining({ slug: "juguete" })]));
    expect(await call("list", { kind: "profile" })).toEqual(expect.arrayContaining([expect.objectContaining({ slug: "juguete" })]));
    expect(await call("list", { kind: "recipe" })).toEqual([]);
  });

  test("list y get de project, run y decision, con filtros", async () => {
    const { project, runId } = await finishedRun();

    expect(await call("list", { kind: "project" })).toMatchObject([{ id: project.id, slug: "demo" }]);
    expect(await call("get", { kind: "project", id: project.id })).toMatchObject({ slug: "demo" });
    expect(await call("list", { kind: "run", filter: { status: ["done"] } })).toMatchObject([{ id: runId }]);
    expect(await call("list", { kind: "run", filter: { status: ["failed"] } })).toEqual([]);
    expect(await call("get", { kind: "run", id: runId })).toMatchObject({ id: runId, status: "done", steps: expect.any(Array) });
    expect(await call("list", { kind: "decision", filter: { status: ["pending"] } })).toEqual([]);
  });

  test("un id que no existe o un filtro inválido llegan como error de la tool, con el mensaje del core", async () => {
    await expect(call("get", { kind: "run", id: "run_00000000000000000000000001" })).rejects.toThrow(/NOT_FOUND: .*run_00000000000000000000000001/);
    await expect(call("get", { kind: "flow", id: "def_nope" })).rejects.toThrow(/NOT_FOUND: No existe flow def_nope/);
    await expect(call("list", { kind: "run", filter: { status: ["nope"] } })).rejects.toThrow(/BAD_REQUEST/);
  });
});

describe("resources", () => {
  test("clanker://schema/<kind> de cada kind, como JSON Schema", async () => {
    const { resources } = await mcp.listResources();
    const schemas = resources.filter((r) => r.uri.startsWith("clanker://schema/")).map((r) => r.uri);

    expect(schemas.sort()).toEqual(["decision", "flow", "pack", "profile", "project", "recipe", "role", "run"].map((k) => `clanker://schema/${k}`));
    expect(await read("clanker://schema/flow")).toMatchObject({ type: "object", properties: { nodes: expect.any(Object), start: expect.any(Object) } });
    expect(await read("clanker://schema/decision")).toMatchObject({ type: "object", properties: { status: expect.any(Object) } });
  });

  test("la definición de un flujo se lista y se lee", async () => {
    const { resources } = await mcp.listResources();
    const flow = resources.find((r) => r.uri.startsWith("clanker://flow/") && r.name === "juguete");

    expect(flow).toMatchObject({ name: "juguete" });
    expect(await read(flow!.uri)).toMatchObject({ slug: "juguete", kind: "flow", body: { id: "juguete", start: "acquire" } });
  });

  test("la línea de tiempo de una corrida son sus eventos en orden", async () => {
    const { runId } = await finishedRun();

    const events = (await read(`clanker://run/${runId}/timeline`)) as Event[];

    expect(events.every((e) => e.runId === runId)).toBe(true);
    expect(events.map((e) => e.seq)).toEqual(events.map((e) => e.seq).sort((a, b) => a - b));
    expect(events.map((e) => e.type)).toEqual(expect.arrayContaining(["run.started", "step.started", "run.finished"]));
    expect(events).toEqual(store.events.since(0, { runId }, 1000));
  });

  test("el reporte de un paso es el de cada sesión de agente", async () => {
    const { runId } = await finishedRun();
    const step = (await api.runs.get({ id: runId })).steps.find((s) => s.nodeId === "saludar")!;

    const sessions = (await read(`clanker://step/${step.id}/report`)) as { role: string; status: string; report: { outcome: string } | null }[];

    expect(sessions).toMatchObject([{ role: "juguete", status: "success", report: { outcome: expect.any(String) } }]);
  });

  test("un paso que no existe es un error del resource", async () => {
    await expect(mcp.readResource({ uri: "clanker://step/stp_00000000000000000000000001/report" })).rejects.toThrow(/stp_00000000000000000000000001/);
  });
});

describe("acceso", () => {
  const init = { jsonrpc: "2.0", id: 1, method: "tools/list" };
  const post = (headers: Record<string, string>) =>
    fetch(mcpUrl(), { method: "POST", headers: { "content-type": "application/json", accept: "application/json, text/event-stream", ...headers }, body: JSON.stringify(init) });

  test("sin token es 401, con un Origin ajeno es 403 y con token entra sin x-clanker-origin", async () => {
    expect((await post({})).status).toBe(401);
    expect((await post({ authorization: "Bearer otro" })).status).toBe(401);
    expect((await post({ authorization: `Bearer ${core.server.token}`, origin: "https://evil.example" })).status).toBe(403);
    expect((await post({ authorization: `Bearer ${core.server.token}` })).status).toBe(200);
  });
});

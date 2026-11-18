import { fileURLToPath } from "node:url";
import { type Event, LocalPrDetail } from "@clanker/api";
import { createRepos } from "@clanker/core";
import { seedPr } from "@clanker/core/testing";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { startMcpHarness, type McpHarness } from "./mcp-harness";

// El MCP de lectura contra un core real (Flows, Agents con el runtime fake y la API) sobre un
// CLANKER_HOME temporal, hablado con el cliente MCP del SDK por Streamable HTTP, como lo haría Claude Code.

const juguete = fileURLToPath(new URL("../fixtures/runs/juguete", import.meta.url));

let h: McpHarness;

beforeEach(async () => {
  h = await startMcpHarness({ fixtures: juguete, speed: Infinity });
});

afterEach(() => h.close());

/** Un proyecto local con la plantilla `juguete` y una corrida terminada. */
async function finishedRun() {
  const repoId = createRepos({ store: h.store }).add({ name: "demo", path: h.repo.dir });
  const project = await h.api.projects.create({ slug: "demo", name: "Demo", tracker: "local", defaultFlowId: "juguete", defaultProfileId: "juguete", flowParams: { repo: repoId } });
  const issue = await h.api.issues.createLocal({ projectId: project.id, title: "Saluda" });
  const { id } = await h.api.runs.start({ projectId: project.id, issueId: issue.id });
  await vi.waitFor(async () => expect((await h.api.runs.get({ id })).status).toBe("done"), { timeout: 10_000 });
  return { project, runId: id };
}

describe("tools", () => {
  test("lista las tools de lectura, las de escritura y las acciones, con sus anotaciones", async () => {
    const { tools } = await h.mcp.listTools();

    expect(tools.map(({ name, description, inputSchema, annotations }) => ({ name, description, inputSchema, annotations }))).toMatchSnapshot();
    expect(tools.filter((t) => t.annotations?.readOnlyHint).map((t) => t.name))
      .toEqual(expect.arrayContaining(["list", "get", "project_queue", "list_prs", "get_local_pr", "get_local_pr_commit_diff"]));
    expect(tools.filter((t) => t.annotations?.destructiveHint).map((t) => t.name))
      .toEqual(expect.arrayContaining(["delete", "update_local_pr", "cancel_run", "interrupt_run", "resolve_decision"]));
  });

  test("list y get de los kinds de defs: los builtin del core", async () => {
    const flows = (await h.call("list", { kind: "flow" })) as { id: string; slug: string; scope: string; body: { id: string } }[];

    const juguete = flows.find((f) => f.slug === "juguete");

    expect(flows.map((f) => f.slug)).toEqual(expect.arrayContaining(["juguete", "techlead-clasico", "pr-feedback"]));
    expect(juguete).toMatchObject({ scope: "builtin", body: { id: "juguete" } });
    expect(await h.call("get", { kind: "flow", id: juguete!.id })).toEqual(juguete);
    expect(await h.call("get", { kind: "flow", id: juguete!.id, version: 1 })).toMatchObject({ version: 1 });
    expect(await h.call("list", { kind: "role" })).toEqual(expect.arrayContaining([expect.objectContaining({ slug: "juguete" })]));
    expect(await h.call("list", { kind: "profile" })).toEqual(expect.arrayContaining([expect.objectContaining({ slug: "juguete" })]));
    expect(await h.call("list", { kind: "recipe" })).toEqual([]);
  });

  test("list y get de project, run y decision, con filtros", async () => {
    const { project, runId } = await finishedRun();

    expect(await h.call("list", { kind: "project" })).toMatchObject([{ id: project.id, slug: "demo" }]);
    expect(await h.call("get", { kind: "project", id: project.id })).toMatchObject({ slug: "demo" });
    expect(await h.call("list", { kind: "run", filter: { status: ["done"] } })).toMatchObject([{ id: runId }]);
    expect(await h.call("list", { kind: "run", filter: { status: ["failed"] } })).toEqual([]);
    expect(await h.call("get", { kind: "run", id: runId })).toMatchObject({ id: runId, status: "done", steps: expect.any(Array) });
    expect(await h.call("list", { kind: "decision", filter: { status: ["pending"] } })).toEqual([]);
  });

  test("un id que no existe o un filtro inválido llegan como error de la tool, con el mensaje del core", async () => {
    await expect(h.call("get", { kind: "run", id: "run_00000000000000000000000001" })).rejects.toThrow(/NOT_FOUND: .*run_00000000000000000000000001/);
    await expect(h.call("get", { kind: "flow", id: "def_nope" })).rejects.toThrow(/NOT_FOUND: No existe flow def_nope/);
    await expect(h.call("list", { kind: "run", filter: { status: ["nope"] } })).rejects.toThrow(/BAD_REQUEST/);
  });

  test("lee y edita los PRs locales aun sin cuenta de GitHub", async () => {
    const repoId = createRepos({ store: h.store }).add({ name: "demo", path: h.repo.dir, remote: "octocat/demo" });
    h.repo.git("switch", "-c", "local");
    h.repo.git("commit", "--allow-empty", "-m", "feat: local");
    h.repo.git("switch", "main");
    const head = h.repo.git("rev-parse", "local");
    const id = seedPr(h.store, { repoId, number: null, state: "local", headRef: "local", headSha: head, title: "Local" });
    expect(await h.call("list_prs", { state: "local" })).toMatchObject([{ id, repo: "octocat/demo", local: { title: "Local" }, ref: null }]);
    expect(await h.call("update_local_pr", { id, title: "Revisado", body: "Descripción" })).toEqual({ id, title: "Revisado", body: "Descripción" });
    expect(h.store.events.since(0, { types: ["pr.changed"] })).toMatchObject([{ origin: "mcp", subject: { id } }]);
    const detail = LocalPrDetail.parse(await h.call("get_local_pr", { id }));
    expect(detail).toMatchObject({ title: "Revisado", body: "Descripción", head, commits: [{ sha: head, subject: "feat: local" }] });
    expect(await h.call("get_local_pr_commit_diff", { id, sha: head.slice(0, 8) })).toMatchObject({ sha: head });
    const remote = seedPr(h.store, { repoId, number: 1 });
    await expect(h.call("get_local_pr", { id: remote })).rejects.toThrow(/ya no es local/);
    await expect(h.call("update_local_pr", { id: remote, body: "" })).rejects.toThrow(/no es un PR local/);
  });
});

describe("resources", () => {
  test("clanker://schema/<kind> de cada kind, como JSON Schema", async () => {
    const { resources } = await h.mcp.listResources();
    const schemas = resources.filter((r) => r.uri.startsWith("clanker://schema/")).map((r) => r.uri);

    expect(schemas.sort()).toEqual(["decision", "flow", "learning", "pack", "profile", "project", "recipe", "role", "run"].map((k) => `clanker://schema/${k}`));
    expect(await h.read("clanker://schema/flow")).toMatchObject({ type: "object", properties: { nodes: expect.any(Object), start: expect.any(Object) } });
    expect(await h.read("clanker://schema/decision")).toMatchObject({ type: "object", properties: { status: expect.any(Object) } });
  });

  test("la definición de un flujo se lista y se lee", async () => {
    const { resources } = await h.mcp.listResources();
    const flow = resources.find((r) => r.uri.startsWith("clanker://flow/") && r.name === "juguete");

    expect(flow).toMatchObject({ name: "juguete" });
    expect(await h.read(flow!.uri)).toMatchObject({ slug: "juguete", kind: "flow", body: { id: "juguete", start: "acquire" } });
  });

  test("la línea de tiempo de una corrida son sus eventos en orden", async () => {
    const { runId } = await finishedRun();

    const events = (await h.read(`clanker://run/${runId}/timeline`)) as Event[];

    expect(events.every((e) => e.runId === runId)).toBe(true);
    expect(events.map((e) => e.seq)).toEqual(events.map((e) => e.seq).sort((a, b) => a - b));
    expect(events.map((e) => e.type)).toEqual(expect.arrayContaining(["run.started", "step.started", "run.finished"]));
    expect(events).toEqual(h.store.events.since(0, { runId }, 1000));
  });

  test("el reporte de un paso es el de cada sesión de agente", async () => {
    const { runId } = await finishedRun();
    const step = (await h.api.runs.get({ id: runId })).steps.find((s) => s.nodeId === "saludar")!;

    const sessions = (await h.read(`clanker://step/${step.id}/report`)) as { role: string; status: string; report: { outcome: string } | null }[];

    expect(sessions).toMatchObject([{ role: "juguete", status: "success", report: { outcome: expect.any(String) } }]);
  });

  test("un paso que no existe es un error del resource", async () => {
    await expect(h.mcp.readResource({ uri: "clanker://step/stp_00000000000000000000000001/report" })).rejects.toThrow(/stp_00000000000000000000000001/);
  });
});

describe("acceso", () => {
  const init = { jsonrpc: "2.0", id: 1, method: "tools/list" };
  const post = (headers: Record<string, string>) =>
    fetch(h.mcpUrl, { method: "POST", headers: { "content-type": "application/json", accept: "application/json, text/event-stream", ...headers }, body: JSON.stringify(init) });

  test("sin token es 401, con un Origin ajeno es 403 y con token entra sin x-clanker-origin", async () => {
    expect((await post({})).status).toBe(401);
    expect((await post({ authorization: "Bearer otro" })).status).toBe(401);
    expect((await post({ authorization: `Bearer ${h.core.server.token}`, origin: "https://evil.example" })).status).toBe(403);
    expect((await post({ authorization: `Bearer ${h.core.server.token}` })).status).toBe(200);
  });
});

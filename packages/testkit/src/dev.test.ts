import { fileURLToPath } from "node:url";
import { createRepos } from "@clanker/core";
import { afterEach, describe, expect, test } from "vitest";
import { startMcpHarness, type McpHarness } from "./mcp-harness";
import { SUMMARY_PROJECT_SLUG } from "./summary-scenario";

// El router `dev` y sus tools MCP solo existen en un core lanzado como el de desarrollo (`startCore({ dev })`).

const juguete = fileURLToPath(new URL("../fixtures/runs/juguete", import.meta.url));
const DEV_TOOLS = ["inject_step_result", "load_fixture", "advance_clock"];
const DEV_ROUTES = ["injectStepResult", "loadFixture", "advanceClock"];

let h: McpHarness;

afterEach(() => h.close());

/** Lo que `/rpc/dev/<procedimiento>` responde con el token del core: el status y, si hubo, el JSON. */
async function callRpc(procedure: string, json: unknown): Promise<{ status: number; body?: unknown }> {
  const res = await fetch(`${h.core.server.url}/dev/${procedure}`, {
    method: "POST",
    headers: { authorization: `Bearer ${h.core.server.token}`, "x-clanker-origin": "cli", "content-type": "application/json" },
    body: JSON.stringify({ json }),
  });
  return { status: res.status, body: res.status === 200 ? await res.json() : undefined };
}

describe("un core normal", () => {
  test("no expone el router dev ni por la API ni por MCP", async () => {
    h = await startMcpHarness({ fixtures: juguete, speed: Infinity });

    const { tools } = await h.mcp.listTools();
    const rpc = await Promise.all(DEV_ROUTES.map((procedure) => callRpc(procedure, { name: "summary", ms: 1, stepId: "stp_00000000000000000000000001", outcome: "ok" })));

    expect(tools.filter((t) => DEV_TOOLS.includes(t.name))).toEqual([]);
    expect(rpc.map((r) => r.status)).toEqual([404, 404, 404]);
    await expect(h.call("advance_clock", { ms: 1 })).rejects.toThrow(/advance_clock/);
  });
});

describe("un core de desarrollo", () => {
  test("sirve el router dev por la API y suma sus tools al MCP, con la anotación de no destructivas", async () => {
    h = await startMcpHarness({ fixtures: juguete, speed: Infinity, dev: true });

    const { tools } = await h.mcp.listTools();
    const dev = tools.filter((t) => DEV_TOOLS.includes(t.name));

    expect(dev.map((t) => t.name).sort()).toEqual([...DEV_TOOLS].sort());
    expect(dev.map((t) => t.annotations?.destructiveHint)).toEqual([false, false, false]);
    expect((await callRpc("advanceClock", { ms: 1 })).status).toBe(200);
  });

  test("loadFixture siembra el escenario y cambia lo que devuelve projects.list", async () => {
    h = await startMcpHarness({ fixtures: juguete, speed: Infinity, dev: true });
    expect((await h.api.projects.list()).map((p) => p.slug)).not.toContain(SUMMARY_PROJECT_SLUG);

    expect(await h.call("load_fixture", { name: "summary" })).toEqual({ name: "summary" });

    expect((await h.api.projects.list()).map((p) => p.slug)).toContain(SUMMARY_PROJECT_SLUG);
  });

  test("loadFixture con un nombre que no existe lista los que hay", async () => {
    h = await startMcpHarness({ fixtures: juguete, speed: Infinity, dev: true });

    await expect(h.call("load_fixture", { name: "nope" })).rejects.toThrow(/No existe el fixture "nope": hay summary, .*loop-running.*issue-blocked/);
  });

  test("advanceClock adelanta el reloj falso y devuelve la hora nueva", async () => {
    h = await startMcpHarness({ fixtures: juguete, speed: Infinity, dev: true });
    const before = h.clock!();

    expect(await h.call("advance_clock", { ms: 86_400_000 })).toEqual({ now: before + 86_400_000 });
    expect(await h.call("advance_clock", { ms: 1_000 })).toEqual({ now: before + 86_401_000 });
    expect(h.clock!()).toBe(before + 86_401_000);
  });

  test("injectStepResult rechaza el paso de un agente: ahí el resultado lo da el guion", async () => {
    // Con un speed casi nulo el agente se queda en su primer evento con tiempo y su paso sigue en marcha.
    h = await startMcpHarness({ fixtures: fileURLToPath(new URL("../fixtures/runs/juguete-lento", import.meta.url)), speed: 0.0001, dev: true });
    const repoId = createRepos(h.store).add({ name: "demo", path: h.repo.dir });
    const project = await h.api.projects.create({ slug: "demo", name: "Demo", tracker: "local", defaultFlowId: "juguete", defaultProfileId: "juguete", flowParams: { repo: repoId } });
    const issue = await h.api.issues.createLocal({ projectId: project.id, title: "Saluda" });
    const { id } = await h.api.runs.start({ projectId: project.id, issueId: issue.id });
    const agent = await waitForStep(h, id, "saludar");

    await expect(h.call("inject_step_result", { stepId: agent, outcome: "ok" })).rejects.toThrow(/nunca el de un agente/);
  });
});

async function waitForStep(harness: McpHarness, runId: string, nodeId: string): Promise<string> {
  for (let i = 0; i < 200; i++) {
    const run = await harness.api.runs.get({ id: runId as never });
    const step = run.steps.find((s) => s.nodeId === nodeId && s.status === "running");
    if (step) return step.id;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`El paso ${nodeId} no llegó a correr.`);
}

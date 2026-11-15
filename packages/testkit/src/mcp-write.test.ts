import { fileURLToPath } from "node:url";
import type { DefRecord, DefWrite, EventType, FlowDef, Run, RunDetail } from "@clanker/api";
import { createRepos } from "@clanker/core";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { startMcpHarness, type McpHarness } from "./mcp-harness";

// Las tools de escritura y las acciones del MCP contra un core real, hablado con el cliente MCP del SDK.
// El runtime fake va con un `speed` mínimo sobre el guion con tiempos reales: el agente de `juguete` queda
// colgado en su segundo evento, así una corrida se queda `running` hasta que el test la pausa o la cancela.

const lento = fileURLToPath(new URL("../fixtures/runs/juguete-lento", import.meta.url));

let h: McpHarness;

beforeEach(async () => {
  h = await startMcpHarness({ fixtures: lento, speed: 0.0001 });
});

afterEach(() => h.close());

/** Un flujo sin agentes: una decisión que estaciona la corrida hasta que alguien la resuelve. */
const aprobar = (name = "Aprobar"): FlowDef => ({
  schema: 1,
  id: "aprobar",
  name,
  trigger: { type: "manual" },
  effects: "local",
  start: "preguntar",
  nodes: {
    preguntar: {
      type: "gate",
      question: "¿Sigo?",
      options: [
        { id: "ok", label: "Sí" },
        { id: "no", label: "No" },
      ],
      on: { ok: "@done", no: "@blocked" },
    },
  },
});

const defEvents = (...types: EventType[]) => h.store.events.since(0, { types }).map((e) => [e.type, e.origin]);

const flowDef = async (slug: string) => ((await h.call("list", { kind: "flow", filter: { includeArchived: true } })) as DefRecord[]).find((d) => d.slug === slug);

/** Un proyecto local que lanza `flow` (por defecto el builtin `juguete`, que toma un worktree del repo temporal) y una issue suya. */
async function projectWithIssue(flow = "juguete") {
  const repoId = createRepos(h.store).add({ name: "demo", path: h.repo.dir });
  const flowParams = flow === "juguete" ? { repo: repoId } : {};
  const project = await h.api.projects.create({ slug: "demo", name: "Demo", tracker: "local", defaultFlowId: flow, defaultProfileId: "juguete", flowParams });
  const issue = await h.api.issues.createLocal({ projectId: project.id, title: "Saluda" });
  return { project, issue };
}

async function runIssue(flow?: string) {
  const { project, issue } = await projectWithIssue(flow);
  const run = (await h.call("run_issue", { projectId: project.id, issueId: issue.id })) as RunDetail;
  return { project, issue, run };
}

const statusOf = async (id: string) => ((await h.call("get", { kind: "run", id })) as RunDetail).status;

describe("create, update y delete", () => {
  test("create guarda un flujo, un rol y un perfil de scope user, con origin mcp en los eventos", async () => {
    const juguete = ((await h.call("list", { kind: "role" })) as DefRecord[]).find((d) => d.slug === "juguete")!;

    const flow = (await h.call("create", { kind: "flow", body: aprobar() })) as DefWrite;
    const role = (await h.call("create", { kind: "role", slug: "saludador", body: juguete.body })) as DefWrite;
    const profile = (await h.call("create", { kind: "profile", slug: "barato", body: { roles: { saludador: { model: "haiku" } } } })) as DefWrite;

    expect([flow, role, profile].map((w) => [w.dryRun, w.changed, w.def?.kind, w.def?.slug, w.def?.scope, w.def?.version])).toEqual([
      [false, true, "flow", "aprobar", "user", 1],
      [false, true, "role", "saludador", "user", 1],
      [false, true, "profile", "barato", "user", 1],
    ]);
    expect(await h.call("get", { kind: "flow", id: flow.def!.id })).toEqual(flow.def);
    expect(defEvents("def.versioned").slice(-3)).toEqual([["def.versioned", "mcp"], ["def.versioned", "mcp"], ["def.versioned", "mcp"]]);
  });

  test("create con dryRun devuelve los errores del flujo (los de su esquema y los de sus reglas) y no guarda nada", async () => {
    const roto = aprobar();
    roto.nodes.preguntar = { ...roto.nodes.preguntar!, on: { ok: "no-existe", no: "@blocked" } } as never;
    const events = h.store.events.since(0, {}).length;

    const dry = (await h.call("create", { kind: "flow", body: roto, dryRun: true })) as DefWrite;
    const schema = (await h.call("create", { kind: "role", slug: "x", body: { prompt: "" }, dryRun: true })) as DefWrite;

    expect(dry).toMatchObject({ dryRun: true, def: null, changed: false, errors: [{ path: expect.stringContaining("preguntar"), message: expect.stringContaining("no-existe") }] });
    expect(schema.errors.map((e) => e.path)).toEqual(expect.arrayContaining(["prompt", "modes"]));
    expect(await flowDef("aprobar")).toBeUndefined();
    expect(h.store.events.since(0, {}).length).toBe(events);
  });

  test("create sin dryRun con un body inválido falla con todos los errores en el mensaje", async () => {
    await expect(h.call("create", { kind: "role", slug: "x", body: { prompt: "" } })).rejects.toThrow(/BAD_REQUEST: No se guardó role "x":\n {2}prompt: .*\n {2}context: .*\n {2}modes: /);
  });

  test("create rechaza lo que ya existe, el slug que no es el id del flujo y el scope repo sin repoId", async () => {
    await h.call("create", { kind: "flow", body: aprobar() });

    await expect(h.call("create", { kind: "flow", body: aprobar() })).rejects.toThrow(/ya existe flow "aprobar" \(user\): usa update con su id def_/);
    await expect(h.call("create", { kind: "flow", slug: "otro", body: { ...aprobar(), id: "uno" } })).rejects.toThrow(/el id del flujo es "uno" y debe ser su slug "otro"/);
    await expect(h.call("create", { kind: "profile", body: { roles: {} } })).rejects.toThrow(/slug: un profile necesita slug/);
    await expect(h.call("create", { kind: "profile", slug: "p", scope: "repo", body: { roles: {} } })).rejects.toThrow(/repoId: es obligatorio con scope "repo"/);
  });

  test("update con dryRun muestra el diff y no crea versión ni eventos; sin dryRun la crea, y el mismo body no suma otra", async () => {
    const { def } = (await h.call("create", { kind: "flow", body: aprobar() })) as DefWrite;
    const events = h.store.events.since(0, {}).length;

    const dry = (await h.call("update", { kind: "flow", id: def!.id, body: aprobar("Aprobar v2"), dryRun: true })) as DefWrite;

    expect(dry).toMatchObject({ dryRun: true, changed: true, def: null, errors: [], diff: [{ path: "name", before: "Aprobar", after: "Aprobar v2" }] });
    expect(await h.call("get", { kind: "flow", id: def!.id })).toMatchObject({ currentVersion: 1, body: { name: "Aprobar" } });
    expect(await h.api.defs.get({ kind: "flow", id: def!.id, version: 2 }).catch((e: Error) => e.message)).toMatch(/No existe flow .* en la versión 2/);
    expect(h.store.events.since(0, {}).length).toBe(events);

    const saved = (await h.call("update", { kind: "flow", id: def!.id, body: aprobar("Aprobar v2") })) as DefWrite;
    const same = (await h.call("update", { kind: "flow", id: def!.id, body: aprobar("Aprobar v2") })) as DefWrite;

    expect(saved).toMatchObject({ dryRun: false, changed: true, def: { version: 2, currentVersion: 2 }, diff: [{ path: "name" }] });
    expect(same).toMatchObject({ changed: false, diff: [], def: { currentVersion: 2 } });
    expect(defEvents("def.versioned").slice(-1)).toEqual([["def.versioned", "mcp"]]);
  });

  test("update con dryRun y un body inválido devuelve los errores; un cambio se deshace volviendo a escribir la versión anterior", async () => {
    const { def } = (await h.call("create", { kind: "profile", slug: "alto", body: { roles: { dev: { model: "opus" } } } })) as DefWrite;

    const dry = (await h.call("update", { kind: "profile", id: def!.id, body: { roles: { dev: {} } }, dryRun: true })) as DefWrite;
    await h.call("update", { kind: "profile", id: def!.id, body: { roles: { dev: { model: "fable" } } } });
    const before = (await h.call("get", { kind: "profile", id: def!.id, version: 1 })) as DefRecord;
    await h.call("update", { kind: "profile", id: def!.id, body: before.body });

    expect(dry.errors).toMatchObject([{ path: "roles.dev.model" }]);
    expect(await h.call("get", { kind: "profile", id: def!.id })).toMatchObject({ currentVersion: 3, version: 3, body: { roles: { dev: { model: "opus" } } } });
  });

  test("las defs builtin no se editan ni se archivan: se pisan con una de scope user", async () => {
    const juguete = (await flowDef("juguete"))!;

    await expect(h.call("update", { kind: "flow", id: juguete.id, body: juguete.body })).rejects.toThrow(/flow "juguete" es de scope builtin: el core la regenera/);
    await expect(h.call("delete", { kind: "flow", id: juguete.id })).rejects.toThrow(/es de scope builtin/);
    expect(await h.call("update", { kind: "flow", id: juguete.id, body: { ...(juguete.body as object), name: "Otro" }, dryRun: true })).toMatchObject({ errors: [{ message: expect.stringContaining("scope user y el mismo slug") }] });

    const own = (await h.call("create", { kind: "flow", body: { ...(juguete.body as object), name: "Mi juguete" } })) as DefWrite;
    expect(own.def).toMatchObject({ scope: "user", slug: "juguete" });
    expect(await h.api.defs.get({ kind: "flow", id: own.def!.id })).toMatchObject({ body: { name: "Mi juguete" } });
  });

  test("delete archiva con deshacer desde la API, y origin mcp en los eventos", async () => {
    const { def } = (await h.call("create", { kind: "flow", body: aprobar() })) as DefWrite;

    const archived = (await h.call("delete", { kind: "flow", id: def!.id })) as DefRecord;
    await h.call("delete", { kind: "flow", id: def!.id });

    expect(archived.archivedAt).toEqual(expect.any(Number));
    expect(await h.call("list", { kind: "flow" })).not.toContainEqual(expect.objectContaining({ slug: "aprobar" }));
    expect(await flowDef("aprobar")).toMatchObject({ id: def!.id });
    await expect(h.call("update", { kind: "flow", id: def!.id, body: aprobar("X") })).rejects.toThrow(/está archivada: restáurala/);
    await expect(h.call("create", { kind: "flow", body: aprobar() })).rejects.toThrow(/está archivada: restáurala \(defs.restore def_/);

    const restored = await h.api.defs.restore({ kind: "flow", id: def!.id });

    expect(restored.archivedAt).toBeNull();
    expect(await h.call("list", { kind: "flow" })).toContainEqual(expect.objectContaining({ slug: "aprobar" }));
    expect(defEvents("def.archived", "def.restored")).toEqual([["def.archived", "mcp"], ["def.restored", "cli"]]);
  });

  test("un kind que no se escribe por MCP o un id que no existe son errores de la tool", async () => {
    await expect(h.call("create", { kind: "recipe", slug: "r", body: {} })).rejects.toThrow(/kind/);
    await expect(h.call("update", { kind: "flow", id: "def_nope", body: aprobar() })).rejects.toThrow(/NOT_FOUND: No existe flow def_nope/);
    await expect(h.call("delete", { kind: "role", id: "def_nope" })).rejects.toThrow(/NOT_FOUND/);
  });
});

describe("las corridas y los flujos que cambian", () => {
  async function parkedRun() {
    await h.call("create", { kind: "flow", body: aprobar() });
    const { project, run } = await runIssue("aprobar");
    await vi.waitFor(async () => expect(await statusOf(run.id)).toBe("parked"));
    return { project, runId: run.id };
  }

  test("editar un flujo no cambia la versión de una corrida en curso", async () => {
    const { runId } = await parkedRun();
    const { id } = (await flowDef("aprobar"))!;

    await h.call("update", { kind: "flow", id, body: aprobar("Aprobar v2") });

    expect(await h.call("get", { kind: "flow", id })).toMatchObject({ currentVersion: 2 });
    expect(await h.call("get", { kind: "run", id: runId })).toMatchObject({ flow: { slug: "aprobar", version: 1 }, flowDef: { name: "Aprobar" } });
    const [decision] = (await h.call("list", { kind: "decision", filter: { runId, status: ["pending"] } })) as { id: string }[];
    await h.call("resolve_decision", { id: decision!.id, option: "ok" });
    await vi.waitFor(async () => expect(await h.call("get", { kind: "run", id: runId })).toMatchObject({ status: "done", flow: { version: 1 } }));
  });

  test("archivar un flujo no borra sus corridas ni su historial, y la corrida en curso termina", async () => {
    const { runId } = await parkedRun();
    const { id } = (await flowDef("aprobar"))!;
    const timeline = h.store.events.since(0, { runId });

    await h.call("delete", { kind: "flow", id });

    expect(((await h.call("list", { kind: "run" })) as Run[]).map((r) => r.id)).toEqual([runId]);
    expect(await h.call("get", { kind: "run", id: runId })).toMatchObject({ status: "parked", flow: { slug: "aprobar" }, steps: [expect.objectContaining({ nodeId: "preguntar" })] });
    expect(h.store.events.since(0, { runId }).slice(0, timeline.length)).toEqual(timeline);
    const [decision] = (await h.call("list", { kind: "decision", filter: { runId, status: ["pending"] } })) as { id: string }[];
    await h.call("resolve_decision", { id: decision!.id, option: "ok" });
    await vi.waitFor(async () => expect(await statusOf(runId)).toBe("done"));
    expect(await h.call("list", { kind: "run", filter: { status: ["done"] } })).toHaveLength(1);
  });
});

describe("acciones", () => {
  test("pause_loop y start_loop pausan y retoman el proyecto, con origin mcp", async () => {
    const { project } = await projectWithIssue();

    expect(await h.call("pause_loop", { id: project.id })).toMatchObject({ id: project.id, status: "paused" });
    expect(await h.call("pause_loop", { id: project.id })).toMatchObject({ status: "paused" });
    expect(await h.call("start_loop", { id: project.id })).toMatchObject({ status: "active" });

    expect(h.store.events.since(0, { types: ["project.paused", "project.resumed"] }).map((e) => [e.type, e.origin])).toEqual([
      ["project.paused", "mcp"],
      ["project.resumed", "mcp"],
    ]);
  });

  test("run_issue lanza el flujo y es idempotente; pause_run, resume_run e interrupt_run mueven la corrida; cancel_run la cierra", async () => {
    const { project, issue, run } = await runIssue();
    await vi.waitFor(async () => expect(await statusOf(run.id)).toBe("running"));

    expect(await h.call("run_issue", { projectId: project.id, issueId: issue.id })).toMatchObject({ id: run.id });
    expect(await h.call("pause_run", { id: run.id })).toMatchObject({ status: "paused" });
    expect(await h.call("resume_run", { id: run.id })).toMatchObject({ status: "running" });
    expect(await h.call("interrupt_run", { id: run.id })).toMatchObject({ status: "paused" });
    expect(await h.call("cancel_run", { id: run.id })).toMatchObject({ status: "canceled" });

    const changes = h.store.events.since(0, { runId: run.id, types: ["run.status", "run.finished"] });
    expect(changes.map((e) => e.origin)).toEqual(expect.arrayContaining(["mcp"]));
    expect(changes.filter((e) => e.type === "run.status" && e.payload.to === "paused" && e.origin === "mcp")).toHaveLength(2);
    expect(changes.at(-1)).toMatchObject({ type: "run.finished", origin: "mcp" });
  });

  test("retry_step vuelve a correr el paso como una visita nueva", async () => {
    const { run } = await runIssue();
    await vi.waitFor(async () => expect((await h.api.runs.get({ id: run.id })).steps.find((s) => s.nodeId === "saludar")?.status).toBe("running"));
    const step = (await h.api.runs.get({ id: run.id })).steps.find((s) => s.nodeId === "saludar")!;

    await h.call("retry_step", { stepId: step.id });

    await vi.waitFor(async () => expect(((await h.call("get", { kind: "run", id: run.id })) as RunDetail).steps.filter((s) => s.nodeId === "saludar").map((s) => s.visit)).toEqual([1, 2]));
    expect(h.store.events.since(0, { runId: run.id }).some((e) => e.origin === "mcp")).toBe(true);
  });

  test("resolve_decision cierra el gate una vez; una segunda es un error de la tool", async () => {
    await h.call("create", { kind: "flow", body: aprobar() });
    const { run } = await runIssue("aprobar");
    await vi.waitFor(async () => expect(await statusOf(run.id)).toBe("parked"));
    const [decision] = (await h.call("list", { kind: "decision", filter: { runId: run.id } })) as { id: string }[];

    expect(await h.call("resolve_decision", { id: decision!.id, option: "no" })).toMatchObject({ id: decision!.id, status: "answered" });
    await vi.waitFor(async () => expect(await h.call("get", { kind: "run", id: run.id })).toMatchObject({ status: "failed", outcome: "blocked" }));

    await expect(h.call("resolve_decision", { id: decision!.id, option: "ok" })).rejects.toThrow(/BAD_REQUEST/);
  });

  test("steer_step y pause_run explican por qué no se pueden aplicar", async () => {
    await h.call("create", { kind: "flow", body: aprobar() });
    const { run } = await runIssue("aprobar");
    await vi.waitFor(async () => expect(await statusOf(run.id)).toBe("parked"));
    const step = (await h.api.runs.get({ id: run.id })).steps[0]!;

    await expect(h.call("steer_step", { stepId: step.id, message: "hola" })).rejects.toThrow(/Solo un paso de agente recibe un mensaje/);
    await expect(h.call("pause_run", { id: run.id })).rejects.toThrow(/BAD_REQUEST: La corrida .* está estacionada/);
  });

  test("set_lanes cambia la capacidad de un carril y deja el otro", async () => {
    const before = await h.api.system.lanes();

    const lanes = await h.call("set_lanes", { dev: 7 });

    expect(lanes).toMatchObject({ dev: { capacity: 7 }, maintenance: { capacity: before.maintenance.capacity } });
    expect(await h.api.system.lanes()).toEqual(lanes);
  });
});

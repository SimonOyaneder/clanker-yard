import { MCP_KIND_SCHEMAS, type ContractMeta, type McpMeta } from "@clanker/api";
import { oc } from "@orpc/contract";
import * as z from "zod";
import { describe, expect, test } from "vitest";
import { generateMcp } from "./generate";

const base = oc.$meta<ContractMeta>({});
const marked = (mcp: McpMeta) => base.meta({ mcp });
const Id = z.object({ id: z.string() });

/** Un contrato mínimo con los dos resources que el generador exige. */
const resources = {
  events: { list: marked({ resource: "run_timeline" }).input(Id), step: marked({ resource: "step_report" }).input(Id) },
};

describe("generateMcp sobre el contrato real", () => {
  const plan = generateMcp();

  test("las tools por kind y las acciones, con las anotaciones de la regla", () => {
    const readOnly = { readOnlyHint: true, openWorldHint: false };
    const safe = { destructiveHint: false, openWorldHint: false };
    const safeIdempotent = { ...safe, idempotentHint: true };
    const destructive = { destructiveHint: true, idempotentHint: true, openWorldHint: false };
    expect(Object.fromEntries(plan.tools.map((t) => [t.name, t.annotations]))).toMatchObject({
      list: readOnly,
      get: readOnly,
      create: safe,
      update: safeIdempotent,
      delete: destructive,
      set_lanes: safeIdempotent,
      pause_loop: safeIdempotent,
      start_loop: safeIdempotent,
      run_issue: { destructiveHint: false, idempotentHint: true, openWorldHint: true },
      pause_run: safeIdempotent,
      resume_run: safeIdempotent,
      cancel_run: destructive,
      interrupt_run: destructive,
      retry_step: { ...safe, idempotentHint: false },
      steer_step: { ...safe, idempotentHint: false },
      resolve_decision: { destructiveHint: true, idempotentHint: false, openWorldHint: true },
      project_queue: readOnly,
      update_project: safeIdempotent,
      list_prs: readOnly,
      get_local_pr: readOnly,
      get_local_pr_commit_diff: readOnly,
      update_local_pr: destructive,
      propose_learning: safeIdempotent,
    });
  });

  test("create, update y delete toman el input de defs con los kinds que se escriben, y los rutean ahí", () => {
    const byName = Object.fromEntries(plan.tools.map((t) => [t.name, t]));
    for (const [name, procedure] of [["create", "create"], ["update", "update"], ["delete", "archive"]] as const) {
      expect([...byName[name]!.routes]).toEqual(
        ["flow", "role", "profile"].map((kind) => [kind, { path: ["defs", procedure], shared: true, hasInput: true }]),
      );
    }
    expect(Object.keys(byName.create!.inputSchema.shape)).toEqual(["kind", "slug", "scope", "repoId", "body", "dryRun"]);
    expect(byName.update!.inputSchema.safeParse({ kind: "flow", id: "def_1", body: {} }).data).toMatchObject({ dryRun: false });
    expect(byName.update!.inputSchema.safeParse({ kind: "recipe", id: "def_1", body: {} }).success).toBe(false);
    expect(Object.keys(byName.delete!.inputSchema.shape)).toEqual(["kind", "id"]);
  });

  test("cada acción es una tool con la descripción de su procedimiento y su input", () => {
    const run = plan.tools.find((t) => t.name === "run_issue")!;
    expect(run.description).toContain("Lanza el flujo");
    expect(run.routes.get("")).toEqual({ path: ["runs", "start"], shared: false, hasInput: true });
    expect(plan.tools.find((t) => t.name === "start_loop")!.routes.get("")!.path).toEqual(["projects", "resume"]);
  });

  test("no expone operaciones reservadas ni rutas de desarrollo en producción", () => {
    const paths = plan.tools.flatMap((tool) => [...tool.routes.values()].map((route) => route.path.join(".")));
    for (const reserved of [
      "connections.setPat", "connections.setClaudeApiKey", "connections.disconnect", "connections.startDeviceFlow",
      "connections.linearAuth", "connections.testClaude", "prs.merge", "prs.requestReview", "prs.rebase", "prs.publishLocal",
      "chats.apply", "defs.exportToRepo", "learnings.approve", "runs.forceOutcome",
    ]) expect(paths).not.toContain(reserved);
    expect(paths.some((path) => path.startsWith("dev."))).toBe(false);
  });

  test("cada kind que una tool sirve tiene esquema, y los procedimientos van a su ruta", () => {
    const [list, get] = plan.tools;
    expect([...list!.routes.keys()].sort()).toEqual(["decision", "flow", "learning", "pack", "profile", "project", "recipe", "role", "run"]);
    expect([...get!.routes.keys()].sort()).toEqual([...list!.routes.keys()].sort());
    expect([...plan.schemas.keys()].sort()).toEqual([...list!.routes.keys()].sort());
    expect(Object.keys(MCP_KIND_SCHEMAS).sort()).toEqual([...plan.schemas.keys()].sort());
    expect(list!.routes.get("run")).toEqual({ path: ["runs", "list"], shared: false, hasInput: true });
    expect(list!.routes.get("project")).toEqual({ path: ["projects", "list"], shared: false, hasInput: false });
    expect(get!.routes.get("flow")).toEqual({ path: ["defs", "get"], shared: true, hasInput: true });
    expect(plan.resources).toEqual({
      run_timeline: { path: ["events", "list"], shared: false, hasInput: true },
      step_report: { path: ["runs", "step"], shared: false, hasInput: true },
    });
  });

  test("la descripción de list documenta los filtros de cada kind", () => {
    const description = plan.tools[0]!.description;
    expect(description).toContain("- run: projectId?: string, status?: queued|running|waiting|parked|paused|done|failed|canceled[]");
    expect(description).toContain("- flow: includeArchived?: boolean");
    expect(description).not.toContain("- project");
  });
});

describe("generateMcp rechaza un contrato mal marcado", () => {
  test("una acción sin anotaciones", () => {
    const contract = { ...resources, runs: { retry: marked({ action: "retry_step", description: "x" }).input(Id) } };
    expect(() => generateMcp(contract)).toThrow('runs.retry: la acción "retry_step" no declara anotaciones');
  });

  test("una acción con anotaciones se arma con el input del procedimiento", () => {
    const contract = { ...resources, runs: { retry: marked({ action: "retry_step", description: "Reintenta.", annotations: { idempotentHint: true } }).input(Id) } };
    const tool = generateMcp(contract).tools.find((t) => t.name === "retry_step");
    expect(tool).toMatchObject({ description: "Reintenta.", annotations: { idempotentHint: true } });
    expect(tool!.inputSchema.safeParse({ id: "stp_1" }).success).toBe(true);
  });

  test("una acción sin input expone un objeto vacío estricto y puede servir también un resource", () => {
    const plan = generateMcp({
      ...resources,
      events: {
        ...resources.events,
        list: marked({ action: "events", resource: "run_timeline", description: "Eventos.", annotations: { readOnlyHint: true } }).output(z.array(z.string())),
      },
    });
    const [tool] = plan.tools;
    const route = { path: ["events", "list"], shared: false, hasInput: false };
    expect(tool!.inputSchema.safeParse({}).success).toBe(true);
    expect(tool!.inputSchema.safeParse({ invalid: true }).success).toBe(false);
    expect(tool!.routes.get("")).toEqual(route);
    expect(plan.resources.run_timeline).toEqual(route);
  });

  test("dos acciones no pueden usar el mismo nombre", () => {
    const action = marked({ action: "duplicate", description: "Duplicada.", annotations: {} }).input(Id);
    expect(() => generateMcp({ ...resources, a: { action }, b: { action } })).toThrow('tool llamada "duplicate"');
  });

  test("un kind sin esquema", () => {
    const contract = { ...resources, runs: { list: marked({ tool: "list", kind: "run" }).output(z.array(z.string())) } };
    expect(() => generateMcp(contract, { kindSchemas: {} })).toThrow('runs.list: el kind "run" no tiene esquema');
  });

  test("dos procedimientos para el mismo kind", () => {
    const contract = {
      ...resources,
      a: { list: marked({ tool: "get", kind: "run" }).input(Id) },
      b: { list: marked({ tool: "get", kind: "run" }).input(Id) },
    };
    expect(() => generateMcp(contract)).toThrow('b.list: la tool "get" ya tiene un procedimiento para el kind "run"');
  });

  test("una tool de escritura que sirven dos procedimientos", () => {
    const contract = {
      ...resources,
      a: { create: marked({ tool: "create", kind: "flow" }).input(Id.extend({ kind: z.string() })) },
      b: { create: marked({ tool: "create", kind: "role" }).input(Id.extend({ kind: z.string() })) },
    };
    expect(() => generateMcp(contract)).toThrow('b.create: la tool "create" ya la sirve a.create');
  });

  test("una tool de escritura sin input", () => {
    const contract = { ...resources, flows: { create: marked({ tool: "create", kind: "flow" }).output(z.string()) } };
    expect(() => generateMcp(contract)).toThrow('flows.create: la tool "create" necesita un input');
  });

  test("un input que no es un objeto", () => {
    const contract = { ...resources, runs: { retry: marked({ action: "x", description: "x", annotations: {} }).input(z.string()) } };
    expect(() => generateMcp(contract)).toThrow("runs.retry: el input de un procedimiento con meta.mcp debe ser un objeto zod");
  });

  test("un resource que ningún procedimiento declara", () => {
    expect(() => generateMcp({ events: { list: marked({ resource: "run_timeline" }).input(Id) } })).toThrow('meta.mcp.resource "step_report"');
  });
});

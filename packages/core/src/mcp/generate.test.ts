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

  test("arma list y get, ambas solo de lectura y cerradas al mundo", () => {
    expect(plan.tools.map((t) => [t.name, t.annotations])).toEqual([
      ["list", { readOnlyHint: true, openWorldHint: false }],
      ["get", { readOnlyHint: true, openWorldHint: false }],
    ]);
  });

  test("cada kind que una tool sirve tiene esquema, y los procedimientos van a su ruta", () => {
    const [list, get] = plan.tools;
    expect([...list!.routes.keys()].sort()).toEqual(["decision", "flow", "pack", "profile", "project", "recipe", "role", "run"]);
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
    const contract = { ...resources, runs: { retry: marked({ action: "retry_step" }).input(Id) } };
    expect(() => generateMcp(contract)).toThrow('runs.retry: la acción "retry_step" no declara anotaciones');
  });

  test("una acción con anotaciones se arma con el input del procedimiento", () => {
    const contract = { ...resources, runs: { retry: marked({ action: "retry_step", annotations: { idempotentHint: true } }).input(Id) } };
    const tool = generateMcp(contract).tools.find((t) => t.name === "retry_step");
    expect(tool).toMatchObject({ annotations: { idempotentHint: true } });
    expect(tool!.inputSchema.safeParse({ id: "stp_1" }).success).toBe(true);
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

  test("una tool de escritura, que es de otra issue", () => {
    const contract = { ...resources, flows: { create: marked({ tool: "create", kind: "flow" }).input(Id) } };
    expect(() => generateMcp(contract)).toThrow('flows.create: la tool "create" es de escritura');
  });

  test("un input que no es un objeto", () => {
    const contract = { ...resources, runs: { retry: marked({ action: "x", annotations: {} }).input(z.string()) } };
    expect(() => generateMcp(contract)).toThrow("runs.retry: el input de un procedimiento con meta.mcp debe ser un objeto zod");
  });

  test("un resource que ningún procedimiento declara", () => {
    expect(() => generateMcp({ events: { list: marked({ resource: "run_timeline" }).input(Id) } })).toThrow('meta.mcp.resource "step_report"');
  });
});

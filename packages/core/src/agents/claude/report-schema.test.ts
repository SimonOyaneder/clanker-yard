import { Role } from "@clanker/api";
import { afterEach, describe, expect, test } from "vitest";
import { createDefs, DefValidationError } from "../../defs/defs";
import { openStore, type Store } from "../../store/store";
import { roles } from "../../template/roles";
import { createAgents, outputSchemaFor } from "../agents";
import { createRuntimeRegistry, type AgentRuntime } from "../runtime";
import { claudeSchemaError } from "./report-schema";

// Claude Code compila `outputFormat.schema` al arrancar y, si no puede, sale con código 1 antes del primer turno
// (#155: el `$schema` 2020-12 de zod daba "no schema with key or ref"). `claudeSchemaError` lo imita, y guardar un
// rol (de la plantilla, de un pack, del repo o del usuario) lo exige.

const modes = Object.entries(roles).flatMap(([slug, role]) => Object.entries(role.modes).map(([mode, def]) => [`${slug}.${mode}`, def] as const));

describe("el reporte que recibe Claude Code", () => {
  test.each(modes)("%s compila como lo compila Claude Code", (_name, mode) => {
    expect(claudeSchemaError(outputSchemaFor(mode))).toBeUndefined();
    expect(claudeSchemaError(outputSchemaFor(mode, true))).toBeUndefined();
  });

  test("el validador es el de Claude Code: rechaza un keyword de 2020-12 como prefixItems", () => {
    expect(claudeSchemaError({ type: "object", properties: { pair: { type: "array", prefixItems: [{ type: "string" }] } } })).toMatch(/prefixItems/);
  });
});

describe("guardar un rol", () => {
  const stores: Store[] = [];
  afterEach(() => {
    for (const store of stores.splice(0)) store.close();
  });

  test("un modo cuyo reporte Claude Code no compila se rechaza con su ruta", () => {
    const store = openStore({ path: ":memory:" });
    stores.push(store);
    const defs = createDefs(store);
    createAgents({ store, defs, runtimes: createRuntimeRegistry([{ id: "claude-sdk" } as AgentRuntime], {}) });
    const role = Role.parse(roles.dev);
    const [name, mode] = Object.entries(role.modes)[0]!;
    const broken = { ...role, modes: { ...role.modes, [name]: { ...mode, report: { type: "object", properties: { pair: { type: "array", prefixItems: [{ type: "string" }] } } } } } };

    const issues = (() => {
      try {
        defs.validate("role", "dev", broken);
        return [];
      } catch (error) {
        if (!(error instanceof DefValidationError)) throw error;
        return error.issues;
      }
    })();
    expect(issues).toEqual([
      { path: ["modes", name, "report"], message: expect.stringMatching(/^Claude Code no puede compilar el reporte de este modo: .*prefixItems/) },
    ]);
    expect(defs.validate("role", "dev", role)).toBeDefined();
  });
});

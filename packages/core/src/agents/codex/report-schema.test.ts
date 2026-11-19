import { compileJsonSchema, type JsonSchema, type RoleMode } from "@clanker/api";
import { Ajv } from "ajv";
import { describe, expect, test } from "vitest";
import { roles } from "../../template/roles";
import { outputSchemaFor } from "../agents";
import { codexReportSchema, normalizeCodexReport } from "./report-schema";

const modes = Object.entries(roles).flatMap(([slug, role]) => Object.entries(role.modes).map(([name, mode]) => [`${slug}.${name}`, mode] as const));

type Optionals = "omitted" | "null" | "present";

function payloadFor(name: string, optionals: Optionals): JsonSchema {
  const optional = (key: string, value: unknown) => optionals === "omitted" ? {} : { [key]: optionals === "null" ? null : value };
  if (name.startsWith("review-")) {
    return {
      findings: [{ id: "f1", severity: "white", path: "src/file.ts", line: 1, claim: "Falta un caso.", fix: "Agregar un test.", ...optional("rule", "tests"), ...optional("trivial", false) }],
      previous: [{ id: "f0", status: "fixed" }],
    };
  }
  if (name.startsWith("triage.")) {
    return { items: [{ id: "f1", verdict: "valid", ...optional("reply", "Se corrige."), ...optional("fix", "Agregar un test."), ...optional("prRef", "owner/repo#1") }] };
  }
  if (name === "dev.plan") {
    return { approach: "Agregar un test.", files: ["src/file.ts"], tests: ["src/file.test.ts"], mold: "src/example.ts", assumptions: ["API estable."], issueDoubts: [{ says: "Cambiar la API.", why: "No hace falta.", evidence: "src/file.ts:1", alternative: "Conservarla." }] };
  }
  if (name.startsWith("dev.")) {
    return { files: ["src/file.ts"], rejected: [{ id: "r1", reason: "Fuera de alcance." }], deletedTests: [{ test: "anterior", now: "src/file.test.ts" }], cuts: [{ behavior: "Agrega cobertura.", paths: ["src/file.test.ts"] }] };
  }
  if (name === "committer.plan") {
    return { commits: [{ message: "test: add coverage", hunks: ["h1"], tests: ["unit"], whyAtomic: "Un comportamiento." }], pr: { title: "Agregar cobertura", body: "Cubre un caso." }, notes: ["Sin cambios de API."] };
  }
  if (name === "committer.route") {
    return { commits: [{ message: "test: add coverage", hunks: ["h1"], tests: ["unit"], whyAtomic: "Un comportamiento.", ...optional("into", "abc123") }] };
  }
  if (name === "plan-check.check") return { doubts: [{ says: "Cambiar la API.", decision: "alternative", why: "No hace falta." }], corrections: ["Conservar la API."] };
  if (name === "chat.turn") return { reply: "Actualicé el borrador.", proposal: { summary: "Agrega cobertura.", items: [{ id: "i1", change: "Agregar un test.", ...optional("path", "src/file.test.ts") }] } };
  throw new Error(`Falta el fixture de ${name}`);
}

function reportFor(name: string, mode: RoleMode, learnings: boolean, optionals: Optionals): JsonSchema {
  const optional = (key: string, value: unknown) => optionals === "omitted" ? {} : { [key]: optionals === "null" ? null : value };
  return {
    outcome: mode.outcomes[0],
    summary: "Reporte de prueba.",
    ...optional("decisions", [{ title: "Mantener la API", body: "No necesita cambios." }]),
    ...(learnings && optional("learnings", [{ text: "La API mantiene su contrato.", scope: "repo" }])),
    payload: payloadFor(name, optionals),
  };
}

function assertStrict(schema: JsonSchema): void {
  expect(schema).not.toHaveProperty("$schema");
  expect(schema).not.toHaveProperty("oneOf");
  expect(schema).not.toHaveProperty("default");
  if (schema.type === "object" || (Array.isArray(schema.type) && schema.type.includes("object")) || schema.properties !== undefined) {
    const properties = schema.properties as Record<string, JsonSchema>;
    expect(schema.additionalProperties).toBe(false);
    expect(schema.required).toEqual(Object.keys(properties));
  }
  for (const key of ["properties", "$defs", "definitions"]) {
    for (const child of Object.values((schema[key] ?? {}) as Record<string, JsonSchema>)) assertStrict(child);
  }
  if (schema.items) assertStrict(schema.items as JsonSchema);
  for (const child of (schema.anyOf ?? []) as JsonSchema[]) assertStrict(child);
}

describe("reportes strict de Codex", () => {
  test.each([
    { type: "object", additionalProperties: { type: "integer" } },
    { type: "object", additionalProperties: true },
    { type: "object", properties: { counts: { type: "object", additionalProperties: { type: "integer" } } } },
  ])("rechaza mapas dinámicos sin modificar el esquema original (%j)", (schema) => {
    const before = structuredClone(schema);
    expect(() => codexReportSchema(schema)).toThrow(/Codex no admite mapas dinámicos/);
    expect(schema).toEqual(before);
  });

  test("el chequeo strict exige required-all y objetos cerrados, aunque Ajv los acepte", () => {
    const optional: JsonSchema = { type: "object", properties: { value: { type: "string" } }, required: [], additionalProperties: false };
    const open: JsonSchema = { type: "object", properties: { value: { type: "string" } }, required: ["value"] };
    expect(new Ajv().validateSchema(optional)).toBe(true);
    expect(new Ajv().validateSchema(open)).toBe(true);
    expect(() => assertStrict(optional)).toThrow();
    expect(() => assertStrict(open)).toThrow();
  });

  test.each(modes)("%s hace roundtrip con y sin learnings y opcionales", (name, mode) => {
    for (const learnings of [false, true]) {
      const original = outputSchemaFor(mode, learnings);
      const snapshot = structuredClone(original);
      const transport = codexReportSchema(original);
      assertStrict(transport);
      const validateTransport = new Ajv({ strict: true }).compile(transport);
      const validateOriginal = compileJsonSchema(original);
      for (const present of [false, true]) {
        const expected = reportFor(name, mode, learnings, present ? "present" : "omitted");
        const response = reportFor(name, mode, learnings, present ? "present" : "null");
        const before = structuredClone(response);
        expect(validateOriginal.safeParse(expected).success).toBe(true);
        expect(validateTransport(response), JSON.stringify(validateTransport.errors)).toBe(true);
        expect(normalizeCodexReport(response, original)).toEqual(expected);
        expect(validateOriginal.safeParse(normalizeCodexReport(response, original)).success).toBe(true);
        expect(response).toEqual(before);
        if (!present) expect(validateTransport(expected)).toBe(false);
      }
      expect(original).toEqual(snapshot);
      expect(Object.keys(transport.properties as object).includes("learnings")).toBe(learnings);
    }
  });

  test("chat conserva proposal null requerido y normaliza dentro de una propuesta", () => {
    const original = outputSchemaFor(roles.chat!.modes.turn!);
    const response = { outcome: "ok", summary: "Sin cambios.", decisions: null, payload: { reply: "No cambié archivos.", proposal: null } };
    const validate = new Ajv().compile(codexReportSchema(original));
    expect(validate(response)).toBe(true);
    expect(normalizeCodexReport(response, original)).toEqual({ outcome: "ok", summary: "Sin cambios.", payload: response.payload });
    expect(compileJsonSchema(original).safeParse(normalizeCodexReport(response, original)).success).toBe(true);
  });

  test("cierra objetos anidados y no altera datos que parecen keywords", () => {
    const original: JsonSchema = {
      type: "object",
      properties: {
        properties: { type: "string", enum: ["required", "oneOf"] },
        child: { type: "object", properties: { label: { type: "string", default: "default" } } },
      },
    };
    const before = structuredClone(original);
    const transport = codexReportSchema(original);
    assertStrict(transport);
    const validate = new Ajv().compile(transport);
    expect(validate({ properties: "required", child: { label: null } })).toBe(true);
    expect(validate({ properties: "required", child: {} })).toBe(false);
    expect(validate({ properties: "required", child: { label: null, extra: 1 } })).toBe(false);
    expect(original).toEqual(before);
  });

  test("adapta oneOf a anyOf y conserva restricciones admitidas", () => {
    const original: JsonSchema = {
      type: "object",
      properties: { choice: { oneOf: [{ type: "string", minLength: 1 }, { type: "integer", minimum: 1, maximum: 10 }] } },
      required: ["choice"],
      additionalProperties: false,
    };
    const transport = codexReportSchema(original);
    assertStrict(transport);
    const validate = new Ajv().compile(transport);
    expect(validate({ choice: "a" })).toBe(true);
    expect(validate({ choice: 1 })).toBe(true);
    expect(validate({ choice: "" })).toBe(false);
    expect(validate({ choice: 11 })).toBe(false);
    expect(normalizeCodexReport({ choice: 1 }, original)).toEqual({ choice: 1 });
  });

  test("solo elimina null de propiedades opcionales no nullable", () => {
    const original: JsonSchema = {
      type: "object",
      properties: {
        absent: { type: "string" },
        nullable: { type: ["string", "null"] },
        union: { anyOf: [{ type: "string" }, { type: "null" }] },
        required: { type: "string" },
        array: { type: "array", items: { type: ["string", "null"] } },
      },
      required: ["required", "array"],
      additionalProperties: false,
    };
    const response = { absent: null, nullable: null, union: null, required: null, array: [null, "a"], unknown: null };
    expect(normalizeCodexReport(response, original)).toEqual({ nullable: null, union: null, required: null, array: [null, "a"], unknown: null });
    expect(normalizeCodexReport(null, original)).toBeNull();
    expect(normalizeCodexReport("invalid", original)).toBe("invalid");
  });

  test("resuelve referencias locales para opcionales y sus objetos anidados", () => {
    const original: JsonSchema = {
      type: "object",
      properties: { child: { $ref: "#/$defs/child" }, nullable: { $ref: "#/$defs/nullable" } },
      additionalProperties: false,
      $defs: {
        child: { type: "object", properties: { note: { type: "string" } }, additionalProperties: false },
        nullable: { anyOf: [{ type: "string" }, { type: "null" }] },
      },
    };
    const transport = codexReportSchema(original);
    assertStrict(transport);
    const validate = new Ajv().compile(transport);
    expect(validate({ child: null, nullable: null })).toBe(true);
    expect(validate({ child: { note: null }, nullable: null })).toBe(true);
    expect(normalizeCodexReport({ child: null, nullable: null }, original)).toEqual({ nullable: null });
    expect(normalizeCodexReport({ child: { note: null }, nullable: null }, original)).toEqual({ child: {}, nullable: null });
  });

  test("elige la rama que ya permite null antes de eliminarlo de otra rama opcional", () => {
    const original: JsonSchema = {
      type: "object",
      properties: {
        choice: {
          anyOf: [
            { type: "object", properties: { value: { type: "string" } }, additionalProperties: false },
            { type: "object", properties: { value: { type: "null" } }, required: ["value"], additionalProperties: false },
          ],
        },
      },
      required: ["choice"],
      additionalProperties: false,
    };
    const response = { choice: { value: null } };
    expect(normalizeCodexReport(response, original)).toEqual(response);
    expect(compileJsonSchema(original).safeParse(normalizeCodexReport(response, original)).success).toBe(true);
  });

  test("cierra objetos nullable sin propiedades", () => {
    const transport = codexReportSchema({ type: "object", properties: { child: { type: ["object", "null"] } }, required: ["child"] });
    const validate = new Ajv().compile(transport);
    expect(validate({ child: null })).toBe(true);
    expect(validate({ child: {} })).toBe(true);
    expect(validate({ child: { extra: 1 } })).toBe(false);
  });
});

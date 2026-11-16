import type { JsonSchema } from "@clanker/api";
import { Ajv } from "ajv";
import { describe, expect, test } from "vitest";
import { roles } from "../../template/roles";
import { outputSchemaFor } from "../agents";
import { toOptions } from "./options";

// Claude Code compila `outputFormat.schema` al arrancar y, si no puede, sale con código 1 antes del primer turno
// (#155: el `$schema` 2020-12 de zod daba "no schema with key or ref"). Lo valida con Ajv 8 en su modo por defecto
// (draft-07, strict), así: `new Ajv({ allErrors: true, validateFormats: false, multipleOfPrecision: 6 })`,
// `validateSchema` y `compile`. Cada reporte de la plantilla tiene que pasar igual.

const modes = Object.entries(roles).flatMap(([slug, role]) => Object.entries(role.modes).map(([mode, def]) => [`${slug}.${mode}`, def] as const));

function compileLikeClaudeCode(schema: JsonSchema): string | undefined {
  const ajv = new Ajv({ allErrors: true, validateFormats: false, multipleOfPrecision: 6 });
  try {
    if (!ajv.validateSchema(schema)) return ajv.errorsText(ajv.errors);
    ajv.compile(schema);
    return undefined;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

const outputFormatOf = (outputSchema: JsonSchema) =>
  toOptions(
    { role: "r", cwd: "/w", systemPrompt: "", prompt: "", model: "sonnet", references: [], hooks: false, tools: "all", outputSchema },
    { env: {}, executable: undefined, abort: new AbortController(), logCompaction: async () => ({}) },
  ).outputFormat;

describe("el reporte que recibe Claude Code", () => {
  test.each(modes)("%s compila como lo compila Claude Code", (_name, mode) => {
    const format = outputFormatOf(outputSchemaFor(mode));
    expect(format?.type).toBe("json_schema");
    expect(compileLikeClaudeCode(format!.schema as JsonSchema)).toBeUndefined();
  });

  test("el validador es el de Claude Code: rechaza el $schema que declara zod", () => {
    expect(compileLikeClaudeCode({ $schema: "https://json-schema.org/draft/2020-12/schema", type: "object" })).toMatch(/no schema with key or ref/);
  });
});

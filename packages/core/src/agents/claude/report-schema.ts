import type { JsonSchema } from "@clanker/api";
import { Ajv } from "ajv";

/**
 * Por qué Claude Code no podría compilar `schema` como `--json-schema`, o `undefined` si puede. Claude Code lo compila
 * al arrancar con Ajv 8 en su modo por defecto (draft-07, strict): `new Ajv({ allErrors: true, validateFormats: false,
 * multipleOfPrecision: 6 })`, `validateSchema` y `compile`; si falla, sale con código 1 antes del primer turno (#155:
 * el `$schema` 2020-12 de zod, o un `prefixItems` de una tupla). Recibe el esquema como lo arma `outputSchemaFor` y le
 * saca `$schema`, como `forClaude` de `options.ts` antes de mandarlo.
 */
export function claudeSchemaError(schema: JsonSchema): string | undefined {
  const ajv = new Ajv({ allErrors: true, validateFormats: false, multipleOfPrecision: 6 });
  const sent = { ...schema };
  delete sent.$schema;
  try {
    if (!ajv.validateSchema(sent)) return ajv.errorsText(ajv.errors);
    ajv.compile(sent);
    return undefined;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

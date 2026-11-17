import { readFileSync } from "node:fs";
import { buildSchema, parse, validate } from "graphql";
import { describe, expect, test } from "vitest";
import { RESOLVE_THREAD } from "./actions/pr-feedback";
import { DEFAULT_BRANCH_CHECKS, MORE_CONTEXTS, MORE_THREADS, PR_QUERY } from "./pr-query";

// El GitHub falso y el simulador responden por el nombre de la operación sin mirar los campos que se piden: un campo
// mal escrito pasa la suite entera. Esto valida cada documento contra el esquema público de GitHub
// (`fixtures/schema.docs.graphql`, de docs.github.com/public/fpt/schema.docs.graphql). Si GitHub cambia el esquema o
// una query pide algo nuevo, se baja otra vez ese archivo.
// `assumeValid`: el esquema publicado no pasa la validación estricta de graphql-js 17 (un `id` deprecado que implementa
// `Node.id`, que no lo está), y lo que se prueba aquí son nuestras queries, no el esquema de GitHub.
const schema = buildSchema(readFileSync(new URL("./fixtures/schema.docs.graphql", import.meta.url), "utf8"), { assumeValid: true, assumeValidSDL: true });

const DOCUMENTS = { PR_QUERY, MORE_THREADS, MORE_CONTEXTS, DEFAULT_BRANCH_CHECKS, RESOLVE_THREAD };

describe("las queries y mutations de GitHub cumplen su esquema público", () => {
  test.each(Object.entries(DOCUMENTS))("%s", (_name, document) => {
    expect(validate(schema, parse(document)).map((e) => e.message)).toEqual([]);
  });
});

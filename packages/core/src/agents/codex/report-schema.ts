import { compileJsonSchema, type JsonSchema } from "@clanker/api";

function isSchema(value: unknown): value is JsonSchema {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function accepts(value: unknown, schema: JsonSchema, root: JsonSchema): boolean {
  return compileJsonSchema({
    ...(root.$defs !== undefined && { $defs: root.$defs }),
    ...(root.definitions !== undefined && { definitions: root.definitions }),
    ...schema,
  }).safeParse(value).success;
}

export function codexReportSchema(schema: JsonSchema): JsonSchema {
  const root = structuredClone(schema);
  function adapt(node: JsonSchema): void {
    if (node.additionalProperties === true || isSchema(node.additionalProperties)) {
      throw new Error("Codex no admite mapas dinámicos en el reporte (additionalProperties): declara propiedades explícitas o usa una lista de pares clave/valor.");
    }
    delete node.$schema;
    delete node.default;
    if (Array.isArray(node.oneOf)) {
      node.anyOf = node.oneOf;
      delete node.oneOf;
    }
    for (const keyword of ["$defs", "definitions", "properties"]) {
      const entries = node[keyword];
      if (isSchema(entries)) {
        for (const child of Object.values(entries)) if (isSchema(child)) adapt(child);
      }
    }
    if (isSchema(node.items)) adapt(node.items);
    if (Array.isArray(node.anyOf)) {
      for (const child of node.anyOf) if (isSchema(child)) adapt(child);
    }
    if (node.type === "object" || (Array.isArray(node.type) && node.type.includes("object")) || isSchema(node.properties)) {
      const properties = isSchema(node.properties) ? node.properties : {};
      const required = Array.isArray(node.required) ? node.required : [];
      for (const [key, child] of Object.entries(properties)) {
        if (isSchema(child) && !required.includes(key) && !accepts(null, child, root)) {
          properties[key] = { anyOf: [child, { type: "null" }] };
        }
      }
      node.properties = properties;
      node.required = Object.keys(properties);
      node.additionalProperties = false;
    }
  }
  adapt(root);
  return root;
}

export function normalizeCodexReport(value: unknown, schema: JsonSchema): unknown {
  function normalize(current: unknown, node: JsonSchema): unknown {
    if (typeof node.$ref === "string" && node.$ref.startsWith("#/")) {
      let target: unknown = schema;
      for (const part of node.$ref.slice(2).split("/")) {
        target = isSchema(target) ? target[part.replace(/~1/g, "/").replace(/~0/g, "~")] : undefined;
      }
      if (isSchema(target)) return normalize(current, target);
    }
    const branches = node.anyOf ?? node.oneOf;
    if (Array.isArray(branches)) {
      const candidates = branches.filter(isSchema);
      const exact = candidates.find((branch) => accepts(current, branch, schema));
      if (exact) return normalize(current, exact);
      for (const branch of candidates) {
        const normalized = normalize(current, branch);
        if (accepts(normalized, branch, schema)) return normalized;
      }
      return current;
    }
    if (Array.isArray(current) && isSchema(node.items)) {
      const items = node.items;
      return current.map((item) => normalize(item, items));
    }
    if (!isSchema(current) || !isSchema(node.properties)) return current;
    const properties = node.properties;
    const required = Array.isArray(node.required) ? node.required : [];
    return Object.fromEntries(Object.entries(current).flatMap(([key, entry]) => {
      const property = properties[key];
      if (!isSchema(property)) return [[key, entry]];
      if (entry === null && !required.includes(key) && !accepts(null, property, schema)) return [];
      return [[key, normalize(entry, property)]];
    }));
  }
  return normalize(value, schema);
}

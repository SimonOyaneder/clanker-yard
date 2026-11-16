import { Role } from "@clanker/api";
import { describe, expect, test } from "vitest";
import { parseRepoConfigPath, parseRepoFile, renderRepoFile, repoConfigPath, RepoFileSyntaxError } from "./files";

describe("rutas de .clanker/", () => {
  test("cada kind tiene su carpeta y extensión, y la ruta vuelve al kind y al slug", () => {
    expect(repoConfigPath("flow", "mi-flujo")).toBe(".clanker/flows/mi-flujo.json");
    expect(repoConfigPath("role", "dev")).toBe(".clanker/roles/dev.md");
    expect(repoConfigPath("profile", "barato")).toBe(".clanker/profiles/barato.json");
    expect(parseRepoConfigPath(".clanker/roles/dev.md")).toEqual({ kind: "role", slug: "dev" });
  });

  test("lo que no es una def (otra extensión, subcarpeta, slug inválido, la receta) se ignora", () => {
    for (const path of [".clanker/flows/x.md", ".clanker/roles/a/b.md", ".clanker/flows/1x.json", ".clanker/recipe.json", ".clanker/flows/.json"]) {
      expect(parseRepoConfigPath(path)).toBeUndefined();
    }
  });
});

describe("contenido de un archivo", () => {
  const role = {
    prompt: "Eres el dev.\n\nHaz lo que pide la issue.",
    context: [],
    modes: { dev: { instructions: "Implementa", report: {}, outcomes: ["ok"], session: "new" } },
  };

  test("un rol es markdown con el prompt como texto y el resto como JSON arriba, y se lee igual", () => {
    const text = renderRepoFile("role", role);

    expect(text.startsWith("---\n{")).toBe(true);
    expect(text.endsWith("Eres el dev.\n\nHaz lo que pide la issue.\n")).toBe(true);
    expect(parseRepoFile("role", text)).toEqual(role);
    expect(Role.safeParse(parseRepoFile("role", text)).success).toBe(true);
  });

  test("un flujo o un perfil es su body en JSON", () => {
    const profile = { roles: { dev: { model: "sonnet" } } };
    expect(parseRepoFile("profile", renderRepoFile("profile", profile))).toEqual(profile);
  });

  test.each([
    ["flow", "{ no es json", /no es JSON/],
    ["role", "solo texto", /empieza con un bloque JSON/],
    ["role", "---\n[1]\n---\nhola", /objeto JSON/],
  ] as const)("un %s ilegible dice por qué", (kind, text, message) => {
    expect(() => parseRepoFile(kind, text)).toThrow(RepoFileSyntaxError);
    expect(() => parseRepoFile(kind, text)).toThrow(message);
  });
});

import { describe, expect, test } from "vitest";
import { configFor, parseModel, permissionsFor, REPORT_TOOL, reportSchema, serverEnv, systemFor, type PermissionRule } from "./config";

const denied = (rules: PermissionRule[]) => rules.filter((r) => r.effect === "deny").map((r) => `${r.action}:${r.resource}`);

describe("permisos", () => {
  test("libertad total: todo permitido salvo preguntar, y nunca se niega *", () => {
    expect(permissionsFor({ tools: "all", native: { sources: ["user", "project"], skills: "all" } })).toEqual([
      { action: "*", resource: "*", effect: "allow" },
      { action: "question", resource: "*", effect: "deny" },
    ]);
  });

  test("un rol de solo lectura niega cada acción con nombre de opencode 2 (bash es shell, Task es subagent)", () => {
    const rules = permissionsFor({ tools: { allow: ["Read", "Grep", "Glob"] }, native: { sources: [], skills: "all" } });
    expect(rules[0]).toEqual({ action: "*", resource: "*", effect: "allow" });
    expect(denied(rules)).toEqual(["question:*", "edit:*", "shell:*", "subagent:*", "skill:*", "webfetch:*", "websearch:*"]);
  });

  test("deny niega las herramientas nombradas con la acción de opencode 2", () => {
    expect(denied(permissionsFor({ tools: { deny: ["Bash", "WebFetch", "acme_deploy"] }, native: { sources: [], skills: "all" } }))).toEqual([
      "question:*",
      "shell:*",
      "webfetch:*",
      "acme_deploy:*",
    ]);
  });

  test("las skills del rol son las únicas permitidas (gana la última regla); sin native, ninguna", () => {
    expect(permissionsFor({ tools: "all", native: { sources: ["user"], skills: ["commit", "create-pr"] } }).slice(2)).toEqual([
      { action: "skill", resource: "*", effect: "deny" },
      { action: "skill", resource: "commit", effect: "allow" },
      { action: "skill", resource: "create-pr", effect: "allow" },
    ]);
    expect(denied(permissionsFor({ tools: "all", native: undefined }))).toEqual(["question:*", "skill:*"]);
  });
});

describe("config del run", () => {
  const spec = {
    tools: "all" as const,
    native: undefined,
    hooks: false,
    systemPrompt: "Eres dev.",
    references: [{ label: "repo:AGENTS.md", content: "reglas" }],
    outputSchema: { $schema: "https://json-schema.org/draft/2020-12/schema", type: "object" },
  };

  test("un agente propio con el prompt del rol y el plugin del reporte con el esquema del modo", () => {
    const config = configFor(spec, "/home/clanker/agent-env/opencode/report-plugin");
    expect(config).toMatchObject({
      update: "disable",
      agents: { clanker: { mode: "primary", system: expect.stringContaining("Eres dev.") } },
    });
    expect(config.plugins).toEqual(["-*", "opencode.*", { package: "/home/clanker/agent-env/opencode/report-plugin", options: { schema: { type: "object" } } }]);
  });

  test("con los hooks del rol, los plugins del usuario siguen", () => {
    expect(configFor({ ...spec, hooks: true }, "/p").plugins).toEqual([{ package: "/p", options: { schema: { type: "object" } } }]);
  });

  test("el prompt de sistema lleva el rol, los archivos de contexto y cómo entregar el reporte, en ese orden", () => {
    const system = systemFor(spec);
    expect(system.indexOf("Eres dev.")).toBeLessThan(system.indexOf("# repo:AGENTS.md\n\nreglas"));
    expect(system.indexOf("reglas")).toBeLessThan(system.indexOf(REPORT_TOOL));
  });

  test("el esquema del reporte va sin $schema", () => {
    expect(reportSchema({ $schema: "x", type: "object" })).toEqual({ type: "object" });
  });
});

describe("entorno", () => {
  const baseEnv = {
    PATH: "/usr/bin",
    HOME: "/home/simon",
    USER: "simon",
    XDG_DATA_HOME: "/xdg/data",
    GH_TOKEN: "ghp_secreto",
    GITHUB_TOKEN: "ghs_secreto",
    LINEAR_API_KEY: "lin_secreto",
    SSH_AUTH_SOCK: "/tmp/agent",
    OPENAI_API_KEY: "sk-secreto",
    ANTHROPIC_API_KEY: "sk-ant-secreto",
  };

  test("se arma con lista blanca: ningún token ni API key llega al agente; la contraseña va en OPENCODE_PASSWORD", () => {
    const env = serverEnv({ baseEnv, ghConfigDir: "/gh", gitConfig: "/gitconfig", password: "pw", config: { update: "disable" } });
    expect(Object.values(env).join(" ")).not.toMatch(/secreto|\/tmp\/agent/);
    expect(env).toEqual({
      PATH: "/usr/bin",
      HOME: "/home/simon",
      USER: "simon",
      XDG_DATA_HOME: "/xdg/data",
      GH_CONFIG_DIR: "/gh",
      GIT_CONFIG_GLOBAL: "/gitconfig",
      GIT_CONFIG_NOSYSTEM: "1",
      OPENCODE_PASSWORD: "pw",
      OPENCODE_CONFIG_CONTENT: '{"update":"disable"}',
    });
  });
});

test("el modelo va como proveedor/modelo, sin variante pegada; el modelo puede traer más /", () => {
  expect(parseModel("openai/gpt-6.1-terra")).toEqual({ providerID: "openai", id: "gpt-6.1-terra" });
  expect(parseModel("openrouter/anthropic/claude-sonnet-5")).toEqual({ providerID: "openrouter", id: "anthropic/claude-sonnet-5" });
  for (const bad of ["sonnet", "/gpt", "openai/", "openai/gpt-6.1-terra#high"]) expect(() => parseModel(bad)).toThrow(/proveedor\/modelo/);
});

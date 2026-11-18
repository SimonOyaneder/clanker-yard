import { expect, test } from "vitest";
import { CODEX_ARGS, CODEX_CONFIG, codexEnv, isolatedThreadConfig } from "./config";

test("hereda solo el entorno necesario para el login existente, sin secretos, proxies ni destinos alternativos", () => {
  const env = codexEnv({
    PATH: "/bin", HOME: "/home/user", USER: "user", LANG: "es_CL.UTF-8", TMPDIR: "/tmp/user", CODEX_HOME: "/home/user/codex",
    OPENAI_API_KEY: "secret", CODEX_API_KEY: "secret", CODEX_ACCESS_TOKEN: "secret", OPENAI_BASE_URL: "https://example.invalid",
    GH_TOKEN: "secret", GITHUB_TOKEN: "secret", LINEAR_API_KEY: "secret", SSH_AUTH_SOCK: "/sock",
    ANTHROPIC_API_KEY: "secret", HTTPS_PROXY: "https://example.invalid",
  });
  expect(env).toEqual({ PATH: "/bin", HOME: "/home/user", USER: "user", LANG: "es_CL.UTF-8", TMPDIR: "/tmp/user", CODEX_HOME: "/home/user/codex" });
  expect(CODEX_ARGS).toContain("features.plugins=false");
  expect(CODEX_ARGS).toContain("features.apps=false");
  expect(CODEX_ARGS).toContain("features.codex_hooks=false");
  expect(CODEX_ARGS).toContain("notify=[]");
  expect(CODEX_ARGS).toContain("project_doc_max_bytes=32768");
});

test("deshabilita los MCP efectivos del cwd y los overrides del caller sin mutar lo leído ni copiar su entorno", () => {
  const effective = { mcp_servers: { user: { command: "false", env: { SECRET: "private" } }, project: { command: "false" } } };
  const config = isolatedThreadConfig(effective, { notify: ["false"], "features.plugins": true, mcp_servers: { extra: { command: "false", enabled: true } }, "mcp_servers.project.enabled": true });
  expect(config).toMatchObject({
    ...CODEX_CONFIG,
    mcp_servers: { user: { enabled: false }, project: { enabled: false } },
  });
  expect(config).not.toHaveProperty("mcp_servers.extra");
  expect(config["mcp_servers.project.enabled"]).toBeUndefined();
  expect(JSON.stringify(config)).not.toContain("private");
  expect(effective.mcp_servers.user).not.toHaveProperty("enabled");
  expect(isolatedThreadConfig({})).toEqual({ ...CODEX_CONFIG, mcp_servers: {} });
});

import { expect, test } from "vitest";
import { CODEX_ARGS, codexEnv } from "./config";

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

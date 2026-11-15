import { SYSTEM_PROMPT_DYNAMIC_BOUNDARY, type HookCallback } from "@anthropic-ai/claude-agent-sdk";
import { describe, expect, test } from "vitest";
import type { RunSpec } from "../runtime";
import { apiKeyCredentials, subscriptionCredentials } from "./credentials";
import { agentEnv, toOptions, type RunCtx } from "./options";

const spec: RunSpec = {
  role: "dev",
  cwd: "/work/tree",
  systemPrompt: "Eres el dev.",
  prompt: "Haz lo tuyo.",
  model: "sonnet",
  effort: "high",
  context: [{ kind: "native", sources: ["user", "project"], skills: ["commit"] }],
  hooks: false,
  tools: "all",
  outputSchema: { type: "object", properties: { ok: { type: "boolean" } } },
};

const logCompaction: HookCallback = async () => ({});

function ctx(overrides: Partial<RunCtx> = {}): RunCtx {
  return {
    repoContext: "# AGENTS.md\n\nreglas",
    env: { HOME: "/home/x" },
    executable: "/usr/local/bin/claude",
    abort: new AbortController(),
    logCompaction,
    ...overrides,
  };
}

describe("toOptions", () => {
  test("mapea el RunSpec con libertad total, hooks apagados y reporte estructurado", () => {
    const c = ctx();
    const options = toOptions(spec, c);

    expect(options).toEqual({
      cwd: "/work/tree",
      model: "sonnet",
      effort: "high",
      systemPrompt: ["Eres el dev.", SYSTEM_PROMPT_DYNAMIC_BOUNDARY, "# AGENTS.md\n\nreglas"],
      permissionMode: "bypassPermissions",
      allowDangerouslySkipPermissions: true,
      settingSources: ["user", "project"],
      skills: ["commit"],
      settings: { disableAllHooks: true },
      hooks: { PreCompact: [{ hooks: [logCompaction] }] },
      outputFormat: { type: "json_schema", schema: spec.outputSchema },
      env: { HOME: "/home/x" },
      pathToClaudeCodeExecutable: "/usr/local/bin/claude",
      abortController: c.abort,
    });
  });

  test("un rol con hooks los activa", () => {
    expect(toOptions({ ...spec, hooks: true }, ctx()).settings).toEqual({ disableAllHooks: false });
  });

  test("sin fuente native: sources user y project, y ninguna skill", () => {
    const options = toOptions({ ...spec, context: [{ kind: "repo", files: ["AGENTS.md"] }] }, ctx());
    expect(options.settingSources).toEqual(["user", "project"]);
    expect(options.skills).toEqual([]);
  });

  test("sources y skills salen del rol", () => {
    const options = toOptions(
      { ...spec, context: [{ kind: "native", sources: ["project"], skills: "all" }] },
      ctx(),
    );
    expect(options.settingSources).toEqual(["project"]);
    expect(options.skills).toBe("all");
  });

  test("topes, retomar y sin contexto de repo", () => {
    const options = toOptions(
      { ...spec, maxTurns: 40, maxBudgetUsd: 1.5 },
      ctx({ repoContext: "", resume: "sess-1" }),
    );
    expect(options).toMatchObject({ maxTurns: 40, maxBudgetUsd: 1.5, resume: "sess-1" });
    expect(options.systemPrompt).toEqual(["Eres el dev."]);
  });

  test("sin tope no hay maxTurns ni maxBudgetUsd, y sin effort tampoco", () => {
    const options = toOptions({ ...spec, effort: undefined }, ctx());
    expect(options).not.toHaveProperty("maxTurns");
    expect(options).not.toHaveProperty("maxBudgetUsd");
    expect(options).not.toHaveProperty("effort");
    expect(options).not.toHaveProperty("resume");
  });

  test("una política de herramientas restringe con tools: allowedTools no quitaría Bash en bypass", () => {
    const options = toOptions({ ...spec, tools: { allow: ["Read", "Grep"], deny: ["WebFetch"] } }, ctx());
    expect(options.tools).toEqual(["Read", "Grep"]);
    expect(options.disallowedTools).toEqual(["WebFetch"]);
    expect(options).not.toHaveProperty("allowedTools");
  });

  test("sin executable usa el binario del SDK", () => {
    expect(toOptions(spec, ctx({ executable: undefined }))).not.toHaveProperty("pathToClaudeCodeExecutable");
  });
});

describe("agentEnv", () => {
  const paths = { ghConfigDir: "/home/x/agent-env/gh", gitConfig: "/home/x/agent-env/gitconfig" };
  const credentials = subscriptionCredentials({ executable: "/bin/claude" });

  // Todo lo que un agente podría usar para actuar en GitHub, Linear o gastar otra credencial.
  const polluted = {
    PATH: "/usr/bin",
    HOME: "/Users/x",
    USER: "x",
    LANG: "es_CL.UTF-8",
    GH_TOKEN: "ghp_1",
    GITHUB_TOKEN: "ghp_2",
    GH_ENTERPRISE_TOKEN: "ghp_3",
    GH_CONFIG_DIR: "/Users/x/.config/gh",
    LINEAR_API_KEY: "lin_1",
    LINEAR_OAUTH_TOKEN: "lin_2",
    SSH_AUTH_SOCK: "/tmp/agent.sock",
    GIT_CONFIG_GLOBAL: "/Users/x/.gitconfig",
    ANTHROPIC_API_KEY: "sk-1",
    ANTHROPIC_AUTH_TOKEN: "tok",
    CLAUDE_CODE_OAUTH_TOKEN: "oauth",
    CLAUDE_CODE_USE_BEDROCK: "1",
  };

  test("no hereda credenciales y apunta gh y git a lo generado por el core", () => {
    const env = agentEnv({ baseEnv: polluted, ...paths, credentials });

    expect(env).toEqual({
      PATH: "/usr/bin",
      HOME: "/Users/x",
      USER: "x",
      LANG: "es_CL.UTF-8",
      GH_CONFIG_DIR: paths.ghConfigDir,
      GIT_CONFIG_GLOBAL: paths.gitConfig,
      GIT_CONFIG_NOSYSTEM: "1",
      CLAUDE_CODE_DISABLE_BACKGROUND_TASKS: "1",
      BASH_DEFAULT_TIMEOUT_MS: "1800000",
      BASH_MAX_TIMEOUT_MS: "1800000",
    });
    expect(Object.keys(env).filter((k) => /TOKEN|LINEAR|ANTHROPIC|SSH_AUTH_SOCK|CLAUDE_CODE_USE/.test(k))).toEqual([]);
  });

  test("USER viaja: sin él Claude no encuentra el login en macOS", () => {
    expect(agentEnv({ baseEnv: { PATH: "/usr/bin", HOME: "/h", USER: "simon" }, ...paths, credentials }).USER).toBe(
      "simon",
    );
  });

  test("CLAUDE_CONFIG_DIR se hereda: ahí vive el login si el usuario lo movió", () => {
    const env = agentEnv({ baseEnv: { CLAUDE_CONFIG_DIR: "/cfg" }, ...paths, credentials });
    expect(env.CLAUDE_CONFIG_DIR).toBe("/cfg");
  });

  test("el caché de 1 h es opt-in del perfil", () => {
    expect(agentEnv({ baseEnv: {}, ...paths, credentials })).not.toHaveProperty("ENABLE_PROMPT_CACHING_1H");
    expect(agentEnv({ baseEnv: {}, ...paths, credentials, cacheTtl: "5m" })).not.toHaveProperty(
      "ENABLE_PROMPT_CACHING_1H",
    );
    expect(agentEnv({ baseEnv: {}, ...paths, credentials, cacheTtl: "1h" }).ENABLE_PROMPT_CACHING_1H).toBe("1");
  });

  test("en modo API key la key llega solo por las credenciales", () => {
    const env = agentEnv({
      baseEnv: polluted,
      ...paths,
      credentials: apiKeyCredentials("sk-propia", { executable: "/bin/claude" }),
    });
    expect(env.ANTHROPIC_API_KEY).toBe("sk-propia");
    expect(env).not.toHaveProperty("ANTHROPIC_AUTH_TOKEN");
  });
});

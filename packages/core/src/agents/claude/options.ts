import type { HookCallback, Options } from "@anthropic-ai/claude-agent-sdk";
import { SYSTEM_PROMPT_DYNAMIC_BOUNDARY } from "@anthropic-ai/claude-agent-sdk";
import type { RunSpec } from "../runtime";
import type { ClaudeCredentials } from "./credentials";

/** Lo único que se hereda del entorno del core. `USER`: sin él Claude no encuentra el login en macOS. */
const INHERITED_ENV = ["PATH", "HOME", "USER", "LANG", "CLAUDE_CONFIG_DIR"] as const;

const BASH_TIMEOUT_MS = "1800000";

export interface AgentEnvInput {
  baseEnv: Record<string, string | undefined>;
  /** Carpeta vacía: `gh` no encuentra sesión. */
  ghConfigDir: string;
  /** Config global de git generado por el core (solo identidad y `credential.helper` vacío). */
  gitConfig: string;
  cacheTtl?: RunSpec["cacheTtl"];
  credentials: ClaudeCredentials;
}

/**
 * El entorno del agente se arma desde cero con una lista blanca: lo que no se nombra aquí
 * (`GH_TOKEN`, `GITHUB_TOKEN`, `LINEAR_*`, `SSH_AUTH_SOCK`, `ANTHROPIC_*`) no llega. Lo que sale a
 * GitHub o Linear lo hace el core.
 */
export function agentEnv({
  baseEnv,
  ghConfigDir,
  gitConfig,
  cacheTtl,
  credentials,
}: AgentEnvInput): Record<string, string> {
  const inherited: Record<string, string> = {};
  for (const key of INHERITED_ENV) {
    const value = baseEnv[key];
    if (value !== undefined) inherited[key] = value;
  }
  return {
    ...inherited,
    GH_CONFIG_DIR: ghConfigDir,
    GIT_CONFIG_GLOBAL: gitConfig,
    GIT_CONFIG_NOSYSTEM: "1",
    CLAUDE_CODE_DISABLE_BACKGROUND_TASKS: "1",
    BASH_DEFAULT_TIMEOUT_MS: BASH_TIMEOUT_MS,
    // Sin esto el default se recorta a 10 min: el timeout alto no serviría sin tareas en background.
    BASH_MAX_TIMEOUT_MS: BASH_TIMEOUT_MS,
    ...(cacheTtl === "1h" ? { ENABLE_PROMPT_CACHING_1H: "1" } : {}),
    ...credentials.env(),
  };
}

export interface RunCtx {
  /** Lo que resolvieron las fuentes `repo` y `file` del rol; va después del límite cacheable. */
  repoContext: string;
  env: Record<string, string>;
  executable: string | undefined;
  abort: AbortController;
  /** El id de la sesión que se retoma. */
  resume?: string;
  logCompaction: HookCallback;
}

/** RunSpec → Options del SDK (`docs/design.html#d-agents`, "Adapter Claude"). */
export function toOptions(spec: RunSpec, ctx: RunCtx): Options {
  const native = spec.context.find((c) => c.kind === "native");
  return {
    cwd: spec.cwd,
    model: spec.model,
    ...(spec.effort === undefined ? {} : { effort: spec.effort }),
    systemPrompt:
      ctx.repoContext === ""
        ? [spec.systemPrompt]
        : [spec.systemPrompt, SYSTEM_PROMPT_DYNAMIC_BOUNDARY, ctx.repoContext],
    // Libertad total.
    permissionMode: "bypassPermissions",
    allowDangerouslySkipPermissions: true,
    // `tools` (no `allowedTools`): con bypass, `allowedTools` solo auto-aprueba y no quita Bash.
    ...(spec.tools === "all"
      ? {}
      : {
          ...(spec.tools.allow === undefined ? {} : { tools: spec.tools.allow }),
          ...(spec.tools.deny === undefined ? {} : { disallowedTools: spec.tools.deny }),
        }),
    settingSources: native?.sources ?? ["user", "project"],
    skills: native?.skills ?? [],
    // Gana sobre los hooks de user y de project, pero no sobre los de este objeto `hooks`.
    settings: { disableAllHooks: !spec.hooks },
    hooks: { PreCompact: [{ hooks: [ctx.logCompaction] }] },
    outputFormat: { type: "json_schema", schema: spec.outputSchema },
    ...(spec.maxTurns === undefined ? {} : { maxTurns: spec.maxTurns }),
    ...(spec.maxBudgetUsd === undefined ? {} : { maxBudgetUsd: spec.maxBudgetUsd }),
    ...(ctx.resume === undefined ? {} : { resume: ctx.resume }),
    env: ctx.env,
    ...(ctx.executable === undefined ? {} : { pathToClaudeCodeExecutable: ctx.executable }),
    abortController: ctx.abort,
  };
}

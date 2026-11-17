import type { HookCallback, Options } from "@anthropic-ai/claude-agent-sdk";
import { SYSTEM_PROMPT_DYNAMIC_BOUNDARY } from "@anthropic-ai/claude-agent-sdk";
import { pickEnv } from "../../procs/env";
import type { RunSpec } from "../runtime";
import type { ClaudeCredentials } from "./credentials";

/** Lo único que se hereda del entorno del core. `USER`: sin él Claude no encuentra el login en macOS. */
const INHERITED_ENV = ["PATH", "HOME", "USER", "LANG", "CLAUDE_CONFIG_DIR"] as const;

const BASH_TIMEOUT_MS = "1800000";

/** De `baseEnv`, solo `INHERITED_ENV`: lo que hace falta para que `claude` encuentre su login. */
export const inheritedEnv = (baseEnv: Record<string, string | undefined>): Record<string, string> => pickEnv(INHERITED_ENV, baseEnv);

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
  return {
    ...inheritedEnv(baseEnv),
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

/**
 * Claude Code valida `--json-schema` sin el meta-esquema 2020-12 que `z.toJSONSchema` declara en `$schema`:
 * con él sale con "no schema with key or ref" y el run muere antes de empezar.
 */
function forClaude(schema: RunSpec["outputSchema"]): RunSpec["outputSchema"] {
  const rest = { ...schema };
  delete rest.$schema;
  return rest;
}

export interface RunCtx {
  env: Record<string, string>;
  executable: string | undefined;
  abort: AbortController;
  /** El id de la sesión que se retoma. */
  resume?: string;
  logCompaction: HookCallback;
  /** Cómo se lanza el proceso de Claude Code; sin él, el SDK lo lanza a su manera. */
  spawn?: Options["spawnClaudeCodeProcess"];
}

/**
 * RunSpec → Options del SDK (`docs/design.html#d-agents`, "Adapter Claude").
 *
 * Orden del prefijo cacheable: herramientas → prompt del rol → `SYSTEM_PROMPT_DYNAMIC_BOUNDARY` →
 * contexto del repo → brief en el mensaje del usuario (`spec.prompt`). Antes del límite no entra nada
 * que cambie entre lanzamientos (fecha, cwd, git status): el prompt del rol es el de la def tal cual y
 * las herramientas restringidas van ordenadas, así el mismo rol repite el prefijo byte a byte.
 */
export function toOptions(spec: RunSpec, ctx: RunCtx): Options {
  // Los archivos de contexto van después del límite cacheable: cambian con el repo y con lo que el usuario edita.
  const references = spec.references.map((r) => `# ${r.label}\n\n${r.content}`).join("\n\n");
  return {
    cwd: spec.cwd,
    model: spec.model,
    ...(spec.effort === undefined ? {} : { effort: spec.effort }),
    systemPrompt:
      references === ""
        ? [spec.systemPrompt]
        : [spec.systemPrompt, SYSTEM_PROMPT_DYNAMIC_BOUNDARY, references],
    // Libertad total.
    permissionMode: "bypassPermissions",
    allowDangerouslySkipPermissions: true,
    // `tools` (no `allowedTools`): con bypass, `allowedTools` solo auto-aprueba y no quita Bash.
    ...(spec.tools === "all"
      ? {}
      : {
          ...(spec.tools.allow === undefined ? {} : { tools: spec.tools.allow.toSorted() }),
          ...(spec.tools.deny === undefined ? {} : { disallowedTools: spec.tools.deny.toSorted() }),
        }),
    settingSources: spec.native?.sources ?? ["user", "project"],
    skills: spec.native?.skills ?? [],
    // Gana sobre los hooks de user y de project, pero no sobre los de este objeto `hooks`.
    settings: { disableAllHooks: !spec.hooks },
    hooks: { PreCompact: [{ hooks: [ctx.logCompaction] }] },
    outputFormat: { type: "json_schema", schema: forClaude(spec.outputSchema) },
    ...(spec.maxTurns === undefined ? {} : { maxTurns: spec.maxTurns }),
    ...(spec.maxBudgetUsd === undefined ? {} : { maxBudgetUsd: spec.maxBudgetUsd }),
    ...(ctx.resume === undefined ? {} : { resume: ctx.resume }),
    env: ctx.env,
    ...(ctx.executable === undefined ? {} : { pathToClaudeCodeExecutable: ctx.executable }),
    abortController: ctx.abort,
    ...(ctx.spawn === undefined ? {} : { spawnClaudeCodeProcess: ctx.spawn }),
  };
}

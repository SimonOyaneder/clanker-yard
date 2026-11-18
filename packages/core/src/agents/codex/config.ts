import { pickEnv } from "../../procs/env";
import { BadRequestError } from "../../errors/domain";
import type { RunSpec } from "../runtime";
import type { JsonValue } from "./api";

export const CODEX_CONFIG: Record<string, JsonValue> = {
  "features.plugins": false,
  "features.apps": false,
  "features.codex_hooks": false,
  notify: [],
  project_doc_max_bytes: 32768,
  "skills.include_instructions": false,
  "skills.bundled.enabled": false,
  "cloud.skills.enabled": false,
  web_search: "disabled",
  "memories.use_memories": false,
  "memories.generate_memories": false,
};

export const CODEX_ARGS = ["app-server", ...Object.entries(CODEX_CONFIG).flatMap(([key, value]) => ["-c", `${key}=${JSON.stringify(value)}`])];

export function codexEnv(baseEnv: Record<string, string | undefined>, git?: { ghConfigDir: string; gitConfig: string }): Record<string, string> {
  return {
    ...pickEnv(["PATH", "HOME", "USER", "LANG", "TMPDIR", "CODEX_HOME"], baseEnv),
    ...(git && { GH_CONFIG_DIR: git.ghConfigDir, GIT_CONFIG_GLOBAL: git.gitConfig, GIT_CONFIG_NOSYSTEM: "1" }),
  };
}

export function threadOptions(spec: RunSpec) {
  if (spec.tools !== "all" && (spec.tools.allow !== undefined || spec.tools.deny?.length)) {
    throw new BadRequestError("Codex no puede representar esta ToolPolicy sin cambiar sus permisos. Usa un rol con tools: \"all\" u otro runtime.");
  }
  return {
    cwd: spec.cwd,
    model: spec.model,
    approvalPolicy: "never" as const,
    sandbox: "danger-full-access" as const,
    developerInstructions: [spec.systemPrompt, ...spec.references.map((ref) => `# ${ref.label}\n${ref.content}`)].join("\n\n"),
  };
}

export function isolatedThreadConfig(config: Record<string, JsonValue>, overrides?: Record<string, JsonValue> | null): Record<string, JsonValue> {
  const servers = config.mcp_servers;
  const names = Object.keys(servers ?? {});
  return {
    ...Object.fromEntries(Object.entries(overrides ?? {}).filter(([key]) => key !== "mcp_servers" && !key.startsWith("mcp_servers."))),
    ...CODEX_CONFIG,
    mcp_servers: Object.fromEntries(names.map((name) => [name, { enabled: false }])),
  };
}

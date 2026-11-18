import { pickEnv } from "../../procs/env";
import type { JsonValue } from "./api";

export const CODEX_CONFIG: Record<string, JsonValue> = {
  "features.plugins": false,
  "features.apps": false,
  "features.codex_hooks": false,
  notify: [],
  project_doc_max_bytes: 0,
  "skills.include_instructions": false,
  "skills.bundled.enabled": false,
  "cloud.skills.enabled": false,
  web_search: "disabled",
  "memories.use_memories": false,
  "memories.generate_memories": false,
};

export const CODEX_ARGS = ["app-server", ...Object.entries(CODEX_CONFIG).flatMap(([key, value]) => ["-c", `${key}=${JSON.stringify(value)}`])];

export function codexEnv(baseEnv: Record<string, string | undefined>): Record<string, string> {
  return pickEnv(["PATH", "HOME", "USER", "LANG", "TMPDIR", "CODEX_HOME"], baseEnv);
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

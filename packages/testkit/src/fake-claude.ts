import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ClaudeOptions, QueryFn } from "@clanker/core";

type SDKMessage = ReturnType<QueryFn> extends AsyncIterable<infer M> ? M : never;

/** Cómo responde el Claude falso: listo, con el login vencido o con la cuota agotada. */
export type FakeClaudeScenario = "ready" | "login_expired" | "quota_exhausted";

export interface FakeClaudeOptions {
  /** Se pregunta en cada prueba, así un test o la demo pueden cambiarlo sin recrear nada. Default `ready`. */
  scenario?: () => FakeClaudeScenario;
  /** Uso de las barras de 5 h y 7 días, de 0 a 1. */
  usage?: { fiveHour: number; sevenDay: number };
}

export interface FakeClaude {
  /** Va en `createConnections({ store: ..., secrets: { claude: fake.options } })`: el core no llama a Claude real ni mira el `PATH` del usuario. */
  options: ClaudeOptions;
  cleanup(): void;
}

/** Un `claude` instalado (2.1.325, plan `max`) y un `query` que contesta como el SDK; sirve a `probeClaude`. */
export function createFakeClaude({ scenario = () => "ready", usage = { fiveHour: 0.15, sevenDay: 0.42 } }: FakeClaudeOptions = {}): FakeClaude {
  const dir = mkdtempSync(join(tmpdir(), "fake-claude-"));
  // Basta con que exista y sea ejecutable: `exec` y `query` reemplazan lo que haría el binario.
  writeFileSync(join(dir, "claude"), "#!/bin/sh\nexit 0\n");
  chmodSync(join(dir, "claude"), 0o755);

  // Los mensajes del SDK traen muchos campos que `probeClaude` no lee: aquí solo van los que importan.
  const message = (m: Record<string, unknown>) => ({ session_id: "fake", ...m }) as unknown as SDKMessage;
  const at = (hours: number) => Math.floor(Date.now() / 1000) + hours * 3600;

  const query: QueryFn = ({ options }) =>
    (async function* () {
      const apiKey = options.env?.ANTHROPIC_API_KEY;
      yield message({ type: "system", subtype: "init", apiKeySource: apiKey ? "ANTHROPIC_API_KEY" : "none", claude_code_version: "2.1.325" });
      const state = scenario();
      if (apiKey?.startsWith("sk-rechazada") || state === "login_expired") {
        yield message({ type: "assistant", error: "authentication_failed", message: { id: "m", content: [], usage: {} } });
        yield message({ type: "result", subtype: "success", is_error: true, result: "Failed to authenticate" });
        // Como el SDK real, lanza después de un `result` con error.
        throw new Error("Claude Code returned an error result");
      }
      if (!apiKey) {
        const exhausted = state === "quota_exhausted";
        yield message({
          type: "rate_limit_event",
          rate_limit_info: {
            status: exhausted ? "rejected" : "allowed",
            rateLimitType: "five_hour",
            utilization: exhausted ? 1 : usage.fiveHour,
            resetsAt: at(2),
            unifiedWindows: {
              five_hour: { utilization: exhausted ? 1 : usage.fiveHour, resetsAt: at(2) },
              seven_day: { utilization: usage.sevenDay, resetsAt: at(72) },
            },
          },
        });
        if (exhausted) {
          yield message({ type: "result", subtype: "success", is_error: true, result: "You've hit your 5-hour limit" });
          throw new Error("Claude Code returned an error result");
        }
      }
      yield message({ type: "result", subtype: "success", is_error: false, result: "pong" });
    })();

  const exec: NonNullable<ClaudeOptions["exec"]> = async (_file, args) =>
    args[0] === "--version" ? "2.1.325 (Claude Code)\n" : JSON.stringify({ loggedIn: true, authMethod: "claude.ai", subscriptionType: "max" });

  return {
    options: { baseEnv: { PATH: dir, HOME: dir }, query, exec },
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

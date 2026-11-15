import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { compileJsonSchema, type JsonSchema } from "@clanker/api";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { createClaudeRuntime } from "./claude-runtime";
import { subscriptionCredentials } from "./credentials";

// Llama a Claude de verdad con el login de quien corre el test y gasta cuota: solo con
// `CLANKER_LIVE_CLAUDE=1 npx vitest run packages/core/src/agents/claude/claude-live.test.ts`.
describe.skipIf(process.env.CLANKER_LIVE_CLAUDE !== "1")("claude-sdk en vivo", () => {
  let home: string;
  let cwd: string;
  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), "claude-live-home-"));
    cwd = await mkdtemp(join(tmpdir(), "claude-live-cwd-"));
  });
  afterEach(async () => {
    await rm(home, { recursive: true, force: true });
    await rm(cwd, { recursive: true, force: true });
  });

  const outputSchema: JsonSchema = {
    type: "object",
    properties: { outcome: { type: "string", enum: ["pong"] }, summary: { type: "string" } },
    required: ["outcome", "summary"],
    additionalProperties: false,
  };

  test("un rol mínimo devuelve un reporte válido con la suscripción", { timeout: 120_000 }, async () => {
    const credentials = subscriptionCredentials();
    expect(credentials.executable, "no hay `claude` en el PATH").toBeDefined();
    const runtime = createClaudeRuntime({ credentials, home });

    const run = await runtime.start({
      role: "live-smoke",
      cwd,
      systemPrompt: "Eres un agente de prueba. Responde siempre con el reporte pedido y nada más.",
      prompt: 'Devuelve el reporte con outcome "pong" y un summary de una frase.',
      model: "haiku",
      effort: "low",
      context: [{ kind: "native", sources: [], skills: [] }],
      hooks: false,
      tools: { allow: [] },
      outputSchema,
      maxTurns: 3,
      maxBudgetUsd: 0.05,
    });
    const result = await run.result;

    expect(result.status, result.message).toBe("success");
    expect(compileJsonSchema(outputSchema).safeParse(result.structured).success).toBe(true);
    expect(result.usage.turns).toBeGreaterThan(0);
    expect(result.usage.costSource).toBe("estimate");
  });
});

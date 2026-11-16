import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { compileJsonSchema, type JsonSchema } from "@clanker/api";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import type { AgentEvent, RunSpec } from "../runtime";
import { createOpencodeRuntime } from "./opencode-runtime";

// Llama a opencode 2 de verdad con los proveedores de quien corre el test: solo con
// `CLANKER_LIVE_OPENCODE=1 npx vitest run packages/core/src/agents/opencode/opencode-live.test.ts`.
// El modelo por defecto es uno gratis de opencode Zen; `CLANKER_LIVE_OPENCODE_MODEL` lo cambia.
describe.skipIf(process.env.CLANKER_LIVE_OPENCODE !== "1")("opencode en vivo", () => {
  const model = process.env.CLANKER_LIVE_OPENCODE_MODEL ?? "opencode/big-pickle";
  let home: string;
  let cwd: string;
  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), "opencode-live-home-"));
    cwd = await mkdtemp(join(tmpdir(), "opencode-live-cwd-"));
    execFileSync("git", ["init", "-q"], { cwd });
    for (const n of [1, 2, 3]) await writeFile(join(cwd, `f${n}.txt`), `el número secreto es ${n * 7}\n`);
  });
  afterEach(async () => {
    await rm(home, { recursive: true, force: true });
    await rm(cwd, { recursive: true, force: true });
  });

  const outputSchema: JsonSchema = {
    $schema: "https://json-schema.org/draft/2020-12/schema",
    type: "object",
    properties: {
      outcome: { type: "string", enum: ["done"] },
      summary: { type: "string" },
      payload: { type: "object", properties: { sum: { type: "number" } }, required: ["sum"], additionalProperties: false },
    },
    required: ["outcome", "summary", "payload"],
    additionalProperties: false,
  };

  const spec = (prompt: string): RunSpec => ({
    role: "live-smoke",
    cwd,
    systemPrompt: "Eres un agente de prueba. Trabaja con herramientas y entrega el reporte pedido.",
    prompt,
    model,
    effort: "high",
    native: { sources: [], skills: [] },
    references: [{ label: "repo:AGENTS.md", content: "Los archivos fN.txt tienen números secretos." }],
    hooks: false,
    tools: "all",
    outputSchema,
  });

  async function collect(events: AsyncIterable<AgentEvent>): Promise<AgentEvent[]> {
    const seen: AgentEvent[] = [];
    for await (const event of events) seen.push(event);
    return seen;
  }

  test("lee archivos con herramientas, entrega el reporte y se retoma en la misma sesión", { timeout: 300_000 }, async () => {
    const runtime = createOpencodeRuntime({ home });
    expect(await runtime.probe?.()).toBeUndefined();

    const run = await runtime.start(spec("Lee f1.txt, f2.txt y f3.txt con la herramienta read y reporta la suma de los números secretos."));
    const [events, result] = await Promise.all([collect(run.events), run.result]);

    expect(result.status, result.message).toBe("success");
    expect(compileJsonSchema(outputSchema).safeParse(result.structured).success).toBe(true);
    expect((result.structured as { payload: { sum: number } }).payload.sum).toBe(42);
    expect(events.some((e) => e.type === "first_token")).toBe(true);
    expect(events.filter((e) => e.type === "tool_start").map((e) => (e as { tool: string }).tool)).toEqual(expect.arrayContaining(["read", "clanker_report"]));
    // Un modelo sin la variante pedida corre con la suya y lo avisa, en vez de fallar (big-pickle no tiene ninguna).
    if (model === "opencode/big-pickle") expect(events.some((e) => e.type === "error" && e.message.includes('variante "high"'))).toBe(true);
    expect(result.usage.turns).toBeGreaterThan(0);
    const transcript = await readFile(join(home, "transcripts", `${run.ref.sessionId}.jsonl`), "utf8");
    expect(transcript).toContain('"kind":"tool_call"');

    const again = await runtime.resume(run.ref, "Ahora reporta la suma multiplicada por 2, sin volver a leer los archivos.", { outputSchema, references: [] });
    const [, second] = await Promise.all([collect(again.events), again.result]);
    expect(second.status, second.message).toBe("success");
    expect((second.structured as { payload: { sum: number } }).payload.sum).toBe(84);
    expect(again.ref.sessionId).toBe(run.ref.sessionId);
  });

  test("describe lista los modelos conectados", { timeout: 60_000 }, async () => {
    const options = await createOpencodeRuntime({ home }).describe!();
    expect(options.available, options.message).toBe(true);
    expect(options.models.map((m) => m.id)).toContain(model);
  });
});

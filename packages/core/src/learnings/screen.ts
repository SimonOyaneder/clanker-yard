import { tmpdir } from "node:os";
import { type Learning, type LearningVerdict, LearningVerdicts } from "@clanker/api";
import type { AgentRuntime } from "../agents/runtime";
import { LEARNING_CRITERIA } from "./criteria";
import { BadRequestError } from "../errors/domain";

/** El filtro con el criterio no pudo correr o no entregó un veredicto válido: no cambió nada. */
export class LearningScreenError extends BadRequestError {}

const SYSTEM_PROMPT = `Filtras learnings propuestos por agentes de código. Decides, uno por uno, si cumple el criterio. Solo juzgas el texto: no tienes acceso al repo.`;

const OUTPUT_SCHEMA = {
  type: "object",
  properties: {
    verdicts: {
      type: "array",
      items: {
        type: "object",
        properties: { id: { type: "string" }, keep: { type: "boolean" }, reason: { type: "string" } },
        required: ["id", "keep", "reason"],
        additionalProperties: false,
      },
    },
  },
  required: ["verdicts"],
  additionalProperties: false,
};

/**
 * Pide a un modelo barato un veredicto por cada learning contra `LEARNING_CRITERIA`. No cambia nada: quien
 * llama muestra la lista y archiva lo que una persona confirme. Un learning sin veredicto se conserva.
 */
export async function screenLearnings(runtime: AgentRuntime, candidates: Learning[]): Promise<LearningVerdict[]> {
  if (candidates.length === 0) return [];
  const list = candidates.map(({ id, text }) => ({ id, text }));
  const run = await runtime.start({
    role: "learnings-screen",
    cwd: tmpdir(),
    systemPrompt: SYSTEM_PROMPT,
    prompt: `${LEARNING_CRITERIA}\n\nPor cada learning devuelve \`keep: true\` si cumple las cuatro condiciones y \`false\` si no, con la razón en una frase (qué condición falla). Ante la duda, \`keep: true\`: archivar es lo que necesita confirmación.\n\n${JSON.stringify(list, null, 2)}`,
    model: "haiku",
    effort: "low",
    references: [],
    native: { sources: [], skills: [] },
    hooks: false,
    tools: { allow: [] },
    outputSchema: OUTPUT_SCHEMA,
    maxTurns: 5,
  });
  // Quien no consume los eventos puede dejar al runtime esperando.
  const drain = (async () => {
    for await (const event of run.events) void event;
  })();
  const [result] = await Promise.all([run.result, drain]);
  if (result.status !== "success") {
    throw new LearningScreenError(`No pude filtrar los learnings: ${result.message ?? `el runtime terminó con ${result.status}`}.`);
  }
  const parsed = LearningVerdicts.safeParse(result.structured);
  if (!parsed.success) throw new LearningScreenError("No pude filtrar los learnings: el agente no devolvió veredictos válidos.");
  const byId = new Map(parsed.data.verdicts.map((v) => [v.id, v]));
  return candidates.map(({ id }) => byId.get(id) ?? { id, keep: true, reason: "Sin veredicto: se conserva." });
}

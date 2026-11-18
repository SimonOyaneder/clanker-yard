import type { AgentRuntimeId } from "@clanker/api";
import type { AgentRuntime } from "@clanker/core";
import { createFakeRuntime, type FakeRuntimeOptions } from "./fake-runtime";

/** Lo que recibió un runtime: el prompt de un `start` o el mensaje de un `resume`. */
export interface ReceivedPrompt {
  runtime: string;
  kind: "start" | "resume";
  text: string;
}

/**
 * El runtime fake con el id de uno real (`claude-sdk`, `opencode`): sirve para probar lo que el core decide por
 * runtime (sesiones, handoff, breakers) sin `CORE_RUNTIME=fake`, que fuerza todo a uno. El fake firma sus sesiones
 * como `fake`, así que aquí se renombran: con dos instancias, sus ids chocarían. Sin `recipeResults`: la receta corre
 * de verdad.
 */
export function labeledFake(id: AgentRuntimeId, options: FakeRuntimeOptions, received?: ReceivedPrompt[]): AgentRuntime {
  const base = createFakeRuntime(options);
  return {
    ...base,
    id,
    start: async (spec) => {
      received?.push({ runtime: id, kind: "start", text: spec.prompt });
      const run = await base.start(spec);
      return { ...run, ref: { ...run.ref, runtime: id, sessionId: `${id}:${run.ref.sessionId}` } };
    },
    resume: async (ref, message, spec) => {
      received?.push({ runtime: id, kind: "resume", text: message });
      const run = await base.resume({ ...ref, runtime: "fake", sessionId: ref.sessionId.slice(id.length + 1) }, message, spec);
      return { ...run, ref: { ...run.ref, runtime: id, sessionId: ref.sessionId } };
    },
  };
}

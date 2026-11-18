import { AgentRuntimeId, type AgentOptions, type RuntimeOptions } from "@clanker/api";
import { CLAUDE_OPTIONS, CLAUDE_RUNTIME_ID } from "./claude/models";
import { messageOf } from "../errors/format";
import type { RuntimeRegistry } from "./runtime";

/** Lo que se ofrece de un runtime que este core no registró: el de Claude conserva su lista fija para editar perfiles. */
function unregistered(id: AgentRuntimeId): RuntimeOptions {
  const message = `Este core no tiene el runtime ${id}.`;
  if (id === CLAUDE_RUNTIME_ID) return { ...CLAUDE_OPTIONS, available: false, message };
  if (id === "codex") return { id, label: "Codex", about: "Codex con el login del binario instalado.", available: false, message, models: [], efforts: [] };
  return {
    id,
    label: "opencode",
    about: "opencode con los proveedores que tengas conectados (opencode auth login).",
    available: false,
    message,
    models: [],
    efforts: CLAUDE_OPTIONS.efforts,
  };
}

/**
 * `defs.agentOptions`: un runtime por cada `AgentRuntimeId`, en ese orden. Un `describe` que falla no tumba la lista:
 * ese runtime sale no disponible con el motivo.
 */
export async function describeRuntimes(registry: Pick<RuntimeRegistry, "all">): Promise<AgentOptions> {
  const runtimes = await Promise.all(
    AgentRuntimeId.options.map(async (id): Promise<RuntimeOptions> => {
      const runtime = registry.all.find((r) => r.id === id);
      if (!runtime?.describe) return unregistered(id);
      try {
        return await runtime.describe();
      } catch (error) {
        return { ...unregistered(id), message: `No pude leer las opciones de ${id}: ${messageOf(error)}` };
      }
    }),
  );
  return { runtimes };
}

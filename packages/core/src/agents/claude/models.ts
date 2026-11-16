import type { RuntimeOptions } from "@clanker/api";

/**
 * Lo que el runtime de Claude acepta en un perfil: alias de modelo (los resuelve Claude Code a su versión
 * vigente) y los niveles de esfuerzo del SDK. De menos a más potente, que es el orden en que la UI los ofrece.
 */
export const CLAUDE_OPTIONS: RuntimeOptions = {
  id: "claude-sdk",
  label: "Claude Code",
  about: "Claude Code con tu suscripción o API key (Conexiones > Claude). Los modelos son alias que Claude Code resuelve a su versión vigente.",
  available: true,
  defaultModel: "sonnet",
  models: [
    { id: "haiku", label: "Haiku", about: "El más rápido y barato; para tareas simples y revisiones livianas." },
    { id: "sonnet", label: "Sonnet", about: "Equilibrado: buena calidad a costo medio." },
    { id: "opus", label: "Opus", about: "Más potente y más caro; para el trabajo difícil." },
    { id: "fable", label: "Fable", about: "El más potente y el más caro; para lo que nada más resuelve." },
  ],
  efforts: [
    { id: "low", about: "Responde casi sin pensar: rápido y barato." },
    { id: "medium", about: "Piensa lo justo." },
    { id: "high", about: "Piensa a fondo: el punto de partida habitual." },
    { id: "xhigh", about: "Piensa más que high: más lento y caro." },
    { id: "max", about: "Sin límite de razonamiento: el más lento y caro." },
  ],
};

import path from "node:path";
import type { NavTarget, Theme } from "@clanker/ui";

// Lo que `host-ipc.ts` valida de cada payload que manda la ventana, sin Electron para poder probarlo: la UI no es de confianza.

const THEMES: readonly Theme[] = ["system", "light", "dark"];

/** Un destino de navegación bien formado: una decisión (`decisionId`) o un proyecto (`slug`, y opcionalmente `issueId`). */
export function isTarget(v: unknown): v is NavTarget {
  if (typeof v !== "object" || v === null) return false;
  const t = v as Record<string, unknown>;
  if ("decisionId" in t) return typeof t.decisionId === "string";
  return typeof t.slug === "string" && (t.issueId === undefined || typeof t.issueId === "string");
}

/** La URL que se puede abrir en el navegador: solo `https:` (nada de `file:`, `javascript:` ni `http:`); si no, `undefined`. */
export function safeExternalUrl(raw: unknown): string | undefined {
  if (typeof raw !== "string") return undefined;
  try {
    const url = new URL(raw);
    return url.protocol === "https:" ? url.toString() : undefined;
  } catch {
    return undefined;
  }
}

/** La ruta que se abre en el editor: solo una absoluta; si no, `undefined`. */
export function editorTarget(raw: unknown): string | undefined {
  return typeof raw === "string" && path.isAbsolute(raw) ? raw : undefined;
}

export const isTheme = (v: unknown): v is Theme => THEMES.includes(v as Theme);

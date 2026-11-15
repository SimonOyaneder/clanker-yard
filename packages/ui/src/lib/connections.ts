import type { ClaudeState, ClaudeStatus, Connection, ConnectionProvider } from "@clanker/api"
import { tone } from "@/lib/format"

const DAY_MS = 86_400_000

export interface ChipLook {
  label: string
  tone: string
  hint: string
}

/** La conexión de un proveedor que la UI muestra: la de Claude con API key manda sobre la suscripción, como en el core. */
export function connectionOf(connections: Connection[], provider: ConnectionProvider): Connection | undefined {
  const mine = connections.filter((c) => c.provider === provider)
  return (provider === "claude" ? mine.find((c) => c.account === "api-key") : undefined) ?? mine[0]
}

export function statusLook(connection: Connection | undefined): ChipLook {
  if (!connection) return { label: "sin configurar", tone: tone.neutral, hint: "Todavía no hay una cuenta conectada." }
  switch (connection.status) {
    case "expired":
      return { label: "vencida", tone: tone.red, hint: "El token venció. Lo que dependa de esta cuenta espera hasta que la reconectes." }
    case "revoked":
      return { label: "revocada", tone: tone.red, hint: "El proveedor rechazó el token (lo revocaron o ya no vale). Reconecta la cuenta." }
    case "active":
      return connection.expiresSoon
        ? { label: "por vencer", tone: tone.amber, hint: "El token vence pronto: rótalo antes de que las corridas se queden esperando." }
        : { label: "conectada", tone: tone.green, hint: "El token es válido." }
  }
}

/**
 * "vence en 12 d" o "vence hoy" mientras sirve; "venció el 20 dic" si el core ya la marcó vencida (la fecha, no
 * los días: el reloj del core manda y puede no coincidir con el de la ventana). `null` si el token no vence o fue revocado.
 */
export function expiryLabel(connection: Connection | undefined, now = Date.now()): string | null {
  if (connection?.expiresAt === undefined || connection.status === "revoked") return null
  if (connection.status === "expired") return `venció el ${new Date(connection.expiresAt).toLocaleDateString("es-CL", { day: "numeric", month: "short" }).replace(".", "")}`
  const days = Math.floor(Math.max(0, connection.expiresAt - now) / DAY_MS)
  return days === 0 ? "vence hoy" : `vence en ${days} d`
}

const CLAUDE: Record<ClaudeState, { label: string; tone: string; hint: string; down: boolean }> = {
  ready: { label: "lista", tone: tone.green, hint: "Claude respondió a la llamada de prueba.", down: false },
  not_installed: { label: "no instalado", tone: tone.red, hint: "No encuentro Claude Code en el PATH.", down: true },
  outdated: { label: "versión antigua", tone: tone.amber, hint: "El Claude Code instalado es anterior a la versión mínima.", down: false },
  login_required: { label: "sin sesión", tone: tone.red, hint: "Claude Code no tiene una sesión iniciada.", down: true },
  login_expired: { label: "sesión vencida", tone: tone.red, hint: "El login de Claude venció: hay que iniciar sesión de nuevo.", down: true },
  key_rejected: { label: "key rechazada", tone: tone.red, hint: "Anthropic rechazó la API key guardada.", down: true },
  quota_exhausted: { label: "cuota agotada", tone: tone.amber, hint: "Se agotó la cuota del plan; los pasos de agente esperan a que se renueve.", down: false },
  error: { label: "con error", tone: tone.amber, hint: "La prueba falló por algo que no es el login ni la cuota; el detalle está en la tarjeta.", down: false },
}

/** El chip de Claude: lo último que dijo una prueba manda; sin prueba, lo que sabe la base. */
export function claudeLook(connection: Connection | undefined, status: ClaudeStatus | null): ChipLook {
  if (status) return CLAUDE[status.state]
  return statusLook(connection)
}

/** `true` si algo está vencido o caído: lo que enciende el punto rojo de Conexiones en la barra lateral. */
export function needsAttention(connections: Connection[], claude: ClaudeStatus | null): boolean {
  return connections.some((c) => c.status !== "active") || (claude !== null && CLAUDE[claude.state].down)
}

/** Porcentaje entero de 0 a 100 de una ventana de uso (`utilization` va de 0 a 1 y puede pasarse de 1). */
export const usagePercent = (utilization: number) => Math.min(100, Math.max(0, Math.round(utilization * 100)))

export type UsageTone = "ok" | "warn" | "danger"
export const usageTone = (percent: number): UsageTone => (percent >= 90 ? "danger" : percent >= 70 ? "warn" : "ok")

/** "1:23" para lo que falta hasta que se renueve la ventana de 5 h; `null` si ya pasó o no se sabe. */
export function untilReset(resetsAt: number | undefined, now = Date.now()): string | null {
  if (resetsAt === undefined || resetsAt <= now) return null
  const minutes = Math.round((resetsAt - now) / 60_000)
  return `${Math.floor(minutes / 60)}:${String(minutes % 60).padStart(2, "0")}`
}

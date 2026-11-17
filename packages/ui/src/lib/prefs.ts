// Preferencias de la vista que sobreviven a cerrar la app. localStorage puede fallar: nunca rompe.

const PREFIX = "clanker."
/** Las que guardó la UI de Clanker Control, de donde viene esta: se leen una vez y se pasan a `PREFIX`. */
const LEGACY_PREFIX = "cc."

export function readPref<T>(key: string, fallback: T): T {
  try {
    let raw = localStorage.getItem(`${PREFIX}${key}`)
    if (raw === null) {
      raw = localStorage.getItem(`${LEGACY_PREFIX}${key}`)
      if (raw !== null) {
        localStorage.setItem(`${PREFIX}${key}`, raw)
        localStorage.removeItem(`${LEGACY_PREFIX}${key}`)
      }
    }
    return raw === null ? fallback : (JSON.parse(raw) as T)
  } catch {
    return fallback
  }
}

export function writePref(key: string, value: unknown): void {
  try {
    localStorage.setItem(`${PREFIX}${key}`, JSON.stringify(value))
  } catch {
    // sin storage: la preferencia dura hasta cerrar la app
  }
}

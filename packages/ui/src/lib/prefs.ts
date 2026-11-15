// Preferencias de la vista que sobreviven a cerrar la app. localStorage puede fallar: nunca rompe.
export function readPref<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(`cc.${key}`)
    return raw === null ? fallback : (JSON.parse(raw) as T)
  } catch {
    return fallback
  }
}

export function writePref(key: string, value: unknown): void {
  try {
    localStorage.setItem(`cc.${key}`, JSON.stringify(value))
  } catch {
    // sin storage: la preferencia dura hasta cerrar la app
  }
}

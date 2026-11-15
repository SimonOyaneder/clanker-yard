type When = string | number

const toMs = (when: When) => (typeof when === "number" ? when : Date.parse(when))

// Los costos del core son micros de USD. Bajo $1 muestra los decimales que hagan falta (un paso de
// $0.0125 no puede verse como $0.01).
export function costUsd(micros: number): string {
  if (micros === 0) return "$0"
  const dollars = micros / 1_000_000
  if (dollars >= 1) return `$${dollars.toFixed(2)}`
  return `$${dollars.toFixed(4).replace(/0{1,2}$/, "")}`
}

export function ago(when: When | null | undefined, now = Date.now()): string {
  if (when === null || when === undefined) return ""
  const s = Math.max(0, Math.round((now - toMs(when)) / 1000))
  if (s < 60) return `hace ${s} s`
  const m = Math.round(s / 60)
  if (m < 60) return `hace ${m} min`
  const h = Math.round(m / 60)
  if (h < 48) return `hace ${h} h`
  return `hace ${Math.round(h / 24)} d`
}

// "2 min 05 s", "48 s", "1 h 03 min".
export function elapsed(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000))
  if (s < 60) return `${s} s`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m} min ${String(s % 60).padStart(2, "0")} s`
  return `${Math.floor(m / 60)} h ${String(m % 60).padStart(2, "0")} min`
}

// ─── Tonos: violeta = trabajando, verde = listo, ámbar = te espera, rojo = falló ───
// Cada uno con su variante clara y oscura; el texto nunca usa el color puro sobre fondo blanco.

export const tone = {
  violet: "bg-violet-500/12 text-violet-700 dark:bg-violet-400/15 dark:text-violet-300",
  green: "bg-emerald-500/12 text-emerald-700 dark:bg-emerald-400/12 dark:text-emerald-300",
  amber: "bg-amber-500/15 text-amber-800 dark:bg-amber-400/12 dark:text-amber-300",
  red: "bg-red-500/12 text-red-700 dark:bg-red-400/12 dark:text-red-300",
  sky: "bg-sky-500/12 text-sky-700 dark:bg-sky-400/12 dark:text-sky-300",
  neutral: "bg-muted text-muted-foreground",
} as const

export function absolute(when: When | null | undefined): string {
  if (when === null || when === undefined) return ""
  return new Date(toMs(when)).toLocaleString("es-CL", { dateStyle: "medium", timeStyle: "short", hour12: false })
}

// La clave que ve la gente. El tracker local llama a sus issues `<ID DEL PROYECTO>-<n>`: solo el número dice algo.
export function issueKey(issue: { ref: { tracker: string; key: string } }): string {
  return issue.ref.tracker === "local" ? `#${issue.ref.key.split("-").pop()}` : issue.ref.key
}

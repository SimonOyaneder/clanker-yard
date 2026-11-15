import type { FeedKind, LoopStatus, MemberStatus } from "@/types"

export function usd(n: number | null | undefined): string {
  if (n === null || n === undefined) return "—"
  return `$${n.toFixed(2)}`
}

export function tokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)} M`
  if (n >= 1_000) return `${Math.round(n / 1_000)} k`
  return String(n)
}

export function ago(iso: string | null | undefined, now = Date.now()): string {
  if (!iso) return ""
  const s = Math.max(0, Math.round((now - Date.parse(iso)) / 1000))
  if (s < 60) return `hace ${s} s`
  const m = Math.round(s / 60)
  if (m < 60) return `hace ${m} min`
  const h = Math.round(m / 60)
  if (h < 48) return `hace ${h} h`
  return `hace ${Math.round(h / 24)} d`
}

export function clock(iso: string): string {
  const d = new Date(iso)
  const today = new Date()
  const hm = d.toLocaleTimeString("es-CL", { hour: "2-digit", minute: "2-digit", hour12: false })
  if (d.toDateString() === today.toDateString()) return hm
  return `${d.toLocaleDateString("es-CL", { day: "numeric", month: "short" })} ${hm}`
}

export function clockSeconds(iso: string): string {
  return new Date(iso).toLocaleTimeString("es-CL", { hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false })
}

export function issueIdOf(raw: string): string {
  return /^[A-Z]+-\d+(@\w+)?/.exec(raw)?.[0] ?? raw
}

export function linearIssueUrl(projectUrl: string | null, issueId: string): string | null {
  const ws = projectUrl ? /linear\.app\/([^/]+)\//.exec(projectUrl)?.[1] : null
  return ws ? `https://linear.app/${ws}/issue/${issueIdOf(issueId)}` : null
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

export const memberTone: Record<MemberStatus, { chip: string; card: string; pulse: boolean }> = {
  trabajando: { chip: tone.violet, card: "border-violet-500/40 dark:border-violet-400/35", pulse: true },
  esperando: { chip: tone.amber, card: "border-border", pulse: false },
  listo: { chip: tone.green, card: "border-border", pulse: false },
  "en cola": { chip: tone.neutral, card: "border-border", pulse: false },
  "sin señal": { chip: tone.red, card: "border-red-500/30", pulse: false },
}

export const loopTone: Record<LoopStatus, { dot: string; label: string }> = {
  activo: { dot: "bg-emerald-500", label: "activo" },
  vigilando: { dot: "bg-sky-500", label: "vigilando PRs" },
  dormido: { dot: "bg-amber-500", label: "dormido" },
  terminado: { dot: "bg-neutral-400 dark:bg-neutral-600", label: "terminado" },
}

export const feedTone: Record<FeedKind, string> = {
  lanzó: tone.violet,
  listo: tone.green,
  aviso: tone.amber,
  falló: tone.red,
  restack: tone.sky,
  merge: tone.green,
  cola: tone.neutral,
  evento: tone.sky,
}

export const feedHint: Record<FeedKind, string> = {
  lanzó: "El EM lanzó un techlead para una issue (▶)",
  listo: "Un slot terminó su issue y dejó el PR (✅)",
  aviso: "Algo que el EM quiere que mires (⚠️)",
  falló: "Un slot o un paso falló (❌)",
  restack: "El EM rebaseó los PRs que iban encima de uno mergeado o reescrito (🔁)",
  merge: "El EM comentó /merge, o el vigilante lo habilitó solo (🤖)",
  cola: "El EM actualizó la cola de issues pendientes",
  evento: "Evento del vigilante de PRs: review, comentario, CI de merge-queue o merge",
}

export function absolute(iso: string | null | undefined): string {
  if (!iso) return ""
  return new Date(iso).toLocaleString("es-CL", { dateStyle: "medium", timeStyle: "short", hour12: false })
}

export const ROLE_ABBR: Record<string, string> = {
  techlead: "TL",
  dev: "DV",
  "dev-escala": "DX",
  "review-bugs": "RB",
  "review-tests": "RT",
  "review-patterns": "RP",
  "review-lore": "RL",
  committer: "CM",
  "bot-reviewer": "FR",
}

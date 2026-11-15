import { Bot, Check, CheckCircle2, Circle, CircleDot, Clock, GitMerge, GitPullRequest, GitPullRequestDraft, MessageSquare, MessagesSquare, Shield, ShieldAlert, ShieldCheck, X, XCircle } from "lucide-react"
import type { CIStatus, PRRisk, PullRequest, ReviewerState } from "@/types"
import { tone } from "@/lib/format"
import { type ReviewStatus, reviewTone } from "@/lib/pr-status"
import { cn } from "@/lib/utils"
import { Hint, Pill } from "../common"

// Piezas compartidas entre la tarjeta del grafo y la fila de la lista.

export function PRStateIcon({ pr, className }: { pr: PullRequest; className?: string }) {
  const Icon = pr.isDraft ? GitPullRequestDraft : GitPullRequest
  return (
    <Hint label={pr.isDraft ? "Draft: todavía no está listo para review" : "Abierto y listo para review"}>
      <Icon
        aria-label={pr.isDraft ? "Draft" : "Abierto"}
        className={cn("size-3.5 flex-none", pr.isDraft ? "text-muted-foreground" : "text-emerald-600 dark:text-emerald-400", className)}
      />
    </Hint>
  )
}

const CI: Record<CIStatus, { Icon: typeof Circle; className: string; label: string; hint: string }> = {
  success: { Icon: CheckCircle2, className: "text-emerald-600 dark:text-emerald-400", label: "CI verde", hint: "Todos los checks del último commit pasaron" },
  failure: { Icon: XCircle, className: "text-red-600 dark:text-red-400", label: "CI rojo", hint: "Algún check del último commit falló (puede ser merge-queue)" },
  pending: { Icon: CircleDot, className: "cc-blink text-amber-600 dark:text-amber-400", label: "CI corriendo", hint: "Hay checks del último commit corriendo o por partir" },
  neutral: { Icon: Circle, className: "text-muted-foreground", label: "CI neutro", hint: "Los checks terminaron en neutral: ni pasaron ni fallaron" },
  skipped: { Icon: Circle, className: "text-muted-foreground", label: "CI saltado", hint: "Los checks se saltaron para este commit" },
  unknown: { Icon: Circle, className: "text-muted-foreground/60", label: "Sin checks", hint: "El último commit no tiene checks" },
}

export function CIBadge({ status, compact = false }: { status: CIStatus; compact?: boolean }) {
  const c = CI[status]
  return (
    <Hint label={`${c.label}: ${c.hint}`}>
      <span className="inline-flex items-center gap-1 text-[11px] text-muted-foreground">
        <c.Icon aria-label={c.label} className={cn("size-3.5", c.className)} />
        {compact ? null : c.label}
      </span>
    </Hint>
  )
}

const REVIEWER: Record<ReviewerState["state"], { Icon: typeof Check; className: string; label: string }> = {
  approved: { Icon: Check, className: "bg-emerald-500 text-white", label: "aprobó" },
  changes_requested: { Icon: X, className: "bg-red-500 text-white", label: "pidió cambios" },
  commented: { Icon: MessageSquare, className: "bg-sky-500 text-white", label: "comentó" },
  pending: { Icon: Clock, className: "bg-amber-500 text-white", label: "tiene la review pendiente: se la pidieron y todavía no la hace" },
}

// Avatar del revisor con su estado en una esquina, como en GitHub.
export function Reviewer({ r, size = 18 }: { r: ReviewerState; size?: number }) {
  const s = REVIEWER[r.state]
  return (
    <Hint label={`${r.login} ${s.label}`}>
    <span className="relative inline-flex flex-none" style={{ width: size, height: size }}>
      {r.avatarUrl ? (
        <img src={`${r.avatarUrl}${r.avatarUrl.includes("?") ? "&" : "?"}s=48`} alt={r.login} className="size-full rounded-full bg-muted" loading="lazy" />
      ) : (
        <span className="grid size-full place-items-center rounded-full bg-muted text-[9px] font-semibold uppercase">{r.login.slice(0, 2)}</span>
      )}
      <span className={cn("absolute -right-1 -bottom-1 grid size-3 place-items-center rounded-full ring-2 ring-card", s.className)}>
        <s.Icon className="size-2" strokeWidth={3} />
      </span>
    </span>
    </Hint>
  )
}

export function ReviewSignals({ pr }: { pr: PullRequest }) {
  return (
    <span className="flex flex-wrap items-center gap-1">
      {pr.botReview === "approved" ? (
        <Pill className={tone.green} hint="review-bot[bot] aprobó el PR: su review automática no dejó nada bloqueante">
          <Bot className="size-3" /> LGTM
        </Pill>
      ) : pr.botReview ? (
        <Pill className={tone.sky} hint="review-bot[bot] revisó y dejó comentarios, sin aprobar. Revisa sus threads">
          <Bot className="size-3" /> bot
        </Pill>
      ) : null}
      {pr.unresolvedThreads ? (
        <Pill
          className={tone.red}
          hint={`${pr.unresolvedThreads === 1 ? "1 hilo" : `${pr.unresolvedThreads} hilos`} de review sin resolver (de humanos o del bot). Los de humanos bloquean el merge`}
        >
          <MessagesSquare className="size-3" /> {pr.unresolvedThreads}
        </Pill>
      ) : null}
      {pr.comments ? (
        <Pill className={tone.neutral} hint={`${pr.comments === 1 ? "1 comentario" : `${pr.comments} comentarios`} en la conversación del PR (sin contar los hilos de review)`}>
          <MessageSquare className="size-3" /> {pr.comments}
        </Pill>
      ) : null}
    </span>
  )
}

export const RISK: Record<PRRisk, { label: string; short: string; hint: string; Icon: typeof Shield; className: string; dot: string }> = {
  high: {
    label: "Riesgo alto",
    hint: "Label risk:high que pone el bot de review. Es un cambio delicado: revísalo con calma antes de mergear",
    short: "Alto",
    Icon: ShieldAlert,
    className: "bg-red-500/15 text-red-700 ring-1 ring-red-500/30 dark:bg-red-400/15 dark:text-red-300",
    dot: "bg-red-500",
  },
  mid: {
    label: "Riesgo medio",
    hint: "Label risk:mid que pone el bot de review. Merece una revisada normal",
    short: "Medio",
    Icon: Shield,
    className: "bg-amber-500/15 text-amber-800 ring-1 ring-amber-500/30 dark:bg-amber-400/15 dark:text-amber-300",
    dot: "bg-amber-500",
  },
  low: {
    label: "Riesgo bajo",
    hint: "Label risk:low que pone el bot de review. Cambio acotado y de bajo impacto",
    short: "Bajo",
    Icon: ShieldCheck,
    className: "bg-emerald-500/12 text-emerald-700 ring-1 ring-emerald-500/25 dark:bg-emerald-400/12 dark:text-emerald-300",
    dot: "bg-emerald-500",
  },
}

// El risk del bot de review va siempre visible y con su color: es lo primero que se mira de un PR.
export function RiskBadge({ risk, className }: { risk: PRRisk | null; className?: string }) {
  if (!risk) {
    return (
      <Pill className={cn("text-muted-foreground ring-1 ring-border", className)} hint="Sin label risk: el bot de review la pone cuando el PR pasa por /review">
        <Shield className="size-3" /> Sin riesgo
      </Pill>
    )
  }
  const r = RISK[risk]
  return (
    <Pill className={cn("font-semibold", r.className, className)} hint={r.hint}>
      <r.Icon className="size-3" /> {r.label}
    </Pill>
  )
}

const isRiskLabel = (name: string) => /^risk[:/ _-]?(high|mid|medium|low)$/i.test(name.trim())

export function Labels({ pr, max = 3 }: { pr: PullRequest; max?: number }) {
  const labels = pr.labels.filter((l) => !isRiskLabel(l.name))
  if (!labels.length) return null
  const shown = labels.slice(0, max)
  const rest = labels.length - shown.length
  return (
    <span className="flex flex-wrap items-center gap-1">
      {shown.map((l) => (
        <Hint key={l.name} label={l.description ? `${l.name}: ${l.description}` : `Label de GitHub ${l.name} (sin descripción en el repo)`}>
          <span className="inline-flex h-5 max-w-[130px] items-center gap-1 rounded-full border px-1.5 text-[10.5px]">
            <span className="size-1.5 flex-none rounded-full" style={{ backgroundColor: `#${l.color}` }} />
            <span className="truncate">{l.name}</span>
          </span>
        </Hint>
      ))}
      {rest > 0 ? (
        <Hint label={labels.slice(max).map((l) => l.name).join(", ")}>
          <span className="text-[10.5px] text-muted-foreground">+{rest}</span>
        </Hint>
      ) : null}
    </span>
  )
}

export { copy } from "@/lib/clipboard"

// Merge: verde = puedes comentar `/merge` y pasa; violeta = ya está en merge-queue; rojo = merge-queue falló.
export function mergeRing(pr: PullRequest): string | null {
  if (pr.merge.finMerge === "failed") return "ring-2 ring-red-500"
  if (pr.merge.finMerge === "queued") return "ring-2 ring-violet-500/70"
  if (pr.merge.ready) return "ring-2 ring-emerald-500"
  return null
}

export function MergePill({ pr }: { pr: PullRequest }) {
  if (pr.merge.finMerge === "failed")
    return (
      <Pill className={tone.red} hint="Comentaste /merge pero el check de merge-queue falló. Revisa por qué en GitHub y vuelve a comentar /merge">
        merge-queue falló
      </Pill>
    )
  if (pr.merge.finMerge === "queued")
    return (
      <Pill className={tone.violet} hint="Ya comentaste /merge: merge-queue está corriendo el CI final para mergearlo">
        <span className="cc-blink size-1.5 rounded-full bg-current" /> En merge-queue
      </Pill>
    )
  if (pr.merge.ready)
    return (
      <Pill
        className={tone.green}
        hint="Aprobado, CI verde (sin contar merge-queue), sin hilos de humanos sin resolver, sin conflictos y sobre la branch principal. Comenta /merge y merge-queue lo mergea"
      >
        <GitMerge className="size-3" /> Listo para merge
      </Pill>
    )
  return null
}

export function mergeHint(pr: PullRequest): string | undefined {
  if (pr.merge.ready || pr.merge.finMerge || !pr.merge.blockers.length) return undefined
  return `Para mergear falta: ${pr.merge.blockers.join(", ")}`
}

const REVIEW_HINT: Record<ReviewStatus, string> = {
  changes: "Pidieron cambios, o hay comentarios o hilos sin resolver: la pelota está de tu lado",
  pending: "Hay revisores asignados que todavía no hacen su review",
  approved: "Tiene aprobación de review",
  none: "Nadie lo ha revisado ni tiene revisores asignados",
}

// Estado de review del PR, con lo que falta para mergear en el tooltip.
export function ReviewPill({ pr, review }: { pr: PullRequest; review: ReviewStatus }) {
  const t = reviewTone[review]
  const blockers = mergeHint(pr)
  return (
    <Pill className={t.pill} hint={blockers ? `${REVIEW_HINT[review]}. ${blockers}` : REVIEW_HINT[review]}>
      {t.label}
    </Pill>
  )
}

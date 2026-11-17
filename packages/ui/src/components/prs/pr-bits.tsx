import type { PrSignal, PrState, ReviewerState } from "@clanker/api"
import { useState } from "react"
import { Bot, Check, CheckCircle2, Circle, CircleAlert, CircleCheck, CircleDot, Clock, GitMerge, GitPullRequest, GitPullRequestDraft, Layers, MessageSquare, MessagesSquare, PauseCircle, TriangleAlert, X, XCircle } from "lucide-react"
import { tone } from "@/lib/format"
import { mergeMark, type ReviewStatus, reviewTone } from "@/lib/pr-status"
import { isDraft, type OpenPr } from "@/lib/prs"
import { cn } from "@/lib/utils"
import { Hint, Pill } from "../common"

// Piezas compartidas entre la tarjeta del grafo y la fila de la lista.

export function PrStateIcon({ pr, className }: { pr: OpenPr; className?: string }) {
  const draft = isDraft(pr)
  const Icon = draft ? GitPullRequestDraft : GitPullRequest
  return (
    <Hint label={draft ? "Draft: todavía no está listo para review" : "Abierto y listo para review"}>
      <Icon
        aria-label={draft ? "Draft" : "Abierto"}
        className={cn("size-3.5 flex-none", draft ? "text-muted-foreground" : "text-emerald-600 dark:text-emerald-400", className)}
      />
    </Hint>
  )
}

type CiState = PrState["ci"]["state"]

const CI: Record<CiState, { Icon: typeof Circle; className: string; label: string; hint: string }> = {
  green: { Icon: CheckCircle2, className: "text-emerald-600 dark:text-emerald-400", label: "CI verde", hint: "Todos los checks que cuentan del último commit pasaron" },
  red: { Icon: XCircle, className: "text-red-600 dark:text-red-400", label: "CI rojo", hint: "Algún check que cuenta del último commit falló" },
  pending: { Icon: CircleDot, className: "animate-blink text-amber-600 dark:text-amber-400", label: "CI corriendo", hint: "Hay checks del último commit corriendo o por partir" },
  none: { Icon: Circle, className: "text-muted-foreground/60", label: "Sin checks", hint: "El último commit no tiene checks que cuenten" },
}

export function CiBadge({ ci, compact = false }: { ci: PrState["ci"]; compact?: boolean }) {
  const c = CI[ci.state]
  const failing = ci.state === "red" && ci.failing.length ? `. En rojo: ${ci.failing.join(", ")}${ci.flaky.length ? ` (flaky conocidos: ${ci.flaky.join(", ")})` : ""}` : ""
  return (
    <Hint label={`${c.label}: ${c.hint}${failing}`}>
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

// Avatar del revisor con su estado en una esquina, como en GitHub. Sin imagen (o si no carga) van sus iniciales.
export function Reviewer({ r, size = 18 }: { r: ReviewerState; size?: number }) {
  const s = REVIEWER[r.state]
  const [broken, setBroken] = useState(false)
  return (
    <Hint label={`${r.login} ${s.label}`}>
      <span className="relative inline-flex flex-none" style={{ width: size, height: size }}>
        {r.avatarUrl && !broken ? (
          <img
            src={`${r.avatarUrl}${r.avatarUrl.includes("?") ? "&" : "?"}s=48`}
            alt={r.login}
            className="size-full rounded-full bg-muted"
            loading="lazy"
            onError={() => setBroken(true)}
          />
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

export function ReviewSignals({ pr }: { pr: OpenPr }) {
  const { bot, threads, comments } = pr.state
  return (
    <span className="flex flex-wrap items-center gap-1">
      {bot.state === "lgtm" ? (
        <Pill className={tone.green} hint="El bot de review aprobó el head actual del PR: su review automática no dejó nada bloqueante">
          <Bot className="size-3" /> LGTM
        </Pill>
      ) : bot.state === "findings" ? (
        <Pill className={tone.sky} hint={`El bot de review revisó y dejó ${bot.findings.length === 1 ? "1 hallazgo" : `${bot.findings.length} hallazgos`}, sin aprobar. Revisa sus threads`}>
          <Bot className="size-3" /> bot
        </Pill>
      ) : null}
      {threads.unresolved ? (
        <Pill
          className={tone.red}
          hint={`${threads.unresolved === 1 ? "1 hilo" : `${threads.unresolved} hilos`} de review sin resolver (de humanos, del bot o del council). Los de humanos bloquean el merge`}
        >
          <MessagesSquare className="size-3" /> {threads.unresolved}
        </Pill>
      ) : null}
      {comments ? (
        <Pill className={tone.neutral} hint={`${comments === 1 ? "1 comentario" : `${comments} comentarios`} en la conversación del PR (sin contar los hilos de review)`}>
          <MessageSquare className="size-3" /> {comments}
        </Pill>
      ) : null}
    </span>
  )
}

// Cómo se pinta el nivel de una señal del pack: tono, ícono y color. Qué dice cada nivel lo decide el pack.
export const SIGNAL_TONE: Record<"ok" | "warn" | "bad", { Icon: typeof Circle; className: string; dot: string }> = {
  bad: {
    Icon: TriangleAlert,
    className: "bg-red-500/15 text-red-700 ring-1 ring-red-500/30 dark:bg-red-400/15 dark:text-red-300",
    dot: "bg-red-500",
  },
  warn: {
    Icon: CircleAlert,
    className: "bg-amber-500/15 text-amber-800 ring-1 ring-amber-500/30 dark:bg-amber-400/15 dark:text-amber-300",
    dot: "bg-amber-500",
  },
  ok: {
    Icon: CircleCheck,
    className: "bg-emerald-500/12 text-emerald-700 ring-1 ring-emerald-500/25 dark:bg-emerald-400/12 dark:text-emerald-300",
    dot: "bg-emerald-500",
  },
}

/**
 * Una señal que el pack define (por ejemplo un nivel de riesgo): el chip del nivel que tiene el PR, con su color,
 * ícono y tooltip. Sin la señal muestra `empty` del pack, o nada si el pack no lo define.
 */
export function SignalChip({ signal, level, className }: { signal: PrSignal; level: string | undefined; className?: string }) {
  const found = level === undefined ? undefined : signal.levels[level]
  if (!found) {
    if (!signal.empty) return null
    return (
      <Pill className={cn("text-muted-foreground ring-1 ring-border", className)} hint={`El PR no tiene la señal "${signal.id}" que define el pack`}>
        <CircleAlert className="size-3" /> {signal.empty}
      </Pill>
    )
  }
  const t = SIGNAL_TONE[found.tone]
  return (
    <Pill className={cn("font-semibold", t.className, className)} hint={found.hint}>
      <t.Icon className="size-3" /> {found.label}
    </Pill>
  )
}

/** Todas las señales del pack del PR, cada una con su nivel. */
export function Signals({ pr, className }: { pr: OpenPr; className?: string }) {
  if (!pr.signals.length) return null
  return (
    <>
      {pr.signals.map((signal) => (
        <SignalChip key={signal.id} signal={signal} level={pr.state.signals[signal.id]} className={className} />
      ))}
    </>
  )
}

/** Los labels que no son una señal del pack: esos ya se ven como chip. */
export function Labels({ pr, max = 3 }: { pr: OpenPr; max?: number }) {
  const matchers = pr.signals.map((s) => new RegExp(s.match, s.flags))
  const labels = pr.state.labels.filter((l) => !matchers.some((m) => m.test(l.name.trim())))
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

// Merge: verde = listo según la estrategia del pack; violeta = ya está en la cola; rojo = falló en la cola; ámbar = hold.
export function mergeRing(pr: OpenPr): string | null {
  switch (mergeMark(pr)) {
    case "failed":
      return "ring-2 ring-red-500"
    case "queued":
      return "ring-2 ring-violet-500/70"
    case "hold":
      return "ring-2 ring-amber-500/70"
    case "ready":
      return "ring-2 ring-emerald-500"
    case null:
      return null
  }
}

/** El estado de la estrategia de merge del pack (`PrState.merge` y `hold`): lo que falta va en el tooltip del review. */
export function MergePill({ pr }: { pr: OpenPr }) {
  const { merge } = pr.state
  switch (mergeMark(pr)) {
    case "failed":
      return (
        <Pill className={tone.red} hint="Se pidió el merge pero el check de la cola falló. Revisa por qué en GitHub y vuelve a pedirlo">
          Cola falló
        </Pill>
      )
    case "queued":
      return (
        <Pill className={tone.violet} hint="Ya se pidió el merge: la cola está corriendo el CI final para mergearlo">
          <span className="animate-blink size-1.5 rounded-full bg-current" /> En cola
        </Pill>
      )
    case "hold":
      return (
        <Pill className={tone.amber} hint="Marcaste este PR como no mergear nunca: el core no lo ofrece ni lo mergea solo, y mergear desde acá lo rechaza hasta que quites el hold">
          <PauseCircle className="size-3" /> Hold
        </Pill>
      )
    case "ready":
      return (
        <Pill
          className={tone.green}
          hint={
            merge.via === "comment"
              ? "Cumple la estrategia de merge del pack: aprobado, CI verde, sin hilos de humanos sin resolver, sin conflictos y sobre la branch principal. Se mergea comentando el comando de merge"
              : "Aprobado, CI verde, sin hilos de humanos sin resolver y sin conflictos: se mergea con el botón de GitHub"
          }
        >
          <GitMerge className="size-3" /> Listo para merge
        </Pill>
      )
    case null:
      return null
  }
}

/** El PR sale de una base combinada: la rama sintética que junta a varios PRs padre. */
export function CombinedBaseChip({ parents }: { parents: readonly string[] }) {
  return (
    <Pill
      className={tone.sky}
      hint={`Base combinada: este PR sale de una rama sintética que junta a ${parents.join(" y ")}. Su diff incluye los commits de todos sus padres y puede inflar el riesgo`}
    >
      <Layers className="size-3" /> Base combinada
    </Pill>
  )
}

export function mergeHint(pr: OpenPr): string | undefined {
  const { merge, hold } = pr.state
  if (merge.ready || hold || merge.queue || !merge.blockers.length) return undefined
  return `Para mergear falta: ${merge.blockers.join(", ")}`
}

const REVIEW_HINT: Record<ReviewStatus, string> = {
  changes: "Pidieron cambios, o hay comentarios o hilos sin resolver: la pelota está de tu lado",
  pending: "Hay revisores asignados que todavía no hacen su review",
  approved: "Tiene aprobación de review",
  none: "Nadie lo ha revisado ni tiene revisores asignados",
}

// Estado de review del PR, con lo que falta para mergear en el tooltip.
export function ReviewPill({ pr, review }: { pr: OpenPr; review: ReviewStatus }) {
  const t = reviewTone[review]
  const blockers = mergeHint(pr)
  return (
    <Pill className={t.pill} hint={blockers ? `${REVIEW_HINT[review]}. ${blockers}` : REVIEW_HINT[review]}>
      {t.label}
    </Pill>
  )
}

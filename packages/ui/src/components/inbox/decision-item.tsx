import type { Breaker, Decision } from "@clanker/api"
import { CornerDownLeft, Plug, Reply, Send, X } from "lucide-react"
import { useState } from "react"
import { Ago, Hint, Pill, Shortcut } from "@/components/common"
import { type DecisionScope, KindPill, RunChip } from "@/components/inbox/decision-parts"
import { nextRetry, RetryBreakerButton, useRetryBreaker } from "@/components/project/breaker-strip"
import { useNow } from "@/hooks/use-now"
import { Button } from "@/components/ui/button"
import { Textarea } from "@/components/ui/textarea"
import { isBlocking, isDestructive, optionLabel, optionsOf, RESOLVED_HINT, RESOLVED_LABEL, resolutionText, takesText } from "@/lib/decisions"
import { absolute, tone } from "@/lib/format"

interface Props {
  decision: Decision
  scope: DecisionScope
  /** "Responder…" está abierto: el texto libre en vez de las opciones. */
  responding: boolean
  onRespondingChange: (on: boolean) => void
  /** Elegir una opción o mandar el texto libre: lo mismo para el core. */
  onResolve: (option: string) => void
  /** `null` si la decisión no sale de una corrida. */
  onOpenRun: (() => void) | null
  /** Lleva a Conexiones: una alerta suele venir de una conexión vencida o caída. */
  onGoConnections: () => void
  /** El breaker abierto que dejó esta alerta, si la dejó uno: se puede reintentar ya. */
  breaker?: Breaker
}

// La decisión a la vista: la pregunta, su contexto y las opciones numeradas con el atajo de cada una. Un gate o
// un needs_human solo se contestan con sus opciones (son los outcomes del flujo); lo que no bloquea admite
// además una respuesta en texto libre.
export function DecisionItem({ decision, scope, responding, onRespondingChange, onResolve, onOpenRun, onGoConnections, breaker }: Props) {
  const now = useNow(breaker !== undefined)
  const { retrying, retry } = useRetryBreaker(breaker?.scope)
  const pending = decision.status === "pending"
  const options = optionsOf(decision)
  const canRespond = takesText(decision)
  const resolvesItself = pending && decision.kind === "alert" && options.length === 0
  // Un gate guarda sus opciones en el cuerpo, una línea por opción: ya están como botones.
  const context = decision.kind === "gate" ? "" : decision.body

  return (
    <article aria-label={decision.title} className="flex flex-col gap-4">
      <header className="flex flex-col gap-2">
        <div className="flex flex-wrap items-center gap-1.5">
          <KindPill kind={decision.kind} />
          <RunChip decision={decision} scope={scope} onOpen={onOpenRun ?? undefined} />
          {scope.project ? (
            <Pill className={tone.neutral} hint="El proyecto de la decisión.">
              {scope.project.name}
            </Pill>
          ) : null}
          <Ago at={decision.createdAt} className="text-xs text-muted-foreground" />
        </div>
        <h2 className="text-base font-semibold text-balance">{decision.title}</h2>
      </header>

      {context ? <p className="text-[13px] leading-relaxed whitespace-pre-wrap text-muted-foreground">{context}</p> : null}

      {resolvesItself ? (
        <div className="flex flex-col gap-2">
          <p className="text-xs text-muted-foreground">
            {breaker
              ? `Se cierra sola cuando la causa se va. Próximo reintento: ${nextRetry(breaker.nextProbeAt, now)}. Si ya la arreglaste, reinténtala ahora.`
              : "Esta alerta no se resuelve a mano: se cierra sola cuando la causa se va."}
          </p>
          <div className="flex flex-wrap items-center gap-2">
            {breaker ? <RetryBreakerButton retrying={retrying} onRetry={retry} variant="default" /> : null}
            <Hint label="Ver el estado de las conexiones" keys="GC">
              <Button variant="secondary" onClick={onGoConnections}>
                <Plug /> Ir a Conexiones
              </Button>
            </Hint>
          </div>
        </div>
      ) : pending ? (
        responding ? (
          <Respond onSend={onResolve} onCancel={() => onRespondingChange(false)} />
        ) : (
          <div className="flex flex-col gap-2">
            <div role="group" aria-label="Opciones" className="flex flex-wrap items-center gap-2">
              {options.slice(0, 9).map((option, i) => (
                <Button key={option} variant={isDestructive(option) ? "outline" : i === 0 ? "default" : "secondary"} onClick={() => onResolve(option)}>
                  <Shortcut keys={String(i + 1)} className="opacity-70" />
                  {optionLabel(decision, option)}
                </Button>
              ))}
              {canRespond ? (
                <Hint label="Responder con texto libre" keys="R">
                  <Button variant="ghost" onClick={() => onRespondingChange(true)}>
                    <Reply /> Responder…
                  </Button>
                </Hint>
              ) : null}
              {onOpenRun ? (
                <Hint label="Abrir la corrida de esta decisión" keys="⏎">
                  <Button variant="ghost" className="ml-auto" onClick={onOpenRun}>
                    Abrir corrida <CornerDownLeft />
                  </Button>
                </Hint>
              ) : null}
            </div>
            {isBlocking(decision) ? (
              <p className="text-xs text-muted-foreground">Elegir una opción devuelve la corrida a la cola de su carril. Tienes unos segundos para deshacerlo con Z.</p>
            ) : null}
          </div>
        )
      ) : (
        <Resolved decision={decision} />
      )}
    </article>
  )
}

function Resolved({ decision }: { decision: Decision }) {
  const answer = resolutionText(decision)
  return (
    <section aria-label="Resolución" className="flex flex-col gap-1.5 rounded-lg border bg-card px-3 py-2.5 text-[13px]">
      <div className="flex items-center gap-2">
        <Pill className={tone.neutral} hint={RESOLVED_HINT[decision.status]}>
          {RESOLVED_LABEL[decision.status]}
        </Pill>
        {decision.resolvedAt ? (
          <time dateTime={new Date(decision.resolvedAt).toISOString()} className="text-xs text-muted-foreground">
            {absolute(decision.resolvedAt)}
          </time>
        ) : null}
        {decision.resolvedBy ? <span className="text-xs text-muted-foreground">por {decision.resolvedBy}</span> : null}
      </div>
      {answer ? <p>{answer}</p> : null}
    </section>
  )
}

function Respond({ onSend, onCancel }: { onSend: (text: string) => void; onCancel: () => void }) {
  const [text, setText] = useState("")
  const send = () => text.trim() && onSend(text.trim())
  return (
    <div className="flex flex-col gap-2">
      <Textarea
        autoFocus
        aria-label="Tu respuesta"
        placeholder="Escribe tu respuesta…"
        value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
            e.preventDefault()
            send()
          } else if (e.key === "Escape") {
            e.preventDefault()
            e.stopPropagation()
            onCancel()
          }
        }}
        className="min-h-24"
      />
      <div className="flex items-center gap-2">
        <Button onClick={send} disabled={!text.trim()}>
          <Send /> Enviar respuesta
          <Shortcut keys="⌘⏎" className="opacity-70" />
        </Button>
        <Button variant="ghost" onClick={onCancel}>
          <X /> Cancelar
          <Shortcut keys="⎋" />
        </Button>
      </div>
    </div>
  )
}

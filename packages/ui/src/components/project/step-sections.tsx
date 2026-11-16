import type { Step, StepDetail, StepSession } from "@clanker/api"
import { ChevronRight, Copy } from "lucide-react"
import { Pill } from "@/components/common"
import { ArtifactText, Code, EmptyNote } from "@/components/project/step-parts"
import { sessionLook, stepLook } from "@/components/project/status"
import { Button } from "@/components/ui/button"
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible"
import { copy } from "@/lib/clipboard"
import { absolute, compactCount, costUsd, elapsed, fileSize, tone } from "@/lib/format"
import { cn } from "@/lib/utils"

const Field = ({ label, children }: { label: string; children: React.ReactNode }) => (
  <div className="flex items-baseline gap-3">
    <dt className="w-16 flex-none text-xs text-muted-foreground">{label}</dt>
    <dd className="min-w-0 flex-1 truncate">{children}</dd>
  </div>
)

const Section = ({ title, children }: { title: string; children: React.ReactNode }) => (
  <section className="flex flex-col gap-1.5">
    <h3 className="text-xs font-medium text-muted-foreground">{title}</h3>
    {children}
  </section>
)

const artifactNamed = (detail: StepDetail, name: string) => detail.artifacts.find((a) => a.name === name)

/** Lo que el paso recibió: el brief de un agente o los args de una acción, tal como el core lo resolvió. */
export function BriefSection({ detail, session, step }: { detail: StepDetail; session: StepSession | undefined; step: Step }) {
  const input = artifactNamed(detail, "input")
  return (
    <div className="flex flex-col gap-4 p-4">
      {session ? (
        <dl className="flex flex-col gap-1">
          <Field label="Rol">
            <span className="font-mono text-[12.5px]">{session.role}</span>
          </Field>
          <Field label="Runtime">
            <span className="font-mono text-[12.5px]">{session.runtime}</span>
          </Field>
          <Field label="Modelo">
            {session.model}
            {session.effort ? ` · effort ${session.effort}` : ""}
          </Field>
          <Field label="Sesión">
            <button type="button" className="inline-flex items-center gap-1.5 font-mono text-[12.5px] hover:underline" onClick={() => copy(session.sessionRef, "el sessionId")}>
              {session.sessionRef} <Copy className="size-3 text-muted-foreground" />
            </button>
          </Field>
        </dl>
      ) : null}
      {input ? (
        <Section title="Brief que recibió">
          <ArtifactText hash={input.hash} size={input.size} />
        </Section>
      ) : (
        <EmptyNote title="El paso todavía no recibió su brief">
          {step.status === "pending" ? "Parte cuando el flujo llegue a este nodo." : "El core lo guarda en cuanto el paso empieza."}
        </EmptyNote>
      )}
    </div>
  )
}

/** El reporte validado de la sesión (agente) o el output del paso (acción, wait). */
export function ReportSection({ detail, session, step }: { detail: StepDetail; session: StepSession | undefined; step: Step }) {
  const output = artifactNamed(detail, "output")
  const report = session?.report
  if (report) {
    return (
      <div className="flex flex-col gap-4 p-4">
        <div className="flex items-center gap-2">
          <Pill className={tone.sky} hint="Resultado del reporte: decide qué edge sigue el flujo.">
            {report.outcome}
          </Pill>
        </div>
        <p className="text-[13px] whitespace-pre-wrap">{report.summary}</p>
        {report.decisions?.length ? (
          <Section title="Decisiones que quedaron en la bandeja">
            <ul className="flex flex-col gap-2">
              {report.decisions.map((d) => (
                <li key={d.title} className="rounded-md border p-2">
                  <p className="text-[13px] font-medium">{d.title}</p>
                  <p className="text-muted-foreground">{d.body}</p>
                </li>
              ))}
            </ul>
          </Section>
        ) : null}
        {report.learnings?.length ? (
          <Section title="Aprendizajes propuestos">
            <ul className="list-disc pl-5">
              {report.learnings.map((l) => (
                <li key={l}>{l}</li>
              ))}
            </ul>
          </Section>
        ) : null}
        {report.payload !== undefined && report.payload !== null ? (
          <Section title="Payload">
            <Code>{JSON.stringify(report.payload, null, 2)}</Code>
          </Section>
        ) : null}
      </div>
    )
  }
  if (output) {
    return (
      <div className="flex flex-col gap-3 p-4">
        <Section title={step.outcome ? `Salida del paso · ${step.outcome}` : "Salida del paso"}>
          <ArtifactText hash={output.hash} size={output.size} />
        </Section>
      </div>
    )
  }
  const reason = session?.error ?? step.error
  return (
    <EmptyNote title="Todavía no hay reporte">
      {reason
        ? `El paso terminó sin reporte: ${reason}`
        : step.status === "pending"
          ? "Parte cuando el flujo llegue a este nodo."
          : "El reporte aparece cuando el agente lo entrega y el core lo valida."}
    </EmptyNote>
  )
}

export function ArtifactsSection({ detail }: { detail: StepDetail }) {
  if (detail.artifacts.length === 0) {
    return <EmptyNote title="Este paso no dejó artefactos">El brief, el output y los extractos de logs quedan guardados aquí cuando el paso los produce.</EmptyNote>
  }
  return (
    <ul className="flex flex-col">
      {detail.artifacts.map((a) => (
        <li key={`${a.name}:${a.hash}`} className="border-b last:border-b-0">
          <Collapsible>
            <CollapsibleTrigger className="group flex min-h-9 w-full items-center gap-2 px-4 py-1.5 text-left hover:bg-muted/50">
              <ChevronRight className="size-3.5 flex-none text-muted-foreground transition-transform group-data-[state=open]:rotate-90" />
              <span className="min-w-0 flex-1 truncate font-mono text-[12.5px]">{a.name}</span>
              <Pill className={tone.neutral} hint="Qué guarda este artefacto: el brief que recibió, el reporte o un extracto de log.">
                {a.kind}
              </Pill>
              <span className="w-16 flex-none text-right text-xs text-muted-foreground tabular-nums">{fileSize(a.size)}</span>
            </CollapsibleTrigger>
            <CollapsibleContent className="flex flex-col gap-2 px-4 pb-3">
              <button type="button" className="inline-flex w-fit items-center gap-1.5 font-mono text-[11px] text-muted-foreground hover:underline" onClick={() => copy(a.hash, "el hash")}>
                {a.hash.slice(0, 16)}… <Copy className="size-3" />
              </button>
              <ArtifactText hash={a.hash} size={a.size} />
            </CollapsibleContent>
          </Collapsible>
        </li>
      ))}
    </ul>
  )
}

/** Cada intento de un paso de agente es una sesión; elegir uno lleva a su transcript. */
export function AttemptsSection({ step, sessions, picked, onPick }: { step: Step; sessions: StepSession[]; picked: string | undefined; onPick: (sessionId: string) => void }) {
  if (sessions.length === 0) {
    const look = stepLook(step.status)
    return (
      <div className="flex flex-col gap-2 p-4">
        <div className="flex items-center gap-2">
          <span className="text-[13px] font-medium">{step.attempt > 0 ? `Intento ${step.attempt}` : "Sin intentos todavía"}</span>
          <Pill className={look.tone} hint={look.hint}>
            {look.label}
          </Pill>
        </div>
        {step.error ? <p className="text-red-700 dark:text-red-300">{step.error}</p> : null}
        {step.notBefore ? <p className="text-muted-foreground">Reintenta {absolute(step.notBefore)}.</p> : null}
        <p className="text-muted-foreground">Un paso que no es de agente no abre sesiones: cada reintento repite el mismo paso y solo conserva su último error.</p>
      </div>
    )
  }
  return (
    <ol className="flex flex-col">
      {sessions.map((s, i) => {
        const look = sessionLook(s.status)
        const tokens = s.usage.input + s.usage.output + s.usage.cacheRead + s.usage.cacheWrite
        return (
          <li key={s.id} className="border-b last:border-b-0">
            <Button variant="ghost" className={cn("h-auto w-full flex-col items-stretch gap-1 rounded-none px-4 py-2.5 text-left font-normal", s.id === picked && "bg-muted/60")} onClick={() => onPick(s.id)}>
              <span className="flex items-center gap-2">
                <span className="text-[13px] font-medium">Intento {i + 1}</span>
                <Pill className={look.tone} hint={look.hint}>
                  {look.label}
                </Pill>
                <span className="ml-auto text-xs text-muted-foreground tabular-nums">{s.endedAt ? elapsed(s.endedAt - s.startedAt) : "en curso"}</span>
                <span className="w-16 text-right text-xs tabular-nums">{costUsd(s.costMicros)}</span>
              </span>
              <span className="text-xs text-muted-foreground">
                {s.model} · {s.turns} turnos · {compactCount(tokens)} tokens
              </span>
              {s.error ? <span className="text-xs whitespace-normal text-red-700 dark:text-red-300">{s.error}</span> : null}
            </Button>
          </li>
        )
      })}
    </ol>
  )
}

/** Los comandos de una acción tal como quedaron en su log: comando, salida y código de salida. */
export function CommandsSection({ detail, step }: { detail: StepDetail; step: Step }) {
  if (detail.commands.length === 0) {
    return (
      <EmptyNote title="Este paso no corrió comandos">
        {step.status === "pending"
          ? "Parte cuando el flujo llegue a este nodo."
          : "Solo las acciones que ejecutan comandos en el worktree (checks, setup) dejan su salida aquí; las de git o GitHub muestran su resultado en Reporte."}
      </EmptyNote>
    )
  }
  return (
    <ol className="flex flex-col gap-4 p-4">
      {detail.commands.map((c, i) => (
        <li key={`${i}:${c.command}`} className="flex flex-col gap-1.5">
          <div className="flex items-center gap-2">
            <code className="min-w-0 flex-1 truncate font-mono text-[12.5px]">$ {c.command}</code>
            {c.exitCode === null && c.killedBy === null ? (
              <Pill className={tone.violet} hint="El comando sigue corriendo: la salida se actualiza sola.">
                corriendo
              </Pill>
            ) : c.killedBy ? (
              <Pill className={tone.red} hint="Una señal mató el comando antes de que terminara por su cuenta.">
                terminó por {c.killedBy}
              </Pill>
            ) : (
              <Pill className={c.exitCode === 0 ? tone.green : tone.red} hint="Código de salida del comando: 0 es éxito.">
                exit {c.exitCode}
              </Pill>
            )}
          </div>
          {c.output ? <Code className="max-h-72" error={c.exitCode !== null && c.exitCode !== 0}>{c.output}</Code> : <p className="text-muted-foreground">Sin salida.</p>}
          {c.truncated ? <p className="text-[11px] text-muted-foreground">Se muestra el final de la salida.</p> : null}
        </li>
      ))}
    </ol>
  )
}

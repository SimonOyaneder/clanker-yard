import type { CachedIssue, RunDetail, Step } from "@clanker/api"
import { Copy } from "lucide-react"
import { Pill, SectionTitle, StatBar } from "@/components/common"
import { RunStatusPill, isLive, stepLook } from "@/components/project/status"
import { ContextMenu, ContextMenuContent, ContextMenuItem, ContextMenuTrigger } from "@/components/ui/context-menu"
import { useNow } from "@/hooks/use-now"
import { copy } from "@/lib/clipboard"
import { absolute, costUsd, elapsed, issueKey, tone } from "@/lib/format"
import { cn } from "@/lib/utils"

const OUTCOME = { done: "terminó el flujo", blocked: "terminó sin completar la issue", failed: "un paso falló sin salida" } as const

// Una corrida de una issue: dónde va y cuánto costó cada paso, en el orden en que se crearon.
export function RunView({ run, issue }: { run: RunDetail; issue: CachedIssue | undefined }) {
  const ticking = run.status === "running" || run.status === "waiting"
  const now = useNow(ticking)
  const finished = run.steps.filter((s) => s.status === "done").length
  const rounds = Object.entries(run.rounds).filter(([, visits]) => visits > 0)
  const failure = run.status === "failed" ? run.steps.findLast((s) => s.status === "failed" && s.error) : undefined

  return (
    <div className="flex flex-col gap-6">
      <header className="flex flex-col gap-2">
        <div className="flex items-center gap-2.5">
          <span className="font-mono text-xs text-muted-foreground">{issue ? issueKey(issue) : `${run.subject.type}:${run.subject.id}`}</span>
          <RunStatusPill run={run} />
          {run.outcome ? <span className="text-xs text-muted-foreground">{OUTCOME[run.outcome as keyof typeof OUTCOME] ?? run.outcome}</span> : null}
        </div>
        <h1 className="text-lg font-semibold">{issue?.title ?? "Issue fuera del caché"}</h1>
        <div className="flex flex-wrap items-center gap-1.5">
          <Pill className={tone.neutral} hint="Flujo de la corrida. Sigue con esta versión aunque el flujo cambie.">
            {run.flow.slug} v{run.flow.version}
          </Pill>
          <Pill className={tone.neutral} hint="Carril en que corre: dev toma issues nuevas, mantenimiento atiende PRs ya abiertos.">
            carril {run.lane === "dev" ? "dev" : "mantenimiento"}
          </Pill>
          {run.status === "parked" && run.parkReason ? (
            <Pill className={tone.amber} hint="Por qué espera a una persona. No ocupa cupo de su carril.">
              {run.parkReason}
            </Pill>
          ) : null}
        </div>
      </header>

      {failure ? (
        <div role="alert" className={cn("rounded-lg px-3 py-2 text-[13px]", tone.red)}>
          <span className="font-medium">{failure.nodeId} falló.</span> {failure.error}
        </div>
      ) : null}

      <StatBar
        items={[
          { label: "Tiempo", value: elapsed((run.endedAt ?? now) - run.startedAt), sub: run.endedAt ? "terminó" : "en curso" },
          { label: "Costo", value: costUsd(run.costMicros) },
          { label: "Pasos", value: `${finished}/${run.steps.length}`, sub: "listos" },
          {
            label: "Rondas",
            value: rounds.length ? rounds.map(([name, visits]) => `${name} ${visits}`).join(" · ") : "—",
            sub: rounds.length ? "veces que se tomó cada vuelta" : "sin vueltas",
          },
        ]}
      />

      <section className="flex flex-col gap-2">
        <SectionTitle count={run.steps.length}>Línea de tiempo</SectionTitle>
        {run.steps.length === 0 ? (
          <p className="text-muted-foreground">
            {isLive(run.status) ? "Todavía no parte ningún paso." : "La corrida terminó sin ejecutar pasos."}
          </p>
        ) : (
          <ol className="overflow-hidden rounded-lg border bg-card">
            {run.steps.map((step) => (
              <StepRow key={step.id} step={step} />
            ))}
          </ol>
        )}
      </section>
    </div>
  )
}

function StepRow({ step }: { step: Step }) {
  const look = stepLook(step.status)
  return (
    <li className="border-b last:border-b-0">
      <ContextMenu>
        <ContextMenuTrigger asChild>
          <div className="flex flex-col gap-1 px-3 py-2">
            <div className="flex min-h-5 items-center gap-3">
              <look.Icon aria-label={look.label} className={cn("size-3.5 flex-none", look.iconClass, look.pulse && "cc-blink")} />
              <span className="min-w-0 flex-1 truncate font-mono text-[12.5px]">{step.nodeId}</span>
              {step.visit > 1 ? (
                <Pill className={tone.neutral} hint={`El flujo volvió a este nodo: es su visita número ${step.visit}.`}>
                  visita {step.visit}
                </Pill>
              ) : null}
              {step.round > 0 ? (
                <Pill className={tone.neutral} hint="Ronda de la vuelta en que corrió este paso.">
                  ronda {step.round}
                </Pill>
              ) : null}
              {step.attempt > 1 ? (
                <Pill className={tone.amber} hint={`El paso se reintentó tras un error: es su intento número ${step.attempt}.`}>
                  intento {step.attempt}
                </Pill>
              ) : null}
              {step.outcome ? (
                <Pill className={tone.sky} hint="Resultado del paso: decide qué arista del flujo sigue.">
                  {step.outcome}
                </Pill>
              ) : (
                <Pill className={look.tone} hint={look.hint}>
                  {look.label}
                </Pill>
              )}
              <span className="w-16 flex-none text-right text-xs tabular-nums">{step.costMicros ? costUsd(step.costMicros) : ""}</span>
            </div>
            {step.error ? <p className="pl-[26px] text-xs text-red-700 dark:text-red-300">{step.error}</p> : null}
            {step.notBefore ? <p className="pl-[26px] text-xs text-muted-foreground">Reintenta {absolute(step.notBefore)}</p> : null}
          </div>
        </ContextMenuTrigger>
        <ContextMenuContent className="w-52">
          <ContextMenuItem onSelect={() => copy(step.id, "el ID del paso")}>
            <Copy /> Copiar ID del paso
          </ContextMenuItem>
        </ContextMenuContent>
      </ContextMenu>
    </li>
  )
}

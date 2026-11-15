import type { CachedIssue, RunDetail, Step } from "@clanker/api"
import { Copy, Ellipsis, GitBranch, GitMerge, ListTree, Network, Octagon, Pause, Play, RotateCcw, Square } from "lucide-react"
import { useMemo } from "react"
import { Hint, Pill, SectionTitle, StatBar } from "@/components/common"
import { useRunCommands } from "@/components/project/run-commands"
import { RunGraph } from "@/components/project/run-graph"
import { ParkedCallout } from "@/components/project/run-decisions"
import { RunStatusPill, isLive, stepLook } from "@/components/project/status"
import { StepPanel, type StepTab, useCopySessionId } from "@/components/project/step-panel"
import { Button } from "@/components/ui/button"
import { ContextMenu, ContextMenuContent, ContextMenuItem, ContextMenuShortcut, ContextMenuTrigger } from "@/components/ui/context-menu"
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuShortcut, DropdownMenuTrigger } from "@/components/ui/dropdown-menu"
import { ResizableHandle, ResizablePanel, ResizablePanelGroup } from "@/components/ui/resizable"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { useNow } from "@/hooks/use-now"
import { copy } from "@/lib/clipboard"
import { absolute, compactCount, costUsd, elapsed, issueKey, tone } from "@/lib/format"
import { readPref, writePref } from "@/lib/prefs"
import { currentRound, type GraphNodeKind, shapeOf } from "@/lib/run-graph"
import { type RunCaps, runCaps } from "@/lib/run-commands"
import { cn } from "@/lib/utils"

const OUTCOME = { done: "terminó el flujo", blocked: "terminó sin completar la issue", failed: "un paso falló sin salida" } as const

export type RunTab = "graph" | "timeline"

interface RunViewProps {
  run: RunDetail
  issue: CachedIssue | undefined
  tab: RunTab
  onTabChange: (tab: RunTab) => void
  /** El nodo cuyo panel está abierto; `null` si ninguno. */
  node: string | null
  onNodeChange: (nodeId: string | null) => void
  stepTab: StepTab
  onStepTab: (tab: StepTab) => void
}

// Ancho que ocupa el panel del paso, en % de la vista; el último que dejó el usuario.
const PANEL_SIZE_PREF = "stepPanelSize"

// Una corrida de una issue: el grafo del flujo que corre, con dónde va y cuánto costó cada paso, y la
// línea de tiempo de sus pasos en el orden en que se crearon. A la derecha, redimensionable, el panel del
// paso elegido: qué recibió y qué dijo el agente, o qué comando corrió la acción.
export function RunView({ run, issue, tab, onTabChange, node, onNodeChange, stepTab, onStepTab }: RunViewProps) {
  const ticking = run.status === "running" || run.status === "waiting"
  const now = useNow(ticking)
  const failure = run.status === "failed" ? run.steps.findLast((s) => s.status === "failed" && s.error) : undefined
  const shape = useMemo(() => shapeOf(run.flowDef, run.steps), [run.flowDef, run.steps])
  const copySessionId = useCopySessionId()
  const caps = useMemo(() => runCaps(run, shape), [run, shape])
  const open = shape.nodes.find((n) => n.id === node && n.kind !== "end")
  const round = currentRound(shape, run)
  const inputTokens = run.usage.input + run.usage.cacheRead + run.usage.cacheWrite
  const cacheHit = inputTokens > 0 ? Math.round((run.usage.cacheRead / inputTokens) * 100) : null

  return (
    <div className="flex flex-col gap-5">
      <header className="flex flex-col gap-2">
        <div className="flex items-center gap-2.5">
          <span className="font-mono text-xs text-muted-foreground">{issue ? issueKey(issue) : `${run.subject.type}:${run.subject.id}`}</span>
          <RunStatusPill run={run} />
          {run.outcome ? <span className="text-xs text-muted-foreground">{OUTCOME[run.outcome as keyof typeof OUTCOME] ?? run.outcome}</span> : null}
          <RunActions run={run} caps={caps} />
        </div>
        <h1 className="text-lg font-semibold">{issue?.title ?? "Issue fuera del caché"}</h1>
        <div className="flex flex-wrap items-center gap-1.5">
          <Pill className={tone.neutral} hint="Carril en que corre: dev toma issues nuevas, mantenimiento atiende PRs ya abiertos.">
            carril {run.lane === "dev" ? "dev" : "mantenimiento"}
          </Pill>
          {run.workspace ? (
            <>
              <Pill className={tone.neutral} hint="Repo cuyo worktree usa la corrida.">
                {run.workspace.repo}
              </Pill>
              <Pill className={cn(tone.neutral, "font-mono")} hint="Branch del worktree de la corrida.">
                <GitBranch className="size-3" />
                {run.workspace.branch}
              </Pill>
              <Pill className={cn(tone.neutral, "font-mono")} hint="Branch base: sobre ella se abre el PR y con ella se sincroniza.">
                <GitMerge className="size-3" />
                {run.workspace.base}
              </Pill>
            </>
          ) : null}
          <Pill className={tone.neutral} hint="Flujo de la corrida. Sigue con esta versión aunque el flujo cambie.">
            {run.flow.slug}@{run.flow.version}
          </Pill>
          {run.status === "parked" && run.parkReason ? (
            <Pill className={tone.amber} hint="Por qué espera a una persona. No ocupa cupo de su carril.">
              {run.parkReason}
            </Pill>
          ) : null}
        </div>
      </header>

      <ParkedCallout run={run} />

      {failure ? (
        <div role="alert" className={cn("rounded-lg px-3 py-2 text-[13px]", tone.red)}>
          <span className="font-medium">{failure.nodeId} falló.</span> {failure.error}
        </div>
      ) : null}

      <StatBar
        items={[
          { label: "Tiempo", value: elapsed((run.endedAt ?? now) - run.startedAt), sub: run.endedAt ? "terminó" : "en curso" },
          { label: "Costo", value: costUsd(run.costMicros) },
          { label: "Tokens", value: compactCount(run.usage.input + run.usage.output + run.usage.cacheRead + run.usage.cacheWrite), sub: `${compactCount(run.usage.output)} de salida` },
          { label: "Caché", value: cacheHit === null ? "—" : `${cacheHit}%`, sub: "de la entrada leída de caché" },
          {
            label: round ? `Ronda ${round.name}` : "Ronda",
            value: round ? `${round.round}${round.max === null ? "" : `/${round.max}`}` : "—",
            sub: round ? "vuelta en que va" : "sin vueltas",
          },
        ]}
      />

      <div className="h-[clamp(520px,78vh,900px)]">
        <ResizablePanelGroup
          orientation="horizontal"
          onLayoutChanged={(layout) => {
            if (layout.step !== undefined) writePref(PANEL_SIZE_PREF, Math.round(layout.step))
          }}
        >
          <ResizablePanel id="main" minSize="30%" className={cn(open && "pr-3")}>
            <Tabs value={tab} onValueChange={(value) => onTabChange(value as RunTab)} className="h-full min-h-0 gap-3">
              <TabsList>
                <Hint label="El flujo de la corrida como grafo" keys="G" side="bottom">
                  <TabsTrigger value="graph">
                    <Network /> Grafo
                  </TabsTrigger>
                </Hint>
                <Hint label="Los pasos en el orden en que corrieron" keys="L" side="bottom">
                  <TabsTrigger value="timeline">
                    <ListTree /> Línea de tiempo
                  </TabsTrigger>
                </Hint>
              </TabsList>
              <TabsContent value="graph" className="min-h-0">
                <RunGraph run={run} now={now} shape={shape} selected={open?.id ?? null} onSelect={onNodeChange} onCopySessionId={copySessionId} />
              </TabsContent>
              <TabsContent value="timeline" className="min-h-0 overflow-y-auto">
                <section className="flex flex-col gap-2">
                  <SectionTitle count={run.steps.length}>Línea de tiempo</SectionTitle>
                  {run.steps.length === 0 ? (
                    <p className="text-muted-foreground">{isLive(run.status) ? "Todavía no parte ningún paso." : "La corrida terminó sin ejecutar pasos."}</p>
                  ) : (
                    <ol className="overflow-hidden rounded-lg border bg-card">
                      {run.steps.map((step) => (
                        <StepRow key={step.id} step={step} now={now} selected={step.nodeId === open?.id} kind={shape.nodes.find((n) => n.id === step.nodeId)?.kind} onOpen={() => onNodeChange(step.nodeId)} onCopySessionId={() => copySessionId(step.id)} />
                      ))}
                    </ol>
                  )}
                </section>
              </TabsContent>
            </Tabs>
          </ResizablePanel>
          {open ? (
            <>
              <ResizableHandle withHandle />
              <ResizablePanel id="step" defaultSize={`${readPref(PANEL_SIZE_PREF, 40)}%`} minSize="28%" maxSize="70%" className="pl-3">
                <StepPanel key={open.id} run={run} shape={shape} node={open} tab={stepTab} onTab={onStepTab} onClose={() => onNodeChange(null)} />
              </ResizablePanel>
            </>
          ) : null}
        </ResizablePanelGroup>
      </div>
    </div>
  )
}

// Los botones de la corrida: lo que se puede pedir según su estado. Cancelar va en "…" porque no se deshace.
function RunActions({ run, caps }: { run: RunDetail; caps: RunCaps }) {
  const commands = useRunCommands()
  const { failedStep } = caps
  return (
    <div className="ml-auto flex items-center gap-1.5">
      {failedStep ? (
        <Hint label={`Vuelve a correr ${failedStep.nodeId} con una sesión nueva y sigue el flujo desde ahí`} keys="⇧⌘R">
          <Button size="sm" onClick={() => commands.retry(failedStep.id, failedStep.nodeId)}>
            <RotateCcw /> Reintentar paso
          </Button>
        </Hint>
      ) : null}
      {caps.resume ? (
        <Hint label="Vuelve a despachar los pasos de la corrida; el agente interrumpido sigue su sesión" keys="⇧⌘.">
          <Button size="sm" onClick={() => commands.resume(run.id)}>
            <Play /> Retomar
          </Button>
        </Hint>
      ) : null}
      {caps.pause ? (
        <Hint label="No despacha pasos nuevos; el agente en curso termina lo suyo. Sigue ocupando su cupo" keys="⇧⌘.">
          <Button size="sm" variant="outline" onClick={() => commands.pause(run.id)}>
            <Pause /> Pausar
          </Button>
        </Hint>
      ) : null}
      {caps.interrupt ? (
        <Hint label="Detiene al agente en curso con su sesión guardada y pausa la corrida" keys="⌘.">
          <Button size="sm" variant="outline" onClick={() => commands.interrupt(run.id)}>
            <Square /> Interrumpir
          </Button>
        </Hint>
      ) : null}
      {caps.cancel ? (
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button size="icon-sm" variant="ghost" aria-label="Más acciones de la corrida">
              <Ellipsis />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-56">
            <DropdownMenuItem variant="destructive" onSelect={() => commands.cancel(run.id)}>
              <Octagon /> Cancelar corrida
              <DropdownMenuShortcut>⇧⌘⌫</DropdownMenuShortcut>
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      ) : null}
    </div>
  )
}

function StepRow({ step, now, selected, kind, onOpen, onCopySessionId }: { step: Step; now: number; selected: boolean; kind: GraphNodeKind | undefined; onOpen: () => void; onCopySessionId: () => void }) {
  const look = stepLook(step.status)
  return (
    <li className="border-b last:border-b-0">
      <ContextMenu>
        <ContextMenuTrigger asChild>
          <div
            role="button"
            tabIndex={0}
            aria-label={`Abrir el panel de ${step.nodeId}`}
            aria-pressed={selected}
            onClick={onOpen}
            onKeyDown={(e) => {
              if (e.key === "Enter") onOpen()
            }}
            className={cn("flex cursor-pointer flex-col gap-1 px-3 py-2 outline-none hover:bg-muted/50 focus-visible:bg-muted/50", selected && "bg-muted/60")}
          >
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
              <span className="w-14 flex-none text-right text-xs text-muted-foreground tabular-nums">
                {step.startedAt !== null ? elapsed((step.endedAt ?? now) - step.startedAt) : ""}
              </span>
              <span className="w-16 flex-none text-right text-xs tabular-nums">{step.costMicros ? costUsd(step.costMicros) : ""}</span>
            </div>
            {step.error ? <p className="pl-[26px] text-xs text-red-700 dark:text-red-300">{step.error}</p> : null}
            {step.notBefore ? <p className="pl-[26px] text-xs text-muted-foreground">Reintenta {absolute(step.notBefore)}</p> : null}
          </div>
        </ContextMenuTrigger>
        <ContextMenuContent className="w-52">
          <ContextMenuItem onSelect={onOpen}>
            {kind === "agent" ? "Ver transcript" : "Ver el paso"}
            <ContextMenuShortcut>⏎</ContextMenuShortcut>
          </ContextMenuItem>
          {kind === "agent" ? <ContextMenuItem onSelect={onCopySessionId}>Copiar sessionId</ContextMenuItem> : null}
          <ContextMenuItem onSelect={() => copy(step.id, "el ID del paso")}>
            <Copy /> Copiar ID del paso
          </ContextMenuItem>
        </ContextMenuContent>
      </ContextMenu>
    </li>
  )
}

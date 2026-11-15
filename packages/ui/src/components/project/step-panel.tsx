import type { AgentSessionId, RunDetail, Step, StepRunId } from "@clanker/api"
import { ChevronDown, MessageSquarePlus, RotateCcw, Square, X, Zap } from "lucide-react"
import { useCallback, useState } from "react"
import { toast } from "sonner"
import { useAppData } from "@/app-data"
import { Hint, Pill } from "@/components/common"
import { ArtifactsSection, AttemptsSection, BriefSection, CommandsSection, ReportSection } from "@/components/project/step-sections"
import { EmptyNote } from "@/components/project/step-parts"
import { useRunCommands } from "@/components/project/run-commands"
import { StepTranscript } from "@/components/project/step-transcript"
import { stepLook } from "@/components/project/status"
import { Button } from "@/components/ui/button"
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { useLiveQuery } from "@/hooks/use-live"
import { copy } from "@/lib/clipboard"
import { tone } from "@/lib/format"
import { stepCaps, type StepCaps } from "@/lib/run-commands"
import type { GraphNode, GraphNodeKind, GraphShape } from "@/lib/run-graph"

export type StepTab = "transcript" | "command" | "brief" | "report" | "artifacts" | "attempts"

/** Las pestañas del panel según el tipo de nodo: solo un agente tiene transcript y solo una acción, comandos. */
export function tabsOf(kind: GraphNodeKind): StepTab[] {
  const common: StepTab[] = ["brief", "report", "artifacts", "attempts"]
  if (kind === "agent" || kind === "join") return ["transcript", ...common]
  if (kind === "action") return ["command", ...common]
  return common
}

/** Atajos de las pestañas, con el panel abierto; `T` es la principal del nodo (transcript o comando). */
export const STEP_TAB_KEYS: Record<string, "main" | StepTab> = { t: "main", b: "brief", r: "report", a: "artifacts", i: "attempts" }

const LABEL: Record<StepTab, { label: string; hint: string; keys: string }> = {
  transcript: { label: "Transcript", hint: "Todo lo que dijo y ejecutó el agente, con las tool calls plegadas", keys: "T" },
  command: { label: "Comando", hint: "Comando, salida y código de salida de la acción", keys: "T" },
  brief: { label: "Brief", hint: "Lo que el paso recibió al empezar", keys: "B" },
  report: { label: "Reporte", hint: "El reporte validado del agente o la salida del paso", keys: "R" },
  artifacts: { label: "Artefactos", hint: "Brief, output y extractos de logs guardados por el paso", keys: "A" },
  attempts: { label: "Intentos", hint: "Cada vez que el paso corrió: sesión, resultado y costo", keys: "I" },
}

export const effectiveTab = (tab: StepTab, kind: GraphNodeKind): StepTab => (tabsOf(kind).includes(tab) ? tab : tabsOf(kind)[0]!)

/** Copia el id de la sesión de agente (el del runtime, el que `claude --resume` entiende) de la última visita de un paso. */
export function useCopySessionId(): (stepId: StepRunId) => void {
  const appData = useAppData()
  return useCallback(
    (stepId) => {
      appData.step(stepId).then(
        (detail) => {
          const session = detail.sessions.at(-1)
          if (session) copy(session.sessionRef, "el sessionId")
          else toast.error("Este paso no abrió una sesión de agente")
        },
        (e: unknown) => toast.error(e instanceof Error ? e.message : String(e)),
      )
    },
    [appData],
  )
}

const stepLabel = (s: Step) => `visita ${s.visit}${s.round > 0 ? ` · ronda ${s.round}` : ""}${s.outcome ? ` · ${s.outcome}` : ""}`

interface Props {
  run: RunDetail
  shape: GraphShape
  node: GraphNode
  tab: StepTab
  onTab: (tab: StepTab) => void
  onClose: () => void
}

// El panel de un nodo del grafo: qué recibió, qué dijo y qué entregó. El selector de visita elige entre las
// veces que el flujo pasó por el nodo (rondas) y el de intento entre las sesiones de esa visita. Sin elegir,
// sigue a la última, así una corrida en vivo se ve avanzar.
export function StepPanel({ run, shape, node, tab, onTab, onClose }: Props) {
  const steps = run.steps.filter((s) => s.nodeId === node.id)
  const [pickedStep, setPickedStep] = useState<StepRunId | null>(null)
  const [pickedSession, setPickedSession] = useState<string | null>(null)
  const step = steps.find((s) => s.id === pickedStep) ?? steps.at(-1)
  const current = effectiveTab(tab, node.kind)
  const caps = stepCaps(run, shape, node.id, steps.at(-1))

  return (
    <section aria-label={`Panel del paso ${node.label}`} className="flex h-full min-h-0 flex-col overflow-hidden rounded-lg border bg-card">
      <header className="flex flex-col gap-1.5 border-b px-3 py-2.5">
        <div className="flex items-center gap-2">
          <h2 className="min-w-0 truncate font-mono text-[13px] font-medium">{node.label}</h2>
          {step ? <StepPills step={step} /> : null}
          <Hint label="Cerrar el panel" keys="Esc" side="bottom">
            <Button variant="ghost" size="icon-xs" className="ml-auto" aria-label="Cerrar el panel" onClick={onClose}>
              <X />
            </Button>
          </Hint>
        </div>
        {node.detail ? <p className="truncate font-mono text-xs text-muted-foreground">{node.detail}</p> : null}
        {step ? <StepActions run={run} step={steps.at(-1)!} label={node.label} caps={caps} /> : null}
      </header>

      {!step ? (
        node.kind === "join" ? (
          <EmptyNote title="Este join no tiene paso propio">Junta los resultados de las ramas con {node.detail}, dentro del cierre del parallel: su resultado está en el panel del parallel.</EmptyNote>
        ) : (
          <EmptyNote title="El flujo todavía no llega a este nodo">Cuando el paso parta aparecen aquí su transcript, su brief y su reporte.</EmptyNote>
        )
      ) : (
        <StepBody key={step.id} step={step} node={node} steps={steps} tab={current} onTab={onTab} pickedStep={pickedStep} onPickStep={setPickedStep} pickedSession={pickedSession} onPickSession={setPickedSession} />
      )}
    </section>
  )
}

// Lo que se le puede pedir al paso según su estado (los mismos casos que acepta el core). "Forzar resultado" solo
// existe en pasos action y wait: la decisión es no pisar nunca lo que un agente dijo.
function StepActions({ run, step, label, caps }: { run: RunDetail; step: Step; label: string; caps: StepCaps }) {
  const commands = useRunCommands()
  if (!caps.retry && !caps.interrupt && !caps.steer && caps.force.length === 0) return null
  return (
    <div className="flex flex-wrap items-center gap-1.5 pt-0.5">
      {caps.retry ? (
        <Hint
          label={caps.retry === "este" ? "Vuelve a correr este paso con una sesión nueva; lo que la corrida tenía en marcha se cancela" : "Vuelve a correr desde este paso con una sesión nueva: lo que vino después se cancela"}
          keys={step.status === "failed" ? "⇧⌘R" : undefined}
          side="bottom"
        >
          <Button size="xs" variant="outline" onClick={() => commands.retry(step.id, label)}>
            <RotateCcw /> {caps.retry === "este" ? "Reintentar" : "Reintentar desde acá"}
          </Button>
        </Hint>
      ) : null}
      {caps.interrupt ? (
        <Hint label="Detiene al agente con su sesión guardada y pausa la corrida" keys="⌘." side="bottom">
          <Button size="xs" variant="outline" onClick={() => commands.interrupt(run.id)}>
            <Square /> Interrumpir
          </Button>
        </Hint>
      ) : null}
      {caps.steer ? (
        <Hint label="Le deja un mensaje al agente y retoma su sesión con él" side="bottom">
          <Button size="xs" variant="outline" onClick={() => commands.steer(step.id, label)}>
            <MessageSquarePlus /> Mensaje al agente
          </Button>
        </Hint>
      ) : null}
      {caps.force.length > 0 ? (
        <DropdownMenu>
          <Hint label="El paso no se ejecuta y la corrida sigue por el edge del resultado que elijas. Queda registrado" side="bottom">
            <DropdownMenuTrigger asChild>
              <Button size="xs" variant="outline">
                <Zap /> Forzar resultado <ChevronDown />
              </Button>
            </DropdownMenuTrigger>
          </Hint>
          <DropdownMenuContent align="start" className="w-44">
            <DropdownMenuLabel className="text-xs text-muted-foreground">Resultados del nodo</DropdownMenuLabel>
            <DropdownMenuSeparator />
            {caps.force.map((outcome) => (
              <DropdownMenuItem key={outcome} className="font-mono text-[12.5px]" onSelect={() => commands.force(step.id, label, outcome)}>
                {outcome}
              </DropdownMenuItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>
      ) : null}
    </div>
  )
}

function StepPills({ step }: { step: Step }) {
  const look = stepLook(step.status)
  return (
    <>
      <Pill className={look.tone} hint={look.hint}>
        {look.label}
      </Pill>
      {step.outcome ? (
        <Pill className={tone.sky} hint="Resultado del paso: decide qué edge sigue el flujo.">
          {step.outcome}
        </Pill>
      ) : null}
    </>
  )
}

interface BodyProps extends Pick<Props, "node" | "tab" | "onTab"> {
  step: Step
  steps: Step[]
  pickedStep: StepRunId | null
  onPickStep: (id: StepRunId) => void
  pickedSession: string | null
  onPickSession: (id: string) => void
}

function StepBody({ step, node, steps, tab, onTab, onPickStep, pickedSession, onPickSession }: BodyProps) {
  const appData = useAppData()
  const detail = useLiveQuery(`step:${step.id}`, () => appData.step(step.id))
  const sessions = detail.data?.sessions ?? []
  const session = sessions.find((s) => s.id === pickedSession) ?? sessions.at(-1)
  const live = session?.status === "running"

  return (
    <Tabs value={tab} onValueChange={(value) => onTab(value as StepTab)} className="min-h-0 flex-1 gap-0">
      {steps.length > 1 || sessions.length > 1 ? (
        <div className="flex flex-wrap items-center gap-2 border-b px-3 py-2">
          {steps.length > 1 ? (
            <Picker label="Visita" value={step.id} onChange={(id) => onPickStep(id as StepRunId)} options={steps.map((s) => ({ value: s.id, label: stepLabel(s) }))} hint="El flujo pasó por este nodo más de una vez (una ronda de review, un reintento del flujo): elige cuál ver." />
          ) : null}
          {sessions.length > 1 ? (
            <Picker label="Intento" value={session?.id ?? ""} onChange={onPickSession} options={sessions.map((s, i) => ({ value: s.id, label: `intento ${i + 1} · ${s.status}` }))} hint="Cada intento del paso es una sesión de agente con su propio transcript." />
          ) : null}
        </div>
      ) : null}
      <TabsList className="mx-3 my-2 h-8 w-fit">
        {tabsOf(node.kind).map((t) => (
          <Hint key={t} label={LABEL[t].hint} keys={LABEL[t].keys} side="bottom">
            <TabsTrigger value={t} className="flex-none px-2.5 text-[13px]">
              {LABEL[t].label}
              {t === "attempts" && sessions.length > 1 ? <span className="text-xs text-muted-foreground tabular-nums">{sessions.length}</span> : null}
            </TabsTrigger>
          </Hint>
        ))}
      </TabsList>
      <div className="min-h-0 flex-1">
        {detail.error ? (
          <EmptyNote title="No pude leer el paso" action={<Button size="sm" variant="outline" onClick={detail.reload}>Reintentar</Button>}>
            {detail.error}
          </EmptyNote>
        ) : !detail.data ? (
          <p className="p-4 text-muted-foreground">Leyendo el paso…</p>
        ) : (
          <>
            <TabsContent value="transcript" className="h-full overflow-hidden">
              {session ? (
                <StepTranscript key={session.id} sessionId={session.id as AgentSessionId} live={live} />
              ) : (
                <EmptyNote title="Este paso todavía no abrió una sesión">{step.status === "pending" ? "Parte cuando el flujo llegue a este nodo." : "El agente aparece aquí apenas el core lo lanza."}</EmptyNote>
              )}
            </TabsContent>
            <TabsContent value="command" className="h-full overflow-y-auto">
              <CommandsSection detail={detail.data} step={step} />
            </TabsContent>
            <TabsContent value="brief" className="h-full overflow-y-auto">
              <BriefSection detail={detail.data} session={session} step={step} />
            </TabsContent>
            <TabsContent value="report" className="h-full overflow-y-auto">
              <ReportSection detail={detail.data} session={session} step={step} />
            </TabsContent>
            <TabsContent value="artifacts" className="h-full overflow-y-auto">
              <ArtifactsSection detail={detail.data} />
            </TabsContent>
            <TabsContent value="attempts" className="h-full overflow-y-auto">
              <AttemptsSection
                step={step}
                sessions={sessions}
                picked={session?.id}
                onPick={(id) => {
                  onPickSession(id)
                  onTab("transcript")
                }}
              />
            </TabsContent>
          </>
        )}
      </div>
    </Tabs>
  )
}

function Picker({ label, value, onChange, options, hint }: { label: string; value: string; onChange: (value: string) => void; options: { value: string; label: string }[]; hint: string }) {
  return (
    <Hint label={hint}>
      <div className="flex items-center gap-1.5">
        <span className="text-xs text-muted-foreground">{label}</span>
        <Select value={value} onValueChange={onChange}>
          <SelectTrigger size="sm" aria-label={label} className="h-7 text-xs">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {options.map((o) => (
              <SelectItem key={o.value} value={o.value} className="text-xs">
                {o.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
    </Hint>
  )
}

import type { Edge, FlowDef, Node, Role, Value } from "@clanker/api"
import { Plus, Trash2, X } from "lucide-react"
import { type ReactNode, useId, useState } from "react"
import { KIND } from "@/components/graph/flow-node"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { branchOwners, edgeSpec, END_NAME, ENDS, type Mark, NODE_SUMMARY, outcomesOf, withEdge } from "@/lib/flow-canvas"
import { messageOf } from "@/lib/utils"

const SELECT = "h-9 w-full min-w-0 rounded-md border border-input bg-transparent px-2 text-sm shadow-xs outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 dark:bg-input/30"

function Field({ label, help, children }: { label: string; help: string; children: (id: string) => ReactNode }) {
  const id = useId()
  return (
    <div className="flex flex-col gap-1">
      <label htmlFor={id} className="text-[13px] font-medium">
        {label}
      </label>
      {children(id)}
      <p className="text-xs text-pretty text-muted-foreground">{help}</p>
    </div>
  )
}

/** Un valor JSON de un campo (brief, args, params). Lo que no se lee todavía queda en el borrador y no toca el flujo. */
function JsonField({ label, help, value, onChange }: { label: string; help: string; value: unknown; onChange: (value: Record<string, Value>) => void }) {
  const [draft, setDraft] = useState(JSON.stringify(value, null, 2))
  const [error, setError] = useState<string | null>(null)
  const change = (text: string) => {
    setDraft(text)
    try {
      const parsed: unknown = JSON.parse(text)
      if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) throw new Error("tiene que ser un objeto, entre llaves { }")
      setError(null)
      onChange(parsed as Record<string, Value>)
    } catch (e) {
      setError(messageOf(e))
    }
  }
  return (
    <Field label={label} help={help}>
      {(id) => (
        <>
          <textarea id={id} value={draft} onChange={(e) => change(e.target.value)} spellCheck={false} rows={4} aria-invalid={error !== null} className="w-full rounded-md border border-input bg-transparent p-2 font-mono text-xs shadow-xs outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50 aria-invalid:border-destructive" />
          {error ? <p className="text-xs text-destructive">No se puede leer: {error}. El flujo sigue con el último valor válido.</p> : null}
        </>
      )}
    </Field>
  )
}

const TextField = ({ label, help, value, onChange, list }: { label: string; help: string; value: string; onChange: (value: string) => void; list?: string[] }) => {
  const listId = useId()
  return (
    <Field label={label} help={help}>
      {(id) => (
        <>
          <Input id={id} value={value} onChange={(e) => onChange(e.target.value)} list={list ? listId : undefined} className="font-mono text-xs md:text-xs" />
          {list ? <datalist id={listId}>{list.map((v) => <option key={v} value={v} />)}</datalist> : null}
        </>
      )}
    </Field>
  )
}

const OptionalNumber = ({ label, help, value, onChange }: { label: string; help: string; value: number | undefined; onChange: (value: number | undefined) => void }) => (
  <Field label={label} help={help}>
    {(id) => <Input id={id} type="number" min={1} value={value ?? ""} onChange={(e) => onChange(e.target.value === "" ? undefined : Math.max(1, Math.floor(Number(e.target.value))))} />}
  </Field>
)

interface Props {
  id: string
  node: Node
  flow: FlowDef
  roles: ReadonlyMap<string, Role>
  /** Los ids de los flujos que un paso `flow` puede correr. */
  flows: readonly string[]
  /** Las acciones y los eventos que ya usan tus flujos: sugerencias, el core valida el resto. */
  actions: readonly string[]
  events: readonly string[]
  marks: readonly Mark[]
  onChange: (node: Node) => void
  onStart: () => void
  onRemove: () => void
}

/**
 * Las propiedades del paso elegido, cada campo con una línea que dice para qué sirve. Cambia el mismo `FlowDef` que
 * el JSON: aquí solo están los campos que una persona toca a diario; el resto (`retry`, `resumeFrom`, `escalate`...)
 * se edita en la pestaña JSON y el canvas lo respeta.
 */
export function NodePanel({ id, node, flow, roles, flows, actions, events, marks, onChange, onStart, onRemove }: Props) {
  const { Icon } = KIND[node.type]
  const owner = branchOwners(flow).get(id)
  const set = (patch: Partial<Node>) => onChange({ ...node, ...patch } as Node)
  const targets = Object.keys(flow.nodes).filter((n) => !branchOwners(flow).has(n))
  const outcomes = owner ? [] : outcomesOf(node, roles)

  return (
    <aside aria-label={`Propiedades de ${id}`} className="flex flex-col gap-4">
      <header className="flex flex-col gap-1">
        <div className="flex items-center gap-2">
          <Icon className="size-4 flex-none text-muted-foreground" />
          <h3 className="min-w-0 flex-1 truncate font-mono text-sm font-medium">{id}</h3>
          <Button size="icon-sm" variant="ghost" aria-label={`Eliminar ${id}`} onClick={onRemove}>
            <Trash2 />
          </Button>
        </div>
        <p className="text-xs text-muted-foreground">
          {node.type}: {NODE_SUMMARY[node.type]}.
        </p>
        {flow.start === id ? (
          <p className="text-xs text-muted-foreground">Es el paso inicial: la corrida empieza aquí.</p>
        ) : owner ? null : (
          <Button size="xs" variant="secondary" className="self-start" onClick={onStart}>
            Hacer paso inicial
          </Button>
        )}
      </header>

      {marks.length > 0 ? (
        <ul aria-label="Problemas de este paso" className="flex flex-col gap-1 rounded-md border border-destructive/40 p-2 text-xs">
          {marks.map((m, i) => (
            <li key={i} className={m.tone === "error" ? "text-destructive" : "text-amber-700 dark:text-amber-300"}>
              {m.message}
            </li>
          ))}
        </ul>
      ) : null}

      {node.type === "agent" ? (
        <>
          <Field label="Rol" help="Quién hace el trabajo: sus instrucciones base y los modos en que puede trabajar.">
            {(fid) => (
              <select
                id={fid}
                value={node.role}
                className={SELECT}
                onChange={(e) => set({ role: e.target.value, mode: Object.keys(roles.get(e.target.value)?.modes ?? {})[0] ?? node.mode })}
              >
                {[...new Set([node.role, ...roles.keys()])].map((r) => (
                  <option key={r}>{r}</option>
                ))}
              </select>
            )}
          </Field>
          <Field label="Modo" help="Qué le pides al rol aquí. Cada modo termina con sus propios resultados (las salidas de abajo).">
            {(fid) => {
              const modes = Object.keys(roles.get(node.role)?.modes ?? {})
              return (
                <select id={fid} value={node.mode} className={SELECT} onChange={(e) => set({ mode: e.target.value })}>
                  {[...new Set([node.mode, ...modes])].map((m) => (
                    <option key={m}>{m}</option>
                  ))}
                </select>
              )
            }}
          </Field>
          <TextField
            label="Entrada del perfil"
            help="Con qué runtime y modelo corre este paso: el nombre de una entrada del perfil del proyecto (por ejemplo review-bugs-opencode). Vacío: la del rol."
            value={node.profileRole ?? ""}
            onChange={(value) => {
              const next = { ...node, profileRole: value.trim() }
              if (next.profileRole === "") delete (next as Partial<typeof next>).profileRole
              onChange(next)
            }}
          />
          <JsonField label="Brief" help="Lo que se le entrega al agente, como JSON. Un valor que empieza con $ (como $plan.files) toma el resultado de un paso anterior." value={node.brief} onChange={(brief) => set({ brief })} />
        </>
      ) : null}

      {node.type === "action" ? (
        <>
          <TextField label="Acción" help="Qué código de la app corre, por ejemplo workspace.acquire. El core avisa si no existe." value={node.action} list={[...actions]} onChange={(action) => set({ action })} />
          <JsonField label="Argumentos" help="Los datos que recibe la acción, como JSON." value={node.args} onChange={(args) => set({ args })} />
        </>
      ) : null}

      {node.type === "wait" ? (
        <>
          <TextField label="Evento" help="Qué espera el paso (por ejemplo pr.ci). Mientras espera no ocupa un agente." value={node.event} list={[...events]} onChange={(event) => set({ event })} />
          <JsonField label="Argumentos" help="Los datos con que se espera el evento, como JSON." value={node.args} onChange={(args) => set({ args })} />
        </>
      ) : null}

      {node.type === "flow" ? (
        <>
          <Field label="Flujo que corre" help="El flujo hijo: corre completo y este paso sigue con cómo terminó (done, blocked o failed).">
            {(fid) => (
              <select id={fid} value={node.flow} className={SELECT} onChange={(e) => set({ flow: e.target.value })}>
                {[...new Set([node.flow, ...flows])].map((f) => (
                  <option key={f}>{f}</option>
                ))}
              </select>
            )}
          </Field>
          {typeof node.params === "string" ? null : <JsonField label="Parámetros" help="Lo que se le pasa al flujo hijo, como JSON. Debe incluir los params que el hijo no trae por defecto." value={node.params} onChange={(params) => set({ params })} />}
        </>
      ) : null}

      {node.type === "gate" ? <GateFields node={node} onChange={onChange} /> : null}

      {node.type === "parallel" ? <ParallelFields node={node} flow={flow} id={id} onChange={onChange} /> : null}

      <OptionalNumber label="Tiempo máximo (segundos)" help="Si el paso tarda más, termina con el resultado timeout. Vacío: sin límite propio." value={node.timeoutSec} onChange={(timeoutSec) => set({ timeoutSec })} />

      {owner ? (
        <p className="text-xs text-muted-foreground">Es una rama del parallel `{owner}`: no tiene salidas propias. El parallel sigue con el resultado de juntar todas.</p>
      ) : (
        <section aria-label="Salidas" className="flex flex-col gap-2">
          <h4 className="text-[13px] font-medium">Salidas</h4>
          <p className="text-xs text-muted-foreground">Cada resultado del paso sigue una salida. También se conectan arrastrando desde su punto, abajo del nodo, hasta otro paso.</p>
          {outcomes.map((outcome) => (
            <OutcomeRow key={outcome} outcome={outcome} edge={node.on?.[outcome]} targets={targets} onChange={(edge) => onChange(withEdge(node, outcome, edge))} />
          ))}
          <AddOutcome existing={outcomes} onAdd={(outcome) => onChange(withEdge(node, outcome, "@done"))} />
        </section>
      )}
    </aside>
  )
}

function DestinationSelect({ value, targets, onChange, id, label }: { value: string; targets: readonly string[]; onChange: (to: string) => void; id?: string; label: string }) {
  return (
    <select id={id} aria-label={label} value={value} className={SELECT} onChange={(e) => onChange(e.target.value)}>
      {value === "" ? <option value="">sin destino</option> : null}
      {targets.map((t) => (
        <option key={t} value={t}>
          {t}
        </option>
      ))}
      {ENDS.map((e) => (
        <option key={e} value={e}>
          terminar: {END_NAME[e]}
        </option>
      ))}
    </select>
  )
}

function OutcomeRow({ outcome, edge, targets, onChange }: { outcome: string; edge: Edge | undefined; targets: readonly string[]; onChange: (edge: Edge | undefined) => void }) {
  const spec = edge === undefined ? null : edgeSpec(edge)
  const rounds = spec?.maxRounds
  return (
    <div className="flex flex-col gap-1.5 rounded-md border p-2">
      <div className="flex items-center gap-2">
        <span className="min-w-0 flex-1 truncate font-mono text-xs">{outcome}</span>
        {edge !== undefined ? (
          <Button size="icon-sm" variant="ghost" aria-label={`Quitar la salida ${outcome}`} onClick={() => onChange(undefined)}>
            <X />
          </Button>
        ) : null}
      </div>
      <DestinationSelect label={`Destino de ${outcome}`} value={spec?.to ?? ""} targets={targets} onChange={(to) => onChange(spec ? { ...spec, to } : to)} />
      {spec ? (
        <>
          <label className="flex items-center gap-2 text-xs">
            <span className="flex-none">Rondas máximas</span>
            <Input
              aria-label={`Rondas máximas de ${outcome}`}
              value={rounds ?? ""}
              placeholder="sin tope"
              className="h-7 text-xs md:text-xs"
              onChange={(e) => {
                const text = e.target.value.trim()
                const maxRounds = /^\d+$/.test(text) && Number(text) > 0 ? Number(text) : text.startsWith("$") && text.length > 1 ? (text as `$${string}`) : undefined
                onChange(maxRounds === undefined ? { to: spec.to, note: spec.note } : { ...spec, maxRounds, exhausted: spec.exhausted ?? "@blocked" })
              }}
            />
          </label>
          <p className="text-xs text-muted-foreground">Cuántas veces se puede volver por esta salida (un número, o un param como $run.params.reviewRounds). Vacío: sin tope.</p>
          {rounds !== undefined ? (
            <>
              <DestinationSelect label={`Al agotarse, ${outcome} va a`} value={typeof spec.exhausted === "object" ? spec.exhausted.to : (spec.exhausted ?? "@blocked")} targets={targets} onChange={(to) => onChange({ ...spec, exhausted: typeof spec.exhausted === "object" ? { ...spec.exhausted, to } : to })} />
              <p className="text-xs text-muted-foreground">A dónde va el flujo cuando ya se tomó el máximo de veces.</p>
            </>
          ) : null}
        </>
      ) : (
        <p className="text-xs text-muted-foreground">Sin destino: el flujo no sabe qué hacer con este resultado. Elige un paso o arrastra el punto del nodo.</p>
      )}
    </div>
  )
}

function AddOutcome({ existing, onAdd }: { existing: readonly string[]; onAdd: (outcome: string) => void }) {
  const [name, setName] = useState("")
  const taken = existing.includes(name.trim())
  return (
    <form
      className="flex items-center gap-2"
      onSubmit={(e) => {
        e.preventDefault()
        if (name.trim() && !taken) {
          onAdd(name.trim())
          setName("")
        }
      }}
    >
      <Input aria-label="Nombre de la salida nueva" placeholder="otro resultado, p. ej. fail" value={name} onChange={(e) => setName(e.target.value)} className="h-8 font-mono text-xs md:text-xs" />
      <Button size="sm" variant="secondary" type="submit" disabled={!name.trim() || taken}>
        <Plus /> Agregar salida
      </Button>
    </form>
  )
}

function GateFields({ node, onChange }: { node: Extract<Node, { type: "gate" }>; onChange: (node: Node) => void }) {
  const set = (patch: Partial<typeof node>) => onChange({ ...node, ...patch })
  const setOption = (i: number, patch: Partial<(typeof node.options)[number]>) => set({ options: node.options.map((o, j) => (j === i ? { ...o, ...patch } : o)) })
  return (
    <>
      <TextField label="Pregunta" help="Lo que ves cuando el flujo se detiene a esperarte." value={typeof node.question === "string" ? node.question : JSON.stringify(node.question)} onChange={(question) => set({ question })} />
      <section aria-label="Opciones" className="flex flex-col gap-2">
        <h4 className="text-[13px] font-medium">Opciones</h4>
        <p className="text-xs text-muted-foreground">Cada opción es un botón de la decisión y una salida del paso.</p>
        {node.options.map((o, i) => (
          <div key={i} className="flex items-center gap-1.5">
            <Input aria-label={`Id de la opción ${i + 1}`} value={o.id} onChange={(e) => setOption(i, { id: e.target.value })} className="h-8 w-24 font-mono text-xs md:text-xs" />
            <Input aria-label={`Texto de la opción ${i + 1}`} value={o.label} onChange={(e) => setOption(i, { label: e.target.value })} className="h-8 text-xs md:text-xs" />
            <Button size="icon-sm" variant="ghost" aria-label={`Quitar la opción ${o.id}`} disabled={node.options.length === 1} onClick={() => set({ options: node.options.filter((_, j) => j !== i) })}>
              <X />
            </Button>
          </div>
        ))}
        <Button size="sm" variant="secondary" className="self-start" onClick={() => set({ options: [...node.options, { id: `opcion${node.options.length + 1}`, label: "Otra opción" }] })}>
          <Plus /> Agregar opción
        </Button>
      </section>
      <Field label="Si nadie responde" help="La opción que se toma sola al vencer el tiempo máximo. Vacío: espera hasta que decidas.">
        {(id) => (
          <select id={id} value={node.default ?? ""} className={SELECT} onChange={(e) => set({ default: e.target.value || undefined })}>
            <option value="">ninguna</option>
            {node.options.map((o) => (
              <option key={o.id}>{o.id}</option>
            ))}
          </select>
        )}
      </Field>
    </>
  )
}

function ParallelFields({ node, flow, id, onChange }: { node: Extract<Node, { type: "parallel" }>; flow: FlowDef; id: string; onChange: (node: Node) => void }) {
  const owners = branchOwners(flow)
  const set = (patch: Partial<typeof node>) => onChange({ ...node, ...patch })
  if (!Array.isArray(node.branches)) return <p className="text-xs text-muted-foreground">Este parallel crea una rama por ítem de una lista (forEach): se edita en la pestaña JSON.</p>
  const branches = node.branches
  const free = Object.keys(flow.nodes).filter((n) => n !== id && !owners.has(n) && n !== flow.start && flow.nodes[n]!.type !== "parallel")
  return (
    <>
      <section aria-label="Ramas" className="flex flex-col gap-2">
        <h4 className="text-[13px] font-medium">Ramas</h4>
        <p className="text-xs text-muted-foreground">Los pasos que corren a la vez. El parallel espera a todos y sigue con el peor resultado, salvo que elijas otra forma de juntarlos.</p>
        {branches.map((b) => (
          <div key={b} className="flex items-center gap-2 rounded-md border px-2 py-1">
            <span className="min-w-0 flex-1 truncate font-mono text-xs">{b}</span>
            <Button size="icon-sm" variant="ghost" aria-label={`Quitar la rama ${b}`} disabled={branches.length === 1} onClick={() => set({ branches: branches.filter((x) => x !== b) })}>
              <X />
            </Button>
          </div>
        ))}
        {free.length > 0 ? (
          <select aria-label="Agregar una rama" value="" className={SELECT} onChange={(e) => e.target.value && set({ branches: [...branches, e.target.value] })}>
            <option value="">agregar un paso como rama…</option>
            {free.map((n) => (
              <option key={n}>{n}</option>
            ))}
          </select>
        ) : (
          <p className="text-xs text-muted-foreground">Para sumar una rama, agrega primero un paso suelto desde la paleta.</p>
        )}
      </section>
      {typeof node.join === "object" ? (
        <p className="text-xs text-muted-foreground">Cómo se juntan las ramas ya está configurado a mano: se edita en la pestaña JSON.</p>
      ) : (
        <TextField label="Cómo se juntan" help="La función que resume los resultados de las ramas. Vacío: worst, el peor de todos." value={node.join ?? ""} onChange={(join) => set({ join: join || undefined })} />
      )}
    </>
  )
}


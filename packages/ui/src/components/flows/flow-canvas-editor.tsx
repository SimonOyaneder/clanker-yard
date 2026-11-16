import { type DefIssue, FlowDef, type Node, Role } from "@clanker/api"
import { Background, BackgroundVariant, Controls, type Connection, type Edge as FlowEdgeType, MarkerType, type NodeChange, ReactFlow, ReactFlowProvider, type EdgeChange } from "@xyflow/react"
import "@xyflow/react/dist/style.css"
import { LayoutGrid } from "lucide-react"
import { useMemo, useRef, useState } from "react"
import { useAppData } from "@/app-data"
import { CanvasNode, type CanvasFlowNode } from "@/components/flows/canvas-node"
import { NodePanel } from "@/components/flows/node-panel"
import { Hint } from "@/components/common"
import { FlowEdge } from "@/components/project/flow-edge"
import { KIND } from "@/components/project/flow-node"
import { Button } from "@/components/ui/button"
import { useColorMode } from "@/hooks/use-color-mode"
import { useLiveQuery } from "@/hooks/use-live"
import { addStep, branchOwners, connect, edgeSpec, ENDS, marksOf, NODE_SUMMARY, NODE_TYPES, outcomesOf, type Point, positionsOf, removeNodes, setNode, setStart, usedValues, withEdge } from "@/lib/flow-canvas"
import { describePath, plain } from "@/lib/def-edit"
import { readPref, writePref } from "@/lib/prefs"
import { shapeOf } from "@/lib/run-graph"

const nodeTypes = { step: CanvasNode }
const edgeTypes = { flow: FlowEdge }
const DELETE_KEYS = ["Backspace", "Delete"]
const SCOPE_RANK = { builtin: 0, pack: 1, repo: 2, user: 3 } as const

interface Props {
  /** El flujo que se edita: las posiciones de sus nodos se guardan por él, fuera del body (mover un nodo no crea una versión). */
  defId: string
  flow: FlowDef
  onChange: (flow: FlowDef) => void
  /** Lo que `defs.update` con `dryRun` dice del flujo tal como está: se marca en el nodo o la salida que corresponde. */
  errors: readonly DefIssue[]
  warnings: readonly DefIssue[]
}

/**
 * El segundo modo de edición del mismo body que el editor de JSON: cada paso es un nodo, cada outcome un handle de
 * salida, y cada gesto (agregar, conectar, borrar, cambiar un campo) devuelve un `FlowDef` nuevo por `onChange`.
 * Quien lo usa valida y guarda como con el JSON.
 */
export function FlowCanvasEditor(props: Props) {
  return (
    <ReactFlowProvider>
      <Editor {...props} />
    </ReactFlowProvider>
  )
}

function Editor({ defId, flow, onChange, errors, warnings }: Props) {
  const appData = useAppData()
  const colorMode = useColorMode()
  const roleDefs = useLiveQuery("library:role", () => appData.defs("role", { includeArchived: true }))
  const flowDefs = useLiveQuery("library:flow", () => appData.defs("flow", { includeArchived: true }))
  const layoutKey = `flow-layout.${defId}`
  const [saved, setSaved] = useState<Record<string, Point>>(() => readPref(layoutKey, {}))
  const [selection, setSelection] = useState<{ nodes: string[]; edges: string[] }>({ nodes: [], edges: [] })

  // El rol que manda es el más cercano al usuario, como en la biblioteca.
  const roles = useMemo(() => {
    const found = new Map<string, { role: Role; rank: number }>()
    for (const d of roleDefs.data ?? []) {
      const role = Role.safeParse(d.body)
      const rank = SCOPE_RANK[d.scope as keyof typeof SCOPE_RANK] ?? 0
      if (d.archivedAt === null && role.success && rank >= (found.get(d.slug)?.rank ?? -1)) found.set(d.slug, { role: role.data, rank })
    }
    return new Map([...found].map(([slug, { role }]) => [slug, role]))
  }, [roleDefs.data])
  const library = useMemo(() => (flowDefs.data ?? []).flatMap((d) => (d.archivedAt === null && d.slug !== flow.id ? [{ slug: d.slug, flow: FlowDef.safeParse(d.body) }] : [])).flatMap((d) => (d.flow.success ? [{ slug: d.slug, flow: d.flow.data }] : [])), [flowDefs.data, flow.id])
  const hints = useMemo(() => {
    const first = roles.entries().next().value
    const actions = usedValues(library.map((l) => l.flow), "action")
    const events = usedValues(library.map((l) => l.flow), "event")
    return { role: first?.[0] ?? "dev", mode: Object.keys(first?.[1].modes ?? {})[0] ?? "plan", action: actions[0] ?? "workspace.acquire", event: events[0] ?? "pr.ci", flow: library[0]?.slug ?? "", actions, events }
  }, [roles, library])

  // Dos gestos en el mismo tick (borrar un nodo y sus edges) parten del flujo que dejó el primero.
  const latest = useRef(flow)
  latest.current = flow
  const apply = (change: (current: FlowDef) => FlowDef) => {
    latest.current = change(latest.current)
    onChange(latest.current)
  }

  const positions = useMemo(() => positionsOf(flow, saved), [flow, saved])
  const savedRef = useRef(saved)
  savedRef.current = saved
  const place = (next: Record<string, Point>) => {
    savedRef.current = next
    setSaved(next)
    writePref(layoutKey, next)
  }
  // Al mover un nodo (o sumar uno) se fijan todos donde están: el acomodo automático no los vuelve a mover.
  const frozen = () => ({ ...Object.fromEntries(positions), ...savedRef.current })

  const marks = useMemo(() => marksOf(errors, warnings), [errors, warnings])
  const owners = useMemo(() => branchOwners(flow), [flow])
  const details = useMemo(() => new Map(shapeOf(flow).nodes.map((n) => [n.id, n.detail])), [flow])

  const nodes = useMemo<CanvasFlowNode[]>(() => {
    const steps = Object.entries(flow.nodes).map(([id, node]): CanvasFlowNode => {
      const outcomes = owners.has(id) ? [] : outcomesOf(node, roles)
      return {
        id,
        type: "step",
        position: positions.get(id)!,
        selected: selection.nodes.includes(id),
        data: {
          id,
          type: node.type,
          detail: details.get(id) ?? null,
          isStart: flow.start === id,
          branch: owners.has(id),
          outcomes: outcomes.map((name) => ({ name, connected: node.on?.[name] !== undefined })),
          marks: marks.nodes.get(id) ?? [],
          badOutcomes: outcomes.filter((name) => marks.edges.has(`${id}:${name}`)),
        },
      }
    })
    const ends = ENDS.map((id): CanvasFlowNode => ({ id, type: "step", position: positions.get(id)!, selected: selection.nodes.includes(id), deletable: false, data: { id, type: "end", detail: null, isStart: false, branch: false, outcomes: [], marks: [], badOutcomes: [] } }))
    return [...steps, ...ends]
  }, [flow, owners, roles, positions, selection.nodes, details, marks])

  const edges = useMemo(() => {
    const known = new Set(nodes.map((n) => n.id))
    const out: FlowEdgeType[] = []
    const add = (id: string, source: string, target: string, handle: string | undefined, label: string | null, extra: { deletable: boolean; dashed?: boolean; bad?: boolean }) => {
      if (!known.has(target)) return
      const color = extra.bad ? "var(--destructive)" : "var(--muted-foreground)"
      out.push({
        id,
        type: "flow",
        source,
        target,
        sourceHandle: handle,
        selected: selection.edges.includes(id),
        deletable: extra.deletable,
        data: { label, curved: false, back: false },
        style: { stroke: color, strokeWidth: 1.25, strokeDasharray: extra.dashed ? "5 4" : undefined },
        markerEnd: { type: MarkerType.ArrowClosed, color, width: 14, height: 14 },
      })
    }
    for (const [id, node] of Object.entries(flow.nodes)) {
      if (node.type === "parallel" && Array.isArray(node.branches)) for (const b of node.branches) add(`${id}>${b}`, id, b, "branches", null, { deletable: false, dashed: true })
      for (const [outcome, edge] of Object.entries(node.on ?? {})) {
        const spec = edgeSpec(edge)
        const key = `${id}:${outcome}`
        const bad = marks.edges.has(key)
        const rounds = typeof spec.maxRounds === "number" ? `hasta ${spec.maxRounds}` : typeof spec.maxRounds === "string" ? `hasta ${spec.maxRounds.replace("$run.params.", "")}` : null
        const label = [outcome === "ok" ? null : outcome, rounds].filter(Boolean).join(" ") || null
        add(key, id, spec.to, outcome, label, { deletable: true, bad })
        if (spec.exhausted !== undefined) add(`${key}:exhausted`, id, edgeSpec(spec.exhausted).to, outcome, "agotado", { deletable: false, dashed: true, bad })
      }
    }
    return out
  }, [flow, nodes, selection.edges, marks])

  const onNodesChange = (changes: NodeChange<CanvasFlowNode>[]) => {
    for (const c of changes) {
      if (c.type === "position" && c.position) place({ ...frozen(), [c.id]: c.position })
      else if (c.type === "select") setSelection((s) => ({ ...s, nodes: c.selected ? [...s.nodes.filter((n) => n !== c.id), c.id] : s.nodes.filter((n) => n !== c.id) }))
    }
  }
  const onEdgesChange = (changes: EdgeChange[]) => {
    for (const c of changes) if (c.type === "select") setSelection((s) => ({ ...s, edges: c.selected ? [...s.edges.filter((e) => e !== c.id), c.id] : s.edges.filter((e) => e !== c.id) }))
  }
  const onConnect = ({ source, sourceHandle, target }: Connection) => apply((f) => connect(f, source, sourceHandle ?? "ok", target))

  const add = (type: Node["type"]) => {
    const added = addStep(latest.current, type, hints)
    const all = frozen()
    const below = Math.max(0, ...Object.values(all).map((p) => p.y)) + 120
    place({ ...all, ...Object.fromEntries(added.ids.map((id, i) => [id, { x: 24 + i * 304, y: below }])) })
    latest.current = added.flow
    onChange(added.flow)
    setSelection({ nodes: [added.ids[0]!], edges: [] })
  }

  const selectedId = selection.nodes.length === 1 ? selection.nodes[0]! : null
  const selectedNode = selectedId ? flow.nodes[selectedId] : undefined
  const select = (id: string) => setSelection({ nodes: [id], edges: [] })

  return (
    <div className="flex flex-col gap-3">
      <section aria-label="Paleta de pasos" className="flex flex-col gap-1.5">
        <div className="flex items-center justify-between gap-2">
          <h3 className="text-[13px] font-medium">Agregar un paso</h3>
          <Hint label="Vuelve a acomodar todos los pasos como al abrir. La posición que tenían se pierde.">
            <Button size="sm" variant="secondary" onClick={() => place({})}>
              <LayoutGrid /> Ordenar solo
            </Button>
          </Hint>
        </div>
        <div className="grid grid-cols-3 gap-1.5">
          {NODE_TYPES.map((type) => {
            const { Icon } = KIND[type]
            return (
              <button key={type} type="button" onClick={() => add(type)} className="flex items-start gap-2 rounded-md border p-2 text-left hover:bg-accent focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:outline-none">
                <Icon className="mt-0.5 size-4 flex-none text-muted-foreground" aria-hidden />
                <span className="flex min-w-0 flex-col">
                  <span className="font-mono text-xs">{type}</span>
                  <span className="text-[11px] text-pretty text-muted-foreground">{NODE_SUMMARY[type]}</span>
                </span>
              </button>
            )
          })}
        </div>
        <p className="text-xs text-muted-foreground">Arrastra el punto de una salida (abajo de cada paso) hasta otro paso para conectarlos. Con un paso o una línea elegidos, Suprimir o Retroceso los borra.</p>
      </section>

      <div className="grid h-[600px] grid-cols-[minmax(0,1fr)_288px] overflow-hidden rounded-lg border">
        <div role="group" aria-label={`Canvas del flujo ${flow.id}`} className="min-h-0 min-w-0 border-r">
          <ReactFlow
            nodes={nodes}
            edges={edges}
            nodeTypes={nodeTypes}
            edgeTypes={edgeTypes}
            colorMode={colorMode}
            fitView
            fitViewOptions={{ padding: 0.1, maxZoom: 1 }}
            minZoom={0.2}
            maxZoom={1.5}
            deleteKeyCode={DELETE_KEYS}
            onNodesChange={onNodesChange}
            onEdgesChange={onEdgesChange}
            onConnect={onConnect}
            onNodesDelete={(deleted) => apply((f) => removeNodes(f, deleted.map((n) => n.id)))}
            onEdgesDelete={(deleted) =>
              apply((f) =>
                deleted.reduce((acc, e) => {
                  const node = acc.nodes[e.source]
                  return node && e.sourceHandle ? setNode(acc, e.source, withEdge(node, e.sourceHandle, undefined)) : acc
                }, f),
              )
            }
            onPaneClick={() => setSelection({ nodes: [], edges: [] })}
            proOptions={{ hideAttribution: true }}
            className="cc-flow"
          >
            <Background variant={BackgroundVariant.Dots} gap={18} size={1} />
            <Controls position="bottom-right" showInteractive={false} />
          </ReactFlow>
        </div>

        <div className="overflow-y-auto p-3">
          {selectedId && selectedNode ? (
            <NodePanel
              key={selectedId}
              id={selectedId}
              node={selectedNode}
              flow={flow}
              roles={roles}
              flows={library.map((l) => l.slug)}
              actions={hints.actions}
              events={hints.events}
              marks={marks.nodes.get(selectedId) ?? []}
              onChange={(next) => apply((f) => setNode(f, selectedId, next))}
              onStart={() => apply((f) => setStart(f, selectedId))}
              onRemove={() => {
                apply((f) => removeNodes(f, [selectedId]))
                setSelection({ nodes: [], edges: [] })
              }}
            />
          ) : (
            <div className="flex flex-col gap-2 text-[13px] text-muted-foreground">
              <p className="font-medium text-foreground">Propiedades</p>
              <p>Elige un paso para cambiar su rol, su brief, sus rondas máximas y a dónde va según cada resultado.</p>
              <p>Cada campo dice para qué sirve. Mover un paso no crea una versión: solo guardar los cambios del flujo la crea.</p>
            </div>
          )}
        </div>
      </div>

      <Problems errors={errors} warnings={warnings} onSelect={select} />
    </div>
  )
}

/** Todo lo que el core objeta, en claro; un clic lleva al paso del que habla. */
export function Problems({ errors, warnings, onSelect }: { errors: readonly DefIssue[]; warnings: readonly DefIssue[]; onSelect: (id: string) => void }) {
  if (errors.length === 0 && warnings.length === 0) return null
  const row = (issue: DefIssue, tone: "error" | "warning") => {
    const step = /^nodes\.([^.]+)/.exec(issue.path)?.[1]
    const text = `${describePath("flow", issue.path)}: ${plain(issue.message)}`
    return (
      <li key={`${tone}:${issue.path}:${issue.message}`} className={tone === "error" ? "text-destructive" : "text-amber-700 dark:text-amber-300"}>
        {step ? (
          <button type="button" className="text-left underline-offset-2 hover:underline" onClick={() => onSelect(step)}>
            {text}
          </button>
        ) : (
          text
        )}
      </li>
    )
  }
  return (
    <ul aria-label="Problemas por arreglar" className="flex flex-col gap-1 rounded-lg border p-3 text-[13px]">
      {errors.map((e) => row(e, "error"))}
      {warnings.map((w) => row(w, "warning"))}
    </ul>
  )
}

import * as z from "zod";

// El formato de un flujo: `docs/design.html#d-flows`, "1. Esquema de un flujo".
// Este archivo solo valida la forma. Que las referencias existan, que no haya ciclos sin tope o
// que un outcome tenga edge depende de lo que registran otros módulos, y lo valida `flows.validate`.

const IDENTIFIER = /^[A-Za-z][\w-]*$/;

/** Id de un nodo, de un flujo o de un rol. No lleva puntos: un ref navega con ellos. */
export const NodeId = z.string().regex(IDENTIFIER);
export type NodeId = z.infer<typeof NodeId>;

/** `$plan.files`, `$prev`, `$self`, `$item`, `$run.params.base`: el valor entero, sin interpolación. */
export const Ref = z.templateLiteral(["$", z.string().regex(/^[A-Za-z][\w-]*(\.[\w-]+)*$/)]);
export type Ref = z.infer<typeof Ref>;

export function isRef(value: unknown): value is Ref {
  return Ref.safeParse(value).success;
}

export const End = z.enum(["@done", "@blocked", "@failed"]);
export type End = z.infer<typeof End>;

/** Un valor JSON; los strings que son un `Ref` se resuelven al ejecutar el paso. */
export const Value = z.json();
export type Value = z.infer<typeof Value>;

const Target = z.union([End, NodeId]);
const Outcome = z.string().min(1);

const edgeError = "una arista es un id de nodo, un @done/@blocked/@failed o un objeto { to, ... }";

export const Edge = z.union(
  [
    Target,
    z.strictObject({
      /** Destino al tomar el edge. */
      to: Target,
      /** Deja una decisión no bloqueante al tomarlo. */
      note: z.string().optional(),
      /** Cuántas veces se puede tomar: un número o un `$run.params.x`. Exige `exhausted`. */
      maxRounds: z.union([z.int().positive(), Ref]).optional(),
      /** Rondas compartidas entre edges con el mismo contador. */
      counter: z.string().min(1).optional(),
      /** Destino cuando ya se tomó `maxRounds` veces. */
      exhausted: z.union([Target, z.strictObject({ to: Target, note: z.string() })]).optional(),
    }),
  ],
  { error: edgeError },
);
export type Edge = z.infer<typeof Edge>;

const Retry = z.strictObject({
  max: z.int().nonnegative(),
  backoffSec: z.array(z.number().nonnegative()),
});

const common = {
  /** Un handle por outcome. Las ramas de un parallel no tienen `on`. */
  on: z.record(Outcome, Edge).optional(),
  /** Falsy o lista vacía: el paso se salta con outcome `skipped`. */
  when: Ref.optional(),
  timeoutSec: z.number().positive().optional(),
  retry: Retry.optional(),
};

const AgentNode = z.strictObject({
  ...common,
  type: z.literal("agent"),
  role: NodeId,
  mode: z.string().min(1),
  brief: z.record(z.string(), Value),
  /**
   * La entrada del perfil que pone runtime, modelo, effort y topes de este nodo; sin ella, la del rol. Así un nodo
   * corre con otro runtime o modelo sin cambiar el rol (p. ej. `review-bugs-opencode`). `escalate.profileRole` la pisa.
   */
  profileRole: NodeId.optional(),
  /** De qué sesión partir; si se retoma o no lo decide Agents. */
  resumeFrom: NodeId.optional(),
  escalate: z
    .strictObject({ counter: z.string().min(1), from: z.int().nonnegative(), profileRole: NodeId })
    .optional(),
});

const ActionNode = z.strictObject({
  ...common,
  type: z.literal("action"),
  action: z.string().min(1),
  args: z.record(z.string(), Value),
});

const GateNode = z.strictObject({
  ...common,
  type: z.literal("gate"),
  question: Value,
  options: z.array(z.strictObject({ id: Outcome, label: z.string().min(1) })).min(1),
  default: Outcome.optional(),
});

const WaitNode = z.strictObject({
  ...common,
  type: z.literal("wait"),
  event: z.string().min(1),
  args: z.record(z.string(), Value),
});

const FlowNode = z.strictObject({
  ...common,
  type: z.literal("flow"),
  flow: NodeId,
  /** Un objeto, o un ref a uno (el bench pasa `$item.params`). */
  params: z.union([Ref, z.record(z.string(), Value)]),
  /** Corre el flujo hijo hasta antes de este nodo suyo. */
  stopBefore: NodeId.optional(),
  profile: Value.optional(),
});

/** La rama de un `forEach`: cualquier nodo salvo otro parallel (el diseño no lo usa). */
const BranchNode = z.discriminatedUnion("type", [AgentNode, ActionNode, GateNode, WaitNode, FlowNode]);

const ParallelNode = z.strictObject({
  ...common,
  type: z.literal("parallel"),
  branches: z.union([
    z.array(NodeId).min(1),
    z.strictObject({ forEach: Ref, branch: BranchNode }),
  ]),
  /** Función registrada o rol consolidador; por defecto "worst". */
  join: z
    .union([
      z.string().min(1),
      z.strictObject({ fn: z.string().min(1), args: z.record(z.string(), Value).optional() }),
      z.strictObject({ role: NodeId, mode: z.string().min(1) }),
    ])
    .optional(),
  rerun: z.enum(["all", "not-ok"]).optional(),
  onBranchError: z.enum(["fail", "ignore"]).optional(),
});

export const Node = z.discriminatedUnion("type", [
  AgentNode,
  ActionNode,
  ParallelNode,
  GateNode,
  WaitNode,
  FlowNode,
]);
export type Node = z.infer<typeof Node>;
export type BranchNode = z.infer<typeof BranchNode>;

export const FLOW_TRIGGERS = [
  "issue.queued",
  "pr.comment",
  "pr.conflict",
  "pr.baseConflict",
  "pr.merged",
  "pr.base_rewritten",
  "manual",
  "subflow",
] as const;

/** Nombre de un tipo de parámetro: `string`, `number`, `RepoRef`... lo interpreta quien lanza el flujo. */
const TypeName = z.string().min(1);

export const FlowDef = z.strictObject({
  /** Versión del formato. */
  schema: z.literal(1),
  id: NodeId,
  /** La asigna `flows.save`: no se edita a mano y no forma parte del contenido guardado. */
  version: z.int().positive().optional(),
  name: z.string().min(1),
  /** Una línea para quien elige el flujo: qué hace de punta a punta. */
  description: z.string().min(1).optional(),
  /** Subflujo o flujo de mantenimiento que el sistema dispara solo: no se ofrece al elegir el flujo de un proyecto. */
  internal: z.boolean().optional(),
  trigger: z.strictObject({
    type: z.enum(FLOW_TRIGGERS),
    filter: z.record(z.string(), Value).optional(),
  }),
  /** El proyecto pisa los defaults en sus Ajustes sin crear una versión del flujo. */
  params: z
    .record(z.string(), z.union([TypeName, z.strictObject({ type: TypeName, default: Value })]))
    .optional(),
  /** Por defecto: `issue.queued` y `manual` van a dev, `pr.*` a maintenance y un subflow hereda. */
  lane: z.enum(["dev", "maintenance"]).optional(),
  limits: z
    .strictObject({
      /** `null` o ausente: sin tope. */
      maxCostUsd: z.number().nonnegative().nullable().optional(),
      maxSteps: z.int().positive().optional(),
    })
    .optional(),
  /** `local`: la validación rechaza acciones que publican. */
  effects: z.enum(["remote", "local"]).optional(),
  start: NodeId,
  nodes: z.record(NodeId, Node),
});
export type FlowDef = z.infer<typeof FlowDef>;

/** El flujo se guarda sin `version`: la asigna `save` y vive en la versión de la def. */
export const FlowBody = FlowDef.omit({ version: true });

/** Un error o un aviso de `flows.validate`; `path` es la ruta dentro del flujo, por ejemplo `nodes.sync.on.conflict`. */
export const FlowIssue = z.object({ path: z.string(), message: z.string() });
export type FlowIssue = z.infer<typeof FlowIssue>;

/** Los avisos no impiden guardar. */
export const Validation = z.object({
  errors: z.array(FlowIssue),
  warnings: z.array(FlowIssue),
});
export type Validation = z.infer<typeof Validation>;

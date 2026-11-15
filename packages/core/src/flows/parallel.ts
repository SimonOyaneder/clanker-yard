import type { FlowDef, Node } from "@clanker/api";

// Cómo se nombran los pasos de un parallel. Las ramas fijas son nodos del flujo; la rama de un
// `forEach` es una sola plantilla que corre una vez por ítem, y el rol consolidador no está en
// `nodes`. Los tres necesitan un `step_runs.node_id` propio, y ninguno puede chocar con un NodeId
// (no lleva `[` ni `#`).

export type ParallelNode = Extract<Node, { type: "parallel" }>;
type AgentNode = Extract<Node, { type: "agent" }>;

/** Qué nodo ejecuta un paso y si cuelga de un parallel. */
export type StepNode =
  | { kind: "plain"; node: Node }
  /** Una rama (fija o de un forEach) del parallel `parent`. */
  | { kind: "branch"; parent: string; node: Node }
  /** El paso de agente que consolida las ramas del parallel `parent`. */
  | { kind: "join"; parent: string; node: AgentNode };

export const inlineBranchId = (parent: string, index: number) => `${parent}[${index}]`;
export const joinStepId = (parent: string) => `${parent}#join`;

const INLINE = /^(.+)\[(\d+)\]$/;
const JOIN = /^(.+)#join$/;

/** `reviews[2]` → el parallel `reviews` y la posición 2; `undefined` si el id no es de un forEach. */
export function parseInlineBranch(id: string): { parent: string; index: number } | undefined {
  const match = INLINE.exec(id);
  return match ? { parent: match[1] as string, index: Number(match[2]) } : undefined;
}

export function parallelOf(flow: FlowDef, id: string): ParallelNode {
  const node = Object.hasOwn(flow.nodes, id) ? flow.nodes[id] : undefined;
  if (node?.type !== "parallel") throw new Error(`El flujo "${flow.id}" no tiene el parallel "${id}".`);
  return node;
}

export function stepNode(flow: FlowDef, id: string): StepNode {
  if (Object.hasOwn(flow.nodes, id)) {
    const node = flow.nodes[id] as Node;
    for (const [parent, candidate] of Object.entries(flow.nodes)) {
      if (candidate.type === "parallel" && Array.isArray(candidate.branches) && candidate.branches.includes(id)) {
        return { kind: "branch", parent, node };
      }
    }
    return { kind: "plain", node };
  }

  const inline = parseInlineBranch(id);
  if (inline) {
    const { branches } = parallelOf(flow, inline.parent);
    if (!Array.isArray(branches)) return { kind: "branch", parent: inline.parent, node: branches.branch };
  }

  const parent = JOIN.exec(id)?.[1];
  if (parent !== undefined) {
    const { join } = parallelOf(flow, parent);
    if (typeof join === "object" && "role" in join) {
      return { kind: "join", parent, node: { type: "agent", role: join.role, mode: join.mode, brief: {} } };
    }
  }
  throw new Error(`El flujo "${flow.id}" no tiene el nodo "${id}".`);
}

/** Los ids de las ramas de un parallel; con forEach, una por ítem. */
export function branchIds(parent: string, node: ParallelNode, itemCount: number | undefined): string[] {
  if (Array.isArray(node.branches)) return node.branches;
  return Array.from({ length: itemCount ?? 0 }, (_, index) => inlineBranchId(parent, index));
}

/** El rol de cada paso agent del flujo, incluidos los de las ramas de un forEach y los consolidadores. */
export function agentRolesOf(flow: FlowDef): string[] {
  const roles: string[] = [];
  for (const node of Object.values(flow.nodes)) {
    if (node.type === "agent") roles.push(node.role);
    if (node.type !== "parallel") continue;
    if (!Array.isArray(node.branches) && node.branches.branch.type === "agent") roles.push(node.branches.branch.role);
    if (typeof node.join === "object" && "role" in node.join) roles.push(node.join.role);
  }
  return roles;
}

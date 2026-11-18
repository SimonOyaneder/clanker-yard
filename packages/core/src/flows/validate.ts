import {
  isRef,
  type Edge,
  type FlowDef,
  type FlowIssue,
  type Node,
  type Validation,
} from "@clanker/api";
import type { ZodType } from "zod";
import type { Catalog } from "./catalog";

// Validación semántica de un flujo (`docs/design.html#d-flows`, "Validación al guardar").
// Recibe un FlowDef que ya pasó el esquema de `@clanker/api`.

type Path = (string | number)[];

/** Outcomes que cualquier nodo puede tener sin declararlos. `skipped` sigue el edge `ok`. */
const IMPLICIT_OUTCOMES = ["error", "timeout", "skipped"];
/** Cabezas de ref que no son un nodo. */
const RESERVED_REFS = ["run", "prev", "self", "item"];
const FLOW_OUTCOMES = ["done", "blocked", "failed"];

/** Un edge de salida de un nodo, ya aplanado: `bounded` es la pierna `to` de un edge con maxRounds y exhausted. */
interface Leg {
  path: Path;
  target: string;
  bounded: boolean;
}

export function validateFlow(def: FlowDef, catalog: Catalog): Validation {
  const errors: FlowIssue[] = [];
  const warnings: FlowIssue[] = [];
  const fail = (path: Path, message: string) => void errors.push({ path: path.join("."), message });
  const warn = (path: Path, message: string) => void warnings.push({ path: path.join("."), message });

  const nodes = new Map<string, Node>(Object.entries(def.nodes));
  const params = new Set(Object.keys(def.params ?? {}));
  // Un subflow puede referirse a nodos de la corrida que lo llama ("en la corrida o en sus padres").
  const isSubflow = def.trigger.type === "subflow";

  for (const id of nodes.keys()) {
    if (RESERVED_REFS.includes(id)) fail(["nodes", id], `"${id}" está reservado para los refs ($${id})`);
  }
  if (!nodes.has(def.start)) fail(["start"], `el nodo inicial "${def.start}" no existe`);

  // Ramas de un parallel: nodo normal, sin `on` y sin otro edge que llegue a él.
  const branchOwner = new Map<string, string>();
  for (const [id, node] of nodes) {
    if (node.type !== "parallel" || !Array.isArray(node.branches)) continue;
    node.branches.forEach((branch, i) => {
      const path = ["nodes", id, "branches", i];
      if (!nodes.has(branch)) return fail(path, `la rama "${branch}" no existe`);
      if (branch === id) return fail(path, "un parallel no puede ser rama de sí mismo");
      const owner = branchOwner.get(branch);
      if (owner !== undefined) return fail(path, `"${branch}" ya es rama del parallel "${owner}"`);
      branchOwner.set(branch, id);
    });
  }

  // Aristas entre nodos. Las ramas de un parallel cuelgan de su parallel y no tienen salidas propias.
  const legs = new Map<string, Leg[]>();
  const successors = new Map<string, Set<string>>();
  const predecessors = new Map<string, Set<string>>();
  const addTo = (map: Map<string, Set<string>>, key: string, value: string) => {
    const set = map.get(key) ?? new Set<string>();
    map.set(key, set.add(value));
  };
  const link = (from: string, to: string) => {
    addTo(successors, from, to);
    addTo(predecessors, to, from);
  };
  for (const [id, node] of nodes) {
    if (!branchOwner.has(id)) legs.set(id, legsOf(id, node));
  }
  for (const [branch, owner] of branchOwner) link(owner, branch);
  for (const [id, nodeLegs] of legs) {
    for (const { path, target } of nodeLegs) {
      if (target.startsWith("@")) continue;
      if (!nodes.has(target)) fail(path, `el nodo "${target}" no existe`);
      else if (branchOwner.has(target)) {
        fail(path, `"${target}" es rama del parallel "${branchOwner.get(target)}" y no puede ser destino de un edge`);
      } else link(id, target);
    }
  }
  if (branchOwner.has(def.start)) fail(["start"], `"${def.start}" es rama de un parallel y no puede ser el inicio`);

  const ancestorCache = new Map<string, Set<string>>();
  function ancestors(id: string): Set<string> {
    const cached = ancestorCache.get(id);
    if (cached) return cached;
    const seen = new Set<string>();
    const pending = [...(predecessors.get(id) ?? [])];
    for (let next = pending.pop(); next !== undefined; next = pending.pop()) {
      if (seen.has(next)) continue;
      seen.add(next);
      pending.push(...(predecessors.get(next) ?? []));
    }
    ancestorCache.set(id, seen);
    return seen;
  }

  /** `ctx` es el nodo que se refiere a `target`; en la rama inline de un forEach, el parallel dueño. */
  function checkNodeRef(path: Path, target: string, ctx: string) {
    if (!nodes.has(target)) {
      if (!isSubflow) fail(path, `el nodo "${target}" no existe`);
    } else if (target === ctx) {
      fail(path, `"${ctx}" no puede referirse a sí mismo (para su output anterior usa $self)`);
    } else if (branchOwner.get(ctx) === target) {
      fail(path, `una rama no ve el output de su parallel "${target}"`);
    } else if (!ancestors(ctx).has(target)) {
      fail(path, `"${target}" no es un nodo anterior a "${ctx}"`);
    }
  }

  function checkRef(path: Path, ref: string, ctx: string, inline: boolean) {
    const [head = "", ...rest] = ref.slice(1).split(".");
    switch (head) {
      case "run":
        if (rest[0] === "params" && rest[1] !== undefined && !params.has(rest[1])) {
          fail(path, `el param "${rest[1]}" no está declarado en params`);
        }
        return;
      case "prev":
        if (ctx === def.start && !inline) fail(path, "el nodo inicial no tiene paso anterior: $prev no resuelve a nada");
        return;
      case "self":
        return;
      case "item":
        if (!inline) fail(path, "$item solo existe dentro de la rama de un forEach");
        return;
      default:
        checkNodeRef(path, head, ctx);
    }
  }

  function checkRefsIn(value: unknown, path: Path, ctx: string, inline: boolean) {
    if (typeof value === "string") {
      if (isRef(value)) checkRef(path, value, ctx, inline);
    } else if (Array.isArray(value)) {
      value.forEach((v, i) => checkRefsIn(v, [...path, i], ctx, inline));
    } else if (value !== null && typeof value === "object") {
      for (const [k, v] of Object.entries(value)) checkRefsIn(v, [...path, k], ctx, inline);
    }
  }

  /** Valida con el zod del registro; un ref ocupa el lugar de cualquier valor y se resuelve al ejecutar. */
  function checkArgs(schema: ZodType | undefined, value: unknown, path: Path) {
    const result = schema?.safeParse(value);
    if (!result || result.success) return;
    for (const issue of result.error.issues) {
      if (isRef(valueAt(value, issue.path))) continue;
      fail([...path, ...issue.path.map(String)], issue.message);
    }
  }

  function roleMode(roleId: string, mode: string, rolePath: Path, modePath: Path) {
    const role = catalog.role(roleId);
    if (!role) return void fail(rolePath, `el rol "${roleId}" no existe`);
    const spec = Object.hasOwn(role.modes, mode) ? role.modes[mode] : undefined;
    if (!spec) {
      fail(modePath, `el rol "${roleId}" no tiene el modo "${mode}" (tiene: ${Object.keys(role.modes).join(", ")})`);
    }
    return spec;
  }

  /** La cadena de llamadas `from → ... → def.id`, si `from` termina llamando al flujo que se valida. */
  function callChain(from: FlowDef, seen = new Set<string>()): string[] | undefined {
    for (const callee of calledFlows(from)) {
      if (callee === def.id) return [from.id, callee];
      if (seen.has(callee)) continue;
      seen.add(callee);
      const next = catalog.flow(callee);
      const chain = next && callChain(next, seen);
      if (chain) return [from.id, ...chain];
    }
    return undefined;
  }

  function checkFlowCall(node: Extract<Node, { type: "flow" }>, path: Path) {
    const flowPath = [...path, "flow"];
    if (node.flow === def.id) return fail(flowPath, "un flujo no puede llamarse a sí mismo");
    const child = catalog.flow(node.flow);
    if (!child) return fail(flowPath, `el flujo "${node.flow}" no existe`);
    const chain = callChain(child);
    if (chain) fail(flowPath, `recursión de flujos: ${[def.id, ...chain].join(" → ")}`);
    if (node.stopBefore !== undefined && !Object.hasOwn(child.nodes, node.stopBefore)) {
      fail([...path, "stopBefore"], `"${child.id}" no tiene el nodo "${node.stopBefore}"`);
    }
    if (isRef(node.params)) return;
    const declared = child.params ?? {};
    for (const key of Object.keys(node.params)) {
      if (!Object.hasOwn(declared, key)) fail([...path, "params", key], `"${child.id}" no declara el param "${key}"`);
    }
    for (const [key, spec] of Object.entries(declared)) {
      // Un param sin default es obligatorio.
      if (typeof spec === "string" && !Object.hasOwn(node.params, key)) {
        fail([...path, "params"], `falta el param "${key}" de "${child.id}"`);
      }
    }
  }

  function checkOn(id: string, node: Node, outcomes: string[] | undefined) {
    const on = node.on ?? {};
    const base = ["nodes", id, "on"];
    if (outcomes) {
      const possible = [...outcomes, ...IMPLICIT_OUTCOMES];
      for (const key of Object.keys(on)) {
        if (!possible.includes(key)) fail([...base, key], `"${key}" no es un outcome de este nodo (${possible.join(", ")})`);
      }
      for (const outcome of outcomes) {
        if (!Object.hasOwn(on, outcome)) fail([...base, outcome], `falta el edge del outcome "${outcome}"`);
      }
    }
    for (const [outcome, edge] of Object.entries(on)) {
      if (typeof edge === "string") continue;
      const path = [...base, outcome];
      if (edge.maxRounds !== undefined && edge.exhausted === undefined) {
        fail([...path, "exhausted"], "maxRounds exige exhausted: a dónde ir cuando se agotan las rondas");
      }
      if (edge.exhausted !== undefined && edge.maxRounds === undefined) {
        fail([...path, "maxRounds"], "exhausted exige maxRounds");
      }
      if (typeof edge.maxRounds === "string") {
        const param = /^\$run\.params\.([\w-]+)$/.exec(edge.maxRounds)?.[1];
        if (param === undefined) fail([...path, "maxRounds"], "maxRounds es un número o un $run.params.<param>");
        else if (!params.has(param)) fail([...path, "maxRounds"], `el param "${param}" no está declarado en params`);
      }
    }
  }

  const lane = def.lane ?? LANE_BY_TRIGGER[def.trigger.type];

  /** Valida un nodo, o la rama inline de un forEach (`id` es entonces el de su parallel). */
  function checkNode(id: string, node: Node, path: Path, inline: boolean) {
    let outcomes: string[] | undefined;
    checkRefsIn(node.when, [...path, "when"], id, inline);

    switch (node.type) {
      case "agent": {
        const spec = roleMode(node.role, node.mode, [...path, "role"], [...path, "mode"]);
        checkArgs(spec?.payload, node.brief, [...path, "brief"]);
        checkRefsIn(node.brief, [...path, "brief"], id, inline);
        outcomes = spec?.outcomes;
        if (node.resumeFrom !== undefined) {
          const resumePath = [...path, "resumeFrom"];
          checkNodeRef(resumePath, node.resumeFrom, id);
          const target = nodes.get(node.resumeFrom);
          if (target && target.type !== "agent") fail(resumePath, `"${node.resumeFrom}" no es un nodo agent: no tiene sesión`);
        }
        break;
      }
      case "action": {
        const action = catalog.action(node.action);
        checkRefsIn(node.args, [...path, "args"], id, inline);
        if (!action) {
          fail([...path, "action"], `la acción "${node.action}" no está registrada`);
          break;
        }
        checkArgs(action.args, node.args, [...path, "args"]);
        outcomes = action.outcomes;
        if (def.effects === "local" && action.effects === "remote") {
          fail([...path, "action"], `"${action.name}" publica y este flujo es effects: "local"`);
        }
        break;
      }
      case "wait": {
        const wait = catalog.wait(node.event);
        checkRefsIn(node.args, [...path, "args"], id, inline);
        if (!wait) {
          fail([...path, "event"], `el wait "${node.event}" no está registrado`);
          break;
        }
        checkArgs(wait.args, node.args, [...path, "args"]);
        outcomes = wait.outcomes;
        break;
      }
      case "gate": {
        checkRefsIn(node.question, [...path, "question"], id, inline);
        outcomes = node.options.map((option) => option.id);
        outcomes.forEach((option, i) => {
          if (outcomes?.indexOf(option) !== i) fail([...path, "options", i, "id"], `la opción "${option}" está repetida`);
        });
        if (node.default !== undefined && !outcomes.includes(node.default)) {
          fail([...path, "default"], `"${node.default}" no es una de las opciones del gate`);
        }
        if (node.timeoutSec === undefined) {
          warn([...path, "timeoutSec"], "gate sin timeoutSec: su corrida queda estacionada hasta que alguien responda");
        }
        if (lane === "dev") warn(path, "gate en un flujo del carril dev: el desarrollo no tiene gates bloqueantes");
        break;
      }
      case "flow": {
        checkRefsIn(node.params, [...path, "params"], id, inline);
        checkRefsIn(node.profile, [...path, "profile"], id, inline);
        outcomes = FLOW_OUTCOMES;
        checkFlowCall(node, path);
        break;
      }
      case "parallel": {
        const join = node.join ?? "worst";
        if (typeof join === "object" && "role" in join) {
          outcomes = roleMode(join.role, join.mode, [...path, "join", "role"], [...path, "join", "mode"])?.outcomes;
        } else {
          const name = typeof join === "string" ? join : join.fn;
          const consolidator = catalog.consolidator(name);
          if (!consolidator) {
            fail(typeof join === "string" ? [...path, "join"] : [...path, "join", "fn"], `el consolidador "${name}" no está registrado`);
          } else {
            outcomes = consolidator.outcomes;
            if (typeof join === "object") {
              checkArgs(consolidator.args, join.args, [...path, "join", "args"]);
              checkRefsIn(join.args, [...path, "join", "args"], id, inline);
            }
          }
        }
        if (!Array.isArray(node.branches)) {
          if (node.rerun === "not-ok") {
            fail([...path, "rerun"], "rerun not-ok no aplica a un forEach: sus ramas se identifican por posición y la lista cambia entre visitas");
          }
          const branchPath = [...path, "branches", "branch"];
          checkRefsIn(node.branches.forEach, [...path, "branches", "forEach"], id, inline);
          checkNode(id, node.branches.branch, branchPath, true);
        }
        break;
      }
    }

    if (inline || branchOwner.has(id)) {
      if (node.on) fail([...path, "on"], "las ramas de un parallel no tienen on");
    } else {
      checkOn(id, node, outcomes);
    }
  }

  for (const [id, node] of nodes) checkNode(id, node, ["nodes", id], false);

  // Todo ciclo necesita un edge con maxRounds y exhausted: sin las piernas `to` de esos edges no puede quedar ninguno.
  const loopable = (id: string) =>
    (legs.get(id) ?? []).filter((leg) => !leg.bounded && legs.has(leg.target)).map((leg) => leg.target);
  for (const members of stronglyConnected([...legs.keys()], loopable)) {
    const [first = ""] = members;
    if (members.length > 1 || loopable(first).includes(first)) {
      fail(["nodes", first], `ciclo sin tope entre ${members.join(", ")}: algún edge del ciclo necesita maxRounds y exhausted`);
    }
  }

  const reachable = new Set<string>();
  const pending = nodes.has(def.start) ? [def.start] : [];
  for (let next = pending.pop(); next !== undefined; next = pending.pop()) {
    if (reachable.has(next)) continue;
    reachable.add(next);
    pending.push(...(successors.get(next) ?? []));
  }
  for (const id of nodes.keys()) {
    if (!reachable.has(id)) fail(["nodes", id], `no es alcanzable desde el nodo inicial "${def.start}"`);
  }

  const reachesEnd = new Set<string>();
  for (let grew = true; grew; ) {
    grew = false;
    for (const [id, nodeLegs] of legs) {
      if (reachesEnd.has(id) || !nodeLegs.some((leg) => leg.target.startsWith("@") || reachesEnd.has(leg.target))) continue;
      reachesEnd.add(id);
      grew = true;
    }
  }
  for (const id of legs.keys()) {
    if (!reachesEnd.has(id)) fail(["nodes", id], "no llega a @done, @blocked ni @failed");
  }

  return { errors, warnings };
}

export const LANE_BY_TRIGGER: Partial<Record<FlowDef["trigger"]["type"], "dev" | "maintenance">> = {
  "issue.queued": "dev",
  manual: "dev",
  "pr.comment": "maintenance",
  "pr.conflict": "maintenance",
  "pr.baseConflict": "maintenance",
  "pr.merged": "maintenance",
  "pr.base_rewritten": "maintenance",
};

/** Los ids de los flujos que `flow` llama con un nodo `flow` (también como rama de un forEach). */
export function calledFlows(flow: FlowDef): string[] {
  const called: string[] = [];
  for (const node of Object.values(flow.nodes)) {
    if (node.type === "flow") called.push(node.flow);
    else if (node.type === "parallel" && !Array.isArray(node.branches) && node.branches.branch.type === "flow") {
      called.push(node.branches.branch.flow);
    }
  }
  return called;
}

/** Componentes fuertemente conexos (Tarjan) en el orden de `ids`. */
function stronglyConnected(ids: string[], next: (id: string) => string[]): string[][] {
  const index = new Map<string, number>();
  const low = new Map<string, number>();
  const stack: string[] = [];
  const onStack = new Set<string>();
  const components: string[][] = [];

  function visit(id: string) {
    const mine = index.size;
    index.set(id, mine);
    low.set(id, mine);
    stack.push(id);
    onStack.add(id);
    for (const target of next(id)) {
      if (!index.has(target)) {
        visit(target);
        low.set(id, Math.min(low.get(id) ?? mine, low.get(target) ?? mine));
      } else if (onStack.has(target)) {
        low.set(id, Math.min(low.get(id) ?? mine, index.get(target) ?? mine));
      }
    }
    if (low.get(id) !== mine) return;
    const members: string[] = [];
    for (let member = stack.pop(); member !== undefined; member = stack.pop()) {
      onStack.delete(member);
      members.push(member);
      if (member === id) break;
    }
    components.push(ids.filter((candidate) => members.includes(candidate)));
  }

  for (const id of ids) if (!index.has(id)) visit(id);
  return components;
}

function legsOf(id: string, node: Node): Leg[] {
  const result: Leg[] = [];
  for (const [outcome, edge] of Object.entries(node.on ?? {})) {
    const path = ["nodes", id, "on", outcome];
    if (typeof edge === "string") {
      result.push({ path, target: edge, bounded: false });
      continue;
    }
    result.push({ path: [...path, "to"], target: edge.to, bounded: hasRounds(edge) });
    const { exhausted } = edge;
    if (typeof exhausted === "string") result.push({ path: [...path, "exhausted"], target: exhausted, bounded: false });
    else if (exhausted) result.push({ path: [...path, "exhausted", "to"], target: exhausted.to, bounded: false });
  }
  return result;
}

function hasRounds(edge: Exclude<Edge, string>): boolean {
  return edge.maxRounds !== undefined && edge.exhausted !== undefined;
}

function valueAt(root: unknown, path: PropertyKey[]): unknown {
  let current = root;
  for (const key of path) {
    if (current === null || typeof current !== "object") return undefined;
    current = (current as Record<PropertyKey, unknown>)[key];
  }
  return current;
}

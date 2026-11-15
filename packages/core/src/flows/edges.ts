import type { Edge, Node } from "@clanker/api";

/** Hacia dónde sigue el flujo tras un paso y qué cambió en los contadores de rondas. */
export interface Taken {
  to: string;
  /** La decisión no bloqueante que deja el edge (o su `exhausted`). */
  note?: string;
  /** El contador con su valor nuevo; ausente si el edge no cuenta rondas o ya se agotó. */
  counter?: { key: string; count: number };
  /** Vueltas que lleva el edge tomado, para `step_runs.round`; 0 si no cuenta o se agotó. */
  round: number;
}

/**
 * El edge que sigue un outcome. `skipped` sigue el edge `ok`; un `timeout` sin edge propio cuenta
 * como `error`. `undefined`: el nodo no maneja ese outcome.
 */
export function edgeFor(node: Node, outcome: string): Edge | undefined {
  const on = node.on ?? {};
  if (outcome === "skipped") return on.skipped ?? on.ok;
  if (outcome === "timeout") return on.timeout ?? on.error;
  return on[outcome];
}

/** `maxRounds` ya resuelto: el número, o el param al que apunta. Un valor que no sea entero positivo es un error del proyecto. */
export function maxRoundsOf(edge: Exclude<Edge, string>, params: Record<string, unknown>): number | undefined {
  const { maxRounds } = edge;
  if (typeof maxRounds !== "string") return maxRounds;
  const name = maxRounds.slice("$run.params.".length);
  const value = params[name];
  if (!Number.isInteger(value) || (value as number) <= 0) {
    throw new Error(`maxRounds apunta al param "${name}", que vale ${JSON.stringify(value)}: debe ser un entero positivo.`);
  }
  return value as number;
}

/** Cada edge de un nodo, ya sea un destino suelto o con rondas. */
export function edgesOf(node: Node): Exclude<Edge, string>[] {
  return Object.values(node.on ?? {}).filter((edge) => typeof edge !== "string");
}

/**
 * Decide por dónde sigue `edge` y cuenta la vuelta. Un edge con `maxRounds` se toma hasta que su
 * contador llega al tope; después va por `exhausted` sin contar. `counter` comparte el contador
 * entre edges; sin él, cada (nodo, outcome) cuenta aparte.
 */
export function takeEdge(
  edge: Edge,
  edgeKey: string,
  rounds: Record<string, number>,
  params: Record<string, unknown>,
): Taken {
  if (typeof edge === "string") return { to: edge, round: 0 };
  const counts = edge.maxRounds !== undefined || edge.counter !== undefined;
  const key = edge.counter ?? edgeKey;
  const done = rounds[key] ?? 0;
  const max = maxRoundsOf(edge, params);
  if (max !== undefined && done >= max) {
    const { exhausted } = edge;
    if (exhausted === undefined) throw new Error(`El edge ${edgeKey} tiene maxRounds y no tiene exhausted.`);
    return typeof exhausted === "string" ? { to: exhausted, round: 0 } : { ...exhausted, round: 0 };
  }
  return {
    to: edge.to,
    ...(edge.note === undefined ? {} : { note: edge.note }),
    ...(counts ? { counter: { key, count: done + 1 } } : {}),
    round: counts ? done + 1 : 0,
  };
}

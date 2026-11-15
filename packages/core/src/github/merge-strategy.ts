import type { MergeCondition, MergeStrategy, PrMerge, PrState } from "@clanker/api";

// Los tres niveles de merge (`docs/design.html#d-ops`, "Tres niveles de merge"): `ready`, `offer` y `auto`
// son listas de condiciones que el core sabe evaluar y el pack ordena. Es puro: lo que depende del repo
// (hold, si la estrategia aplica, quién escribió `/merge`) llega ya resuelto en los hechos.

/** Lo que una estrategia decide. Sin `auto` nunca se mergea solo. */
export type MergeRules = Pick<MergeStrategy, "ready" | "offer"> & { auto?: MergeStrategy["auto"] };

/**
 * Sin estrategia de pack, o donde no aplica (un repo sin merge-queue): GitHub mergea con su botón y el core solo
 * ofrece avisar. Nunca `auto`: sin un comando que comentar no hay nada que el core pueda hacer solo.
 */
export const GITHUB_BUTTON: MergeRules = {
  ready: ["notDraft", "approved", "ciGreen", "baseIsDefault", "noConflict", "noHumanOpenThreads"],
  offer: ["ready", "notHold"],
};

/** De un PR, lo que las condiciones leen. `queue` es si ya se pidió el merge; `defaultBranch` solo da texto a un blocker. */
export type MergeFacts = Pick<PrState, "state" | "baseRef" | "baseIsDefault" | "mergeable" | "reviewDecision" | "ci" | "threads" | "talk" | "approvers" | "hold"> & {
  defaultBranch: string;
  queue: PrMerge["queue"];
};

/**
 * `undefined` si se cumple; si no, qué se lo impide con las palabras de `mergeStatus` de Clanker Control. El
 * texto vacío es "no se cumple, pero no hay nada que decirle al usuario" (`queue` ya lo dice).
 */
type Unmet = (facts: MergeFacts) => string | undefined;

const CONDITIONS: Record<Exclude<MergeCondition, "ready" | "offer">, Unmet> = {
  notDraft: (f) => (f.state === "draft" ? "es draft" : undefined),
  approved: (f) =>
    f.reviewDecision === "approved" ? undefined : f.reviewDecision === "changes_requested" ? "pidieron cambios" : "falta aprobación",
  // Un PR sin checks que cuenten (`none`) es listo, como `every` sobre vacío en Control y en el vigilante.
  ciGreen: (f) => (f.ci.state === "green" || f.ci.state === "none" ? undefined : "el CI no está verde"),
  baseIsDefault: (f) => (f.baseIsDefault ? undefined : `va sobre ${f.baseRef}, no sobre ${f.defaultBranch}`),
  noConflict: (f) => (f.mergeable === "conflict" ? "tiene conflictos" : undefined),
  noHumanOpenThreads: (f) => (f.threads.humanOpen > 0 ? `${f.threads.humanOpen} hilos de humanos sin resolver` : undefined),
  noHumanResolvedThreads: (f) => (f.threads.humanResolved > 0 ? "tiene hilos de humanos, aunque resueltos" : undefined),
  notQueued: (f) => (f.queue === null ? undefined : ""),
  humanApprover: (f) => (f.approvers.length > 0 ? undefined : "ningún humano lo aprobó"),
  noHumanTalk: (f) => (f.talk.length > 0 ? "un humano comentó" : undefined),
  noCouncilOpen: (f) => (f.threads.councilOpen.length > 0 ? "tiene threads del council sin atender" : undefined),
  noCouncilEver: (f) => (f.threads.councilEver ? "tuvo threads del council" : undefined),
  notHold: (f) => (f.hold ? "está en hold" : undefined),
};

/**
 * Evalúa `ready`, `offer` y `auto` de un PR. Un PR mergeado o cerrado no tiene nada. `blockers` son solo
 * los de `ready`, en el orden de la lista. `hold` apaga `offer` y `auto` sea cual sea la lista del pack
 * (es del core, no del pack), y `auto` siempre implica `offer`.
 */
export function evaluateMerge(facts: MergeFacts, rules: MergeRules): Omit<PrMerge, "via"> {
  if (facts.state !== "open" && facts.state !== "draft") return { ready: false, blockers: [], queue: null, offer: false, auto: false };

  /** Por qué no se cumple `condition`; `ready` y `offer` valen lo que ya se calculó de ese nivel. */
  const unmetOf = (condition: MergeCondition, levels: Partial<Record<"ready" | "offer", boolean>>): string | undefined => {
    if (condition !== "ready" && condition !== "offer") return CONDITIONS[condition](facts);
    const met = levels[condition];
    // El esquema del pack ya no deja citar un nivel que no está debajo.
    if (met === undefined) throw new Error(`La condición "${condition}" no se puede evaluar en esta lista.`);
    return met ? undefined : `no cumple "${condition}"`;
  };

  const unmet = rules.ready.flatMap((condition) => unmetOf(condition, {}) ?? []);
  const ready = unmet.length === 0;
  const holds = (list: MergeCondition[], levels: { ready: boolean; offer?: boolean }) => list.every((condition) => unmetOf(condition, levels) === undefined);
  const offer = !facts.hold && holds(rules.offer, { ready });
  const auto = rules.auto !== undefined && offer && holds(rules.auto, { ready, offer });

  return { ready, blockers: unmet.filter((reason) => reason !== ""), queue: facts.queue, offer, auto };
}

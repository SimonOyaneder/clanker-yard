import { mergeBlocker, rebaseBlocker } from "@clanker/api"
import type { GithubPr, OpenPr } from "./prs"

/** Qué acciones del core se le ofrecen a un PR: las mismas que el core acepta (`prs.*`), para no ofrecer lo que va a rechazar. */
export interface PrCaps {
  /**
   * Mergear según la estrategia del pack: `comment` comenta el comando (con confirmación) y `button` manda a GitHub,
   * donde la estrategia no aplica. Nada si falta algo (`merge.blockers`), tiene hold o ya está en cola.
   */
  merge: "comment" | "button" | null
  /** El pack define un bot de review al que pedírsela. */
  requestReview: boolean
  /** El sistema abrió el PR y no tiene threads de council: se puede rebasear. */
  rebase: boolean
  /** Marcar o desmarcar "no mergear nunca": siempre, sobre un PR abierto. */
  hold: boolean
  /** La corrida que lo abrió. */
  run: boolean
  /** Es un PR local: se puede publicar ya en GitHub, apilado sobre su padre. */
  publishLocal: boolean
  /** Chatear sobre el PR: siempre, sobre un PR abierto (aplicar lo que proponga solo vale en uno que abrió el sistema). */
  chat: boolean
}

export function prCaps(pr: OpenPr): PrCaps {
  if (pr.local) return { merge: null, requestReview: false, rebase: false, hold: false, run: pr.runId !== null, publishLocal: pr.owned, chat: true }
  return {
    merge: mergeBlocker(pr.state) === undefined ? (pr.state.merge.via === "comment" ? "comment" : "button") : null,
    requestReview: pr.reviewBot,
    rebase: rebaseBlocker(pr.state, pr.owned) === undefined,
    hold: true,
    run: pr.runId !== null,
    publishLocal: false,
    chat: true,
  }
}

/** La razón por la que no se puede mergear (la misma con que el core lo rechazaría), para el tooltip del ítem apagado; `undefined` si se puede. */
export function whyNotMerge(pr: GithubPr): string | undefined {
  const why = mergeBlocker(pr.state)
  return why && why.charAt(0).toUpperCase() + why.slice(1)
}

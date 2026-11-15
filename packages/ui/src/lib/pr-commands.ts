import type { OpenPr } from "./prs"

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
}

export function prCaps(pr: OpenPr): PrCaps {
  const { merge, hold, threads } = pr.state
  const mergeable = merge.ready && !hold && merge.queue === null
  return {
    merge: mergeable ? (merge.via === "comment" ? "comment" : "button") : null,
    requestReview: pr.reviewBot,
    rebase: pr.owned && !threads.councilEver,
    hold: true,
    run: pr.runId !== null,
  }
}

/** La razón por la que no se puede mergear, para el tooltip del ítem apagado; `undefined` si se puede. */
export function whyNotMerge(pr: OpenPr): string | undefined {
  const { merge, hold } = pr.state
  if (hold) return "Tiene hold: quítalo para poder mergear"
  if (merge.queue === "queued") return "Ya está en cola"
  if (merge.queue === "failed") return "El merge falló en la cola: revisa por qué en GitHub"
  if (!merge.ready) return merge.blockers.length ? `Falta: ${merge.blockers.join(", ")}` : "No está listo para mergear"
  return undefined
}

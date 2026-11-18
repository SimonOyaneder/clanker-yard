import { expect, test } from "vitest"
import { buildOpenPrs } from "@/demo/seed-prs"
import { mergeMark, reviewStatus } from "./pr-status"
import { prCaps, whyNotMerge } from "./pr-commands"
import { openPrsOf, type GithubPr, type LocalPr } from "./prs"

const NOW = Date.parse("2026-11-15T12:00:00Z")
const find = (key: string): GithubPr => openPrsOf(buildOpenPrs(NOW)).find((p): p is GithubPr => p.state?.key === key)!

test("un PR listo con la estrategia del pack se mergea comentando, y con un repo sin estrategia, en GitHub", () => {
  const ready = find("ledger#421")
  expect(prCaps(ready).merge).toBe("comment")

  const button: GithubPr = { ...ready, state: { ...ready.state, merge: { ...ready.state.merge, via: "button" } } }
  expect(prCaps(button).merge).toBe("button")
})

test("no se ofrece mergear un PR en cola, con la cola caída, en hold o con algo que falta, y el motivo se dice", () => {
  expect(prCaps(find("dashboard#977")).merge).toBeNull()
  expect(whyNotMerge(find("dashboard#977"))).toBe("Ya está en cola: el merge ya se pidió")
  expect(prCaps(find("payments-api#391")).merge).toBeNull()
  expect(whyNotMerge(find("payments-api#391"))).toMatch(/falló en la cola/)
  expect(prCaps(find("dashboard#981")).merge).toBeNull()
  expect(whyNotMerge(find("dashboard#981"))).toMatch(/hold/)
  expect(whyNotMerge(find("ledger#424"))).toBe("No está listo para mergear: pidieron cambios, 2 hilos de humanos sin resolver")
  expect(whyNotMerge(find("ledger#421"))).toBeUndefined()
})

test("rebasear solo se ofrece en PRs del sistema sin threads de council, y la corrida solo si hay una", () => {
  const owned = find("ledger#421")
  expect(prCaps(owned).rebase).toBe(true)
  expect(prCaps(find("dashboard#955")).rebase).toBe(false)
  const council: GithubPr = { ...owned, state: { ...owned.state, threads: { ...owned.state.threads, councilEver: true } } }
  expect(prCaps(council).rebase).toBe(false)
  expect(prCaps(owned).run).toBe(false)
  expect(prCaps({ ...owned, runId: "run_00000000000000000000000001" }).run).toBe(true)
})

test("un local no tiene acciones ni estados de GitHub, aunque su pack tenga un bot, y el del sistema se puede publicar ya", () => {
  const local = openPrsOf(buildOpenPrs(NOW)).find((p): p is LocalPr => p.local !== null)!

  expect(prCaps(local)).toEqual({ merge: null, requestReview: false, rebase: false, hold: false, run: false, publishLocal: local.owned, chat: true })
  expect(prCaps({ ...local, owned: true }).publishLocal).toBe(true)
  expect(prCaps({ ...local, owned: false }).publishLocal).toBe(false)
  expect(prCaps({ ...local, runId: "run_00000000000000000000000001" }).run).toBe(true)
  expect(mergeMark(local)).toBeNull()
  expect(reviewStatus(local)).toBe("none")
})

test("pedir review del bot depende de que el pack defina uno", () => {
  const pr = find("ledger#421")
  expect(prCaps(pr).requestReview).toBe(true)
  expect(prCaps({ ...pr, reviewBot: false }).requestReview).toBe(false)
})

test("la marca de merge: la cola que falló o corre manda sobre hold, y hold sobre listo", () => {
  expect(mergeMark(find("payments-api#391"))).toBe("failed")
  expect(mergeMark(find("dashboard#977"))).toBe("queued")
  expect(mergeMark(find("dashboard#981"))).toBe("hold")
  expect(mergeMark(find("ledger#421"))).toBe("ready")
  expect(mergeMark(find("dashboard#955"))).toBeNull()
})

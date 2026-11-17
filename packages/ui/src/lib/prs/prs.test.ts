import type { CachedPr } from "@clanker/api"
import { expect, test } from "vitest"
import { buildOpenPrs } from "@/demo/seed-prs"
import { openPrsOf } from "./prs"

const NOW = Date.parse("2026-11-15T12:00:00Z")

test("se dibujan locales y remotos abiertos o en draft, pero no cerrados ni remotos sin leer", () => {
  const [open] = buildOpenPrs(NOW)
  const local: CachedPr = { ...open!, id: "pr_local", ref: null, state: null, local: { branch: "feat/y", base: "feat/x", title: "feat: y" } }

  const draft: CachedPr = { ...open!, id: "pr_draft", state: { ...open!.state!, state: "draft" } }
  const closed: CachedPr = { ...open!, id: "pr_closed", state: { ...open!.state!, state: "closed" } }
  const merged: CachedPr = { ...closed, id: "pr_merged", state: { ...closed.state!, state: "merged" } }
  const unread: CachedPr = { ...open!, id: "pr_unread", state: null }
  expect(openPrsOf([open!, local, draft, closed, merged, unread]).map((p) => p.id)).toEqual([open!.id, local.id, draft.id])
})

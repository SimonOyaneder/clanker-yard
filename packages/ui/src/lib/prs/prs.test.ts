import type { CachedPr } from "@clanker/api"
import { expect, test } from "vitest"
import { buildOpenPrs } from "@/demo/seed-prs"
import { openPrsOf } from "./prs"

const NOW = Date.parse("2026-11-15T12:00:00Z")

test("un PR local, sin número en GitHub, no se dibuja", () => {
  const [open] = buildOpenPrs(NOW)
  const local: CachedPr = { ...open!, id: "pr_local", ref: null, state: null, local: { branch: "feat/y", base: "feat/x", title: "feat: y" } }

  expect(openPrsOf([open!, local]).map((p) => p.id)).toEqual([open!.id])
})

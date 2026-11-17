// @vitest-environment jsdom
import { beforeEach, expect, test } from "vitest"
import { readPref, writePref } from "./prefs"

beforeEach(() => localStorage.clear())

test("una preferencia guardada se lee de vuelta, y sin guardar vale el default", () => {
  expect(readPref("prs.mode", "graph")).toBe("graph")
  writePref("prs.mode", "list")
  expect(readPref("prs.mode", "graph")).toBe("list")
})

test("una preferencia que guardó la UI de Control (cc.) se lee una vez y pasa a la clave nueva", () => {
  localStorage.setItem("cc.prs.mode", JSON.stringify("list"))

  expect(readPref("prs.mode", "graph")).toBe("list")
  expect(localStorage.getItem("cc.prs.mode")).toBeNull()
  expect(localStorage.getItem("clanker.prs.mode")).toBe(JSON.stringify("list"))
})

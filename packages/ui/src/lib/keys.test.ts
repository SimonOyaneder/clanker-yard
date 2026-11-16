// @vitest-environment jsdom
import { afterEach, expect, test } from "vitest"
import { isTypingTarget, overlayOpen } from "./keys"

afterEach(() => {
  document.body.innerHTML = ""
})

test("un campo donde se escribe, o algo dentro de él, es typing; un botón no", () => {
  document.body.innerHTML = `<input id="i"><textarea id="t"></textarea><div contenteditable="true"><span id="s"></span></div><button id="b"></button>`
  const at = (id: string) => document.getElementById(id)

  expect(["i", "t", "s"].map((id) => isTypingTarget(at(id)))).toEqual([true, true, true])
  expect(isTypingTarget(at("b"))).toBe(false)
  expect(isTypingTarget(null)).toBe(false)
})

test("extra suma selectores: un botón dentro de un diálogo cuenta solo si se pide", () => {
  document.body.innerHTML = `<div role="dialog"><button id="b"></button></div>`
  const button = document.getElementById("b")

  expect(isTypingTarget(button)).toBe(false)
  expect(isTypingTarget(button, ["[role='dialog']"])).toBe(true)
})

test("overlayOpen ve un diálogo, menú o lista abierta", () => {
  expect(overlayOpen()).toBe(false)
  document.body.innerHTML = `<div role="menu"></div>`
  expect(overlayOpen()).toBe(true)
})

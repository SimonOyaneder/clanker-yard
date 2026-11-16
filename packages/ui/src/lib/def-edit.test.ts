import { expect, test } from "vitest"
import { describePath, lineIssues, lineOfPath, syntaxIssue } from "@/lib/def-edit"

const flow = JSON.stringify({ id: "demo", nodes: { plan: { type: "agent", on: { ok: "@done", "fail": ["a", "b"] } }, sync: { type: "action" } } }, null, 2)

test("una ruta del core cae en la línea de su clave", () => {
  const lines = flow.split("\n")
  expect(lines[lineOfPath(flow, "nodes.plan.on.ok") - 1]).toContain('"ok"')
  expect(lines[lineOfPath(flow, "nodes.sync") - 1]).toContain('"sync"')
  expect(lines[lineOfPath(flow, "nodes.plan.on.fail.1") - 1]).toContain('"b"')
})

test("un campo que falta se marca donde debía ir y la raíz en la línea 1", () => {
  const lines = flow.split("\n")
  expect(lines[lineOfPath(flow, "nodes.sync.role") - 1]).toContain('"sync"')
  expect(lineOfPath(flow, "")).toBe(1)
})

test("las claves con comillas escapadas y las cadenas con llaves no desordenan las líneas", () => {
  const text = '{\n  "a\\"b": "}{",\n  "c": { "d": 1 }\n}'
  expect(lineOfPath(text, "c.d")).toBe(3)
})

test("la ruta se dice como paso y campo en un flujo, y como campo en lo demás", () => {
  expect(describePath("flow", "nodes.plan.on.ok")).toBe("paso `plan` → campo `on.ok`")
  expect(describePath("flow", "nodes.plan")).toBe("paso `plan`")
  expect(describePath("flow", "name")).toBe("campo `name`")
  expect(describePath("role", "modes.dev.outcomes")).toBe("campo `modes.dev.outcomes`")
  expect(describePath("flow", "")).toBe("el contenido entero")
})

test("lineIssues conserva el mensaje del core y le suma el lugar", () => {
  const [issue] = lineIssues("flow", flow, [{ path: "nodes.sync.role", message: 'no existe el rol "x"' }])
  expect(issue).toEqual({ line: flow.split("\n").findIndex((l) => l.includes('"sync"')) + 1, message: 'paso `sync` → campo `role`: no existe el rol "x"' })
})

test("un JSON roto marca la línea donde se perdió el lector", () => {
  expect(syntaxIssue('{\n  "a": 1\n  "b": 2\n}')?.line).toBe(3)
  expect(syntaxIssue('{ "a": 1 }')).toBeNull()
})

test("los mensajes crudos de zod salen en claro y los del core no se tocan", () => {
  const [type, key, core] = lineIssues("flow", flow, [
    { path: "id", message: "Invalid input: expected string, received number" },
    { path: "nodes.plan", message: 'Unrecognized key: "foo"' },
    { path: "nodes.sync.role", message: 'no existe el rol "x"' },
  ])
  expect(type!.message).toContain("se esperaba un texto y hay un número")
  expect(key!.message).toContain('"foo" no existe aquí')
  expect(core!.message).toBe('paso `sync` → campo `role`: no existe el rol "x"')
})

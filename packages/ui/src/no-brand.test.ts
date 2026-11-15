import { readdirSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { expect, test } from "vitest"

// La UI es genérica: lo que depende de una organización (señales, bot de review, comando de merge) llega del pack
// por el core. Una marca en el código de la UI es una convención que se coló.
const BRAND = new RegExp(["fin", "toc"].join(""), "i")
const SELF = import.meta.filename

function sources(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) return sources(path)
    return /\.(tsx?|css|html)$/.test(entry.name) && path !== SELF ? [path] : []
  })
}

test("no hay una marca de organización en el código de packages/ui", () => {
  const roots = [import.meta.dirname, join(import.meta.dirname, "..", "index.html")]
  const files = roots.flatMap((root) => (root.endsWith(".html") ? [root] : sources(root)))
  const offenders = files.filter((file) => BRAND.test(readFileSync(file, "utf8")))
  expect(offenders).toEqual([])
})

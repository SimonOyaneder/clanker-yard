import { expect, test } from "vitest"
import { parsePatch } from "./diff"

const PATCH = `diff --git a/src/a.ts b/src/a.ts
index 1111111..2222222 100644
--- a/src/a.ts
+++ b/src/a.ts
@@ -10,3 +10,4 @@ export function a() {
 const x = 1
-const y = 2
+const y = 3
+const z = 4
 return x
diff --git a/src/b.ts b/src/b.ts
new file mode 100644
index 0000000..3333333
--- /dev/null
+++ b/src/b.ts
@@ -0,0 +1,1 @@
+export const b = 1
\\ No newline at end of file
diff --git a/logo.png b/logo.png
index 4444444..5555555 100644
Binary files a/logo.png and b/logo.png differ
`

test("parte el diff por archivo con sus conteos y los números de línea de cada lado", () => {
  const [a, b, logo] = parsePatch(PATCH)

  expect(a).toMatchObject({ path: "src/a.ts", status: "modified", additions: 2, deletions: 1 })
  expect(a!.lines).toEqual([
    { kind: "hunk", text: "@@ -10,3 +10,4 @@ export function a() {" },
    { kind: "ctx", text: "const x = 1", old: 10, new: 10 },
    { kind: "del", text: "const y = 2", old: 11 },
    { kind: "add", text: "const y = 3", new: 11 },
    { kind: "add", text: "const z = 4", new: 12 },
    { kind: "ctx", text: "return x", old: 12, new: 13 },
  ])
  expect(b).toMatchObject({ path: "src/b.ts", status: "added", additions: 1, deletions: 0 })
  expect(b!.lines.at(-1)).toEqual({ kind: "note", text: "\\ No newline at end of file" })
  expect(logo).toMatchObject({ path: "logo.png", status: "binary", lines: [] })
})

test("un diff vacío no tiene archivos", () => {
  expect(parsePatch("")).toEqual([])
})

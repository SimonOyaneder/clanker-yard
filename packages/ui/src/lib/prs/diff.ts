// El diff unificado de `git diff` (lo que trae `prs.localDetail`) partido por archivo y línea, con los números de
// línea de cada lado, para dibujarlo como GitHub.

export type DiffLineKind = "hunk" | "add" | "del" | "ctx" | "note"

export interface DiffLine {
  kind: DiffLineKind
  text: string
  /** Número en el archivo viejo (contexto y borradas). */
  old?: number
  /** Número en el archivo nuevo (contexto y agregadas). */
  new?: number
}

export interface DiffFile {
  path: string
  /** Archivo nuevo, borrado o binario (sin líneas). */
  status: "added" | "deleted" | "modified" | "binary"
  additions: number
  deletions: number
  lines: DiffLine[]
}

const HUNK = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/

export function parsePatch(patch: string): DiffFile[] {
  const files: DiffFile[] = []
  let file: DiffFile | undefined
  let oldNo = 0
  let newNo = 0
  let inHunk = false
  for (const raw of patch.split("\n")) {
    if (raw.startsWith("diff --git ")) {
      // `diff --git a/x b/x`: el path del lado nuevo (sin renames, son iguales).
      const path = raw.slice("diff --git ".length).replace(/^a\/.* b\//, "")
      file = { path, status: "modified", additions: 0, deletions: 0, lines: [] }
      files.push(file)
      inHunk = false
      continue
    }
    if (!file) continue
    if (!inHunk) {
      if (raw.startsWith("new file mode")) file.status = "added"
      else if (raw.startsWith("deleted file mode")) file.status = "deleted"
      else if (raw.startsWith("Binary files")) file.status = "binary"
      else if (raw.startsWith("+++ b/")) file.path = raw.slice("+++ b/".length)
    }
    const hunk = HUNK.exec(raw)
    if (hunk) {
      inHunk = true
      oldNo = Number(hunk[1])
      newNo = Number(hunk[2])
      file.lines.push({ kind: "hunk", text: raw })
      continue
    }
    if (!inHunk) continue
    if (raw.startsWith("+")) {
      file.additions++
      file.lines.push({ kind: "add", text: raw.slice(1), new: newNo++ })
    } else if (raw.startsWith("-")) {
      file.deletions++
      file.lines.push({ kind: "del", text: raw.slice(1), old: oldNo++ })
    } else if (raw.startsWith("\\")) {
      file.lines.push({ kind: "note", text: raw })
    } else if (raw.startsWith(" ")) {
      file.lines.push({ kind: "ctx", text: raw.slice(1), old: oldNo++, new: newNo++ })
    }
  }
  return files
}

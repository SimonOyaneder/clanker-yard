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

/** Una fila del diff lado a lado: la línea vieja a la izquierda y la nueva a la derecha; un hunk o una nota ocupan las dos. */
export type SplitRow = { kind: "full"; line: DiffLine } | { kind: "pair"; left?: DiffLine; right?: DiffLine }

/**
 * Las líneas de un archivo para verlas lado a lado, como GitHub: el contexto va en los dos lados y cada bloque de
 * borradas se empareja con el bloque de agregadas que lo sigue, línea a línea; lo que sobra de uno queda solo.
 */
export function splitRows(lines: readonly DiffLine[]): SplitRow[] {
  const rows: SplitRow[] = []
  let dels: DiffLine[] = []
  let adds: DiffLine[] = []
  const flush = () => {
    for (let i = 0; i < Math.max(dels.length, adds.length); i++) rows.push({ kind: "pair", left: dels[i], right: adds[i] })
    dels = []
    adds = []
  }
  for (const line of lines) {
    if (line.kind === "del") {
      // Una borrada después de agregadas empieza otro bloque.
      if (adds.length > 0) flush()
      dels.push(line)
    } else if (line.kind === "add") {
      adds.push(line)
    } else {
      flush()
      rows.push(line.kind === "ctx" ? { kind: "pair", left: line, right: line } : { kind: "full", line })
    }
  }
  flush()
  return rows
}

/** Una huella corta del cambio de un archivo: "visto" vale mientras el diff del archivo no cambie (como GitHub). */
export function fileFingerprint(file: DiffFile): string {
  let hash = 5381
  for (const line of file.lines) {
    const text = `${line.kind}:${line.text}`
    for (let i = 0; i < text.length; i++) hash = ((hash << 5) + hash + text.charCodeAt(i)) | 0
  }
  return `${file.path}@${(hash >>> 0).toString(36)}`
}

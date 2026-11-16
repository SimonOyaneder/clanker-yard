import type { DefChange, DefIssue, DefWriteKind } from "@clanker/api"
import { messageOf } from "@/lib/utils"

// Lo que el editor de JSON de una def necesita para hablarle a una persona: en qué línea está cada problema y
// cómo se llama el lugar del que habla el core. Nada aquí valida: eso lo hace `defs.update` con `dryRun`.

export interface LineIssue {
  /** 1-based. */
  line: number
  message: string
}

const lineAt = (text: string, offset: number) => text.slice(0, offset).split("\n").length

/** `null` si el texto es JSON; si no, el problema, en la línea donde el lector se perdió. */
export function syntaxIssue(text: string): LineIssue | null {
  try {
    JSON.parse(text)
    return null
  } catch (e) {
    const reason = messageOf(e)
    const position = /position (\d+)/.exec(reason)
    const line = position ? lineAt(text, Math.min(Number(position[1]), text.length)) : 1
    return { line, message: `El JSON no se puede leer (${reason}). Revisa comas, comillas y llaves en esta línea o en la anterior.` }
  }
}

/**
 * La línea de cada ruta de un JSON válido (`nodes.plan.on.ok`; un índice de arreglo cuenta como segmento), la de la
 * clave si es un objeto y la del valor si es un elemento.
 */
function pathLines(text: string): Map<string, number> {
  const lines = new Map<string, number>()
  let at = 0
  const skip = () => {
    while (/\s/.test(text[at] ?? "")) at++
  }
  const string = () => {
    const start = at++
    while (text[at] !== '"') at += text[at] === "\\" ? 2 : 1
    at++
    return JSON.parse(text.slice(start, at)) as string
  }
  const value = (path: string) => {
    skip()
    const ch = text[at]
    if (ch === "{" || ch === "[") {
      const close = ch === "{" ? "}" : "]"
      at++
      let index = 0
      for (skip(); text[at] !== close; skip()) {
        const member = (name: string) => (path === "" ? name : `${path}.${name}`)
        if (ch === "{") {
          const keyAt = at
          const key = string()
          skip()
          at++ // ":"
          lines.set(member(key), lineAt(text, keyAt))
          value(member(key))
        } else {
          lines.set(member(String(index)), lineAt(text, at))
          value(member(String(index++)))
        }
        skip()
        if (text[at] === ",") at++
      }
      at++
    } else if (ch === '"') string()
    else while (at < text.length && !/[\s,}\]]/.test(text[at]!)) at++
  }
  value("")
  return lines
}

/** La línea de la ruta del core, o la de su ancestro más cercano que exista (los campos que faltan se marcan donde debían ir). */
export function lineOfPath(text: string, path: string): number {
  const lines = pathLines(text)
  const segments = path === "" ? [] : path.split(".")
  for (let n = segments.length; n > 0; n--) {
    const line = lines.get(segments.slice(0, n).join("."))
    if (line !== undefined) return line
  }
  return 1
}

/** La ruta del core en palabras: en un flujo, "paso `plan` → campo `on.ok`". */
export function describePath(kind: DefWriteKind, path: string): string {
  if (path === "") return "el contenido entero"
  const step = kind === "flow" ? /^nodes\.([^.]+)(?:\.(.+))?$/.exec(path) : null
  if (step) return step[2] ? `paso \`${step[1]}\` → campo \`${step[2]}\`` : `paso \`${step[1]}\``
  return `campo \`${path}\``
}

const TYPE_NAME: Record<string, string> = { string: "un texto", number: "un número", boolean: "true o false", array: "una lista", object: "un objeto", null: "null", undefined: "nada" }

/** Los dos mensajes de zod que más salen, en claro; el resto (los del core y de `flows.validate`) ya vienen en español. */
export function plain(message: string): string {
  const type = /^Invalid input: expected (\w+), received (\w+)$/.exec(message)
  if (type) return `se esperaba ${TYPE_NAME[type[1]!] ?? type[1]} y hay ${TYPE_NAME[type[2]!] ?? type[2]} (${message})`
  const key = /^Unrecognized keys?: (.+)$/.exec(message)
  if (key) return `${key[1]} no existe aquí: revisa el nombre o quítalo (${message})`
  return message
}

/** Cada problema del core con su línea y su lugar dicho en claro. */
export function lineIssues(kind: DefWriteKind, text: string, issues: readonly DefIssue[]): LineIssue[] {
  return issues.map(({ path, message }) => ({ line: lineOfPath(text, path), message: `${describePath(kind, path)}: ${plain(message)}` }))
}

const MAX_SHOWN = 160

/** Un valor del diff, corto y en una línea. */
export function showValue(value: unknown): string {
  if (value === undefined) return "(nada)"
  const text = typeof value === "string" ? JSON.stringify(value) : (JSON.stringify(value) ?? String(value))
  return text.length > MAX_SHOWN ? `${text.slice(0, MAX_SHOWN)}…` : text
}

export type ChangeKind = "added" | "removed" | "changed"
export const changeKind = ({ before, after }: DefChange): ChangeKind => (before === undefined ? "added" : after === undefined ? "removed" : "changed")

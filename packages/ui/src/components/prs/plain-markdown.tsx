import type { ReactNode } from "react"

// Lo justo del markdown de una descripción de PR (títulos, listas, bloques de código, `código` y **negrita**) para que se
// lea como en GitHub, sin sumar una dependencia. Lo que no reconoce sale como texto.

type Block = { kind: "heading"; level: number; text: string } | { kind: "list"; ordered: boolean; items: string[] } | { kind: "code"; text: string } | { kind: "paragraph"; text: string }

export function parseBlocks(source: string): Block[] {
  const blocks: Block[] = []
  const lines = source.replace(/\r\n/g, "\n").split("\n")
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!
    if (line.trim() === "") continue
    if (line.startsWith("```")) {
      const code: string[] = []
      for (i++; i < lines.length && !lines[i]!.startsWith("```"); i++) code.push(lines[i]!)
      blocks.push({ kind: "code", text: code.join("\n") })
      continue
    }
    const heading = /^(#{1,6})\s+(.*)$/.exec(line)
    if (heading) {
      blocks.push({ kind: "heading", level: heading[1]!.length, text: heading[2]! })
      continue
    }
    const item = /^\s*(?:([-*+])|(\d+)[.)])\s+(.*)$/.exec(line)
    if (item) {
      const ordered = item[2] !== undefined
      const last = blocks.at(-1)
      if (last?.kind === "list" && last.ordered === ordered) last.items.push(item[3]!)
      else blocks.push({ kind: "list", ordered, items: [item[3]!] })
      continue
    }
    const last = blocks.at(-1)
    // Una línea que sigue a otra del mismo párrafo (sin línea en blanco entre medio) se junta, como en markdown.
    if (last?.kind === "paragraph" && lines[i - 1]?.trim() !== "") last.text += `\n${line}`
    else blocks.push({ kind: "paragraph", text: line })
  }
  return blocks
}

function inline(text: string): ReactNode[] {
  return text.split(/(`[^`]+`|\*\*[^*]+\*\*)/g).map((part, i) => {
    if (part.startsWith("`") && part.endsWith("`") && part.length > 1) {
      return (
        <code key={i} className="rounded bg-muted px-1 py-px font-mono text-[0.9em]">
          {part.slice(1, -1)}
        </code>
      )
    }
    if (part.startsWith("**") && part.endsWith("**") && part.length > 3) return <strong key={i}>{part.slice(2, -2)}</strong>
    return part
  })
}

const HEADING = ["text-lg", "text-base", "text-sm", "text-sm", "text-sm", "text-sm"]

export function PlainMarkdown({ source }: { source: string }) {
  return (
    <div className="flex flex-col gap-3 text-sm leading-relaxed">
      {parseBlocks(source).map((block, i) => {
        switch (block.kind) {
          case "heading":
            return (
              <p key={i} role="heading" aria-level={block.level} className={`${HEADING[block.level - 1]} mt-2 border-b pb-1 font-semibold first:mt-0`}>
                {inline(block.text)}
              </p>
            )
          case "list": {
            const List = block.ordered ? "ol" : "ul"
            return (
              <List key={i} className={`${block.ordered ? "list-decimal" : "list-disc"} flex flex-col gap-1 pl-5`}>
                {block.items.map((item, j) => (
                  <li key={j}>{inline(item)}</li>
                ))}
              </List>
            )
          }
          case "code":
            return (
              <pre key={i} className="overflow-x-auto rounded-md bg-muted px-3 py-2 font-mono text-[12px]">
                {block.text}
              </pre>
            )
          case "paragraph":
            return (
              <p key={i} className="whitespace-pre-wrap">
                {inline(block.text)}
              </p>
            )
        }
      })}
    </div>
  )
}

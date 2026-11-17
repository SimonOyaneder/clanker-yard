import hljs from "highlight.js/lib/core"
import bash from "highlight.js/lib/languages/bash"
import css from "highlight.js/lib/languages/css"
import dockerfile from "highlight.js/lib/languages/dockerfile"
import erb from "highlight.js/lib/languages/erb"
import go from "highlight.js/lib/languages/go"
import graphql from "highlight.js/lib/languages/graphql"
import ini from "highlight.js/lib/languages/ini"
import java from "highlight.js/lib/languages/java"
import javascript from "highlight.js/lib/languages/javascript"
import json from "highlight.js/lib/languages/json"
import kotlin from "highlight.js/lib/languages/kotlin"
import markdown from "highlight.js/lib/languages/markdown"
import python from "highlight.js/lib/languages/python"
import ruby from "highlight.js/lib/languages/ruby"
import rust from "highlight.js/lib/languages/rust"
import scss from "highlight.js/lib/languages/scss"
import sql from "highlight.js/lib/languages/sql"
import swift from "highlight.js/lib/languages/swift"
import typescript from "highlight.js/lib/languages/typescript"
import xml from "highlight.js/lib/languages/xml"
import yaml from "highlight.js/lib/languages/yaml"

// El color del código de un diff según su lenguaje. Solo los lenguajes de esta lista (los de los repos con que se
// trabaja); un archivo de otro lenguaje sale sin color. Los colores son tokens `--syntax-*` de `globals.css`.

const LANGUAGES = { bash, css, dockerfile, erb, go, graphql, ini, java, javascript, json, kotlin, markdown, python, ruby, rust, scss, sql, swift, typescript, xml, yaml }
for (const [name, language] of Object.entries(LANGUAGES)) hljs.registerLanguage(name, language)

const BY_EXTENSION: Record<string, keyof typeof LANGUAGES> = {
  rb: "ruby", rake: "ruby", gemspec: "ruby", ru: "ruby", erb: "erb",
  ts: "typescript", tsx: "typescript", mts: "typescript", cts: "typescript",
  js: "javascript", jsx: "javascript", mjs: "javascript", cjs: "javascript",
  json: "json", yml: "yaml", yaml: "yaml", toml: "ini", ini: "ini",
  py: "python", go: "go", rs: "rust", java: "java", kt: "kotlin", swift: "swift",
  sql: "sql", sh: "bash", bash: "bash", zsh: "bash",
  css: "css", scss: "scss", html: "xml", xml: "xml", svg: "xml",
  md: "markdown", graphql: "graphql", gql: "graphql",
}
const BY_NAME: Record<string, keyof typeof LANGUAGES> = { Gemfile: "ruby", Rakefile: "ruby", Dockerfile: "dockerfile", Brewfile: "ruby" }

/** El lenguaje de un archivo por su nombre o extensión; `undefined` si no hay uno registrado. */
export function languageOf(path: string): string | undefined {
  const name = path.split("/").at(-1) ?? path
  if (BY_NAME[name]) return BY_NAME[name]
  const dot = name.lastIndexOf(".")
  return dot === -1 ? undefined : BY_EXTENSION[name.slice(dot + 1).toLowerCase()]
}

/**
 * Una línea de código como HTML con las clases `hljs-*` (highlight.js escapa el texto). Cada línea se resalta sola: un
 * string o un comentario de varias líneas puede salir sin color en las del medio, como pasa en un diff de GitHub.
 */
export function highlightLine(text: string, language: string | undefined): string | undefined {
  if (!language) return undefined
  try {
    return hljs.highlight(text, { language, ignoreIllegals: true }).value
  } catch {
    return undefined
  }
}

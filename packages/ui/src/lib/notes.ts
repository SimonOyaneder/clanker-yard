import type { CachedPr, Decision } from "@clanker/api"

/**
 * Las notas que pertenecen a un PR: las de corridas cuyo sujeto es el PR y las de la corrida de la issue
 * que lo originó (`CachedPr.issueId`), de la más reciente a la más antigua.
 */
export function notesOfPr(notes: readonly Decision[], pr: Pick<CachedPr, "id" | "issueId">): Decision[] {
  return notes.filter((n) => n.subject !== null && ((n.subject.type === "pr" && n.subject.id === pr.id) || (n.subject.type === "issue" && n.subject.id === pr.issueId)))
}

/** Agrupa las notas de una corrida por el paso que las reportó, en el orden en que aparece cada paso. */
export function groupByStep(notes: readonly Decision[]): { stepRunId: Decision["stepRunId"]; notes: Decision[] }[] {
  const groups = new Map<Decision["stepRunId"], Decision[]>()
  for (const note of notes) groups.set(note.stepRunId, [...(groups.get(note.stepRunId) ?? []), note])
  return [...groups].map(([stepRunId, list]) => ({ stepRunId, notes: list }))
}

const words = (title: string) =>
  new Set(
    title
      .normalize("NFD")
      .replace(/\p{M}/gu, "")
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter((w) => w.length > 2),
  )

/** Mismo título normalizado, o tan parecido que es la misma nota ("CI rojo ajeno" y "CI rojo ajeno o flaky"). */
function similarTitles(a: string, b: string): boolean {
  const [x, y] = [words(a), words(b)]
  if (x.size === 0 || y.size === 0) return a.trim().toLowerCase() === b.trim().toLowerCase()
  const shared = [...x].filter((w) => y.has(w)).length
  return shared / (x.size + y.size - shared) >= 0.6
}

/**
 * En cuántas otras corridas del mismo proyecto se repite una nota (notas del entorno como "Doppler en el
 * worktree"): la vista dice "también en n corridas" en vez de repetirla como si fuera nueva.
 */
export function alsoInRuns(note: Decision, projectNotes: readonly Decision[]): number {
  const runs = new Set(projectNotes.filter((n) => n.runId !== null && n.runId !== note.runId && similarTitles(n.title, note.title)).map((n) => n.runId))
  return runs.size
}

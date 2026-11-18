import type { CachedIssue, CachedPr, Run } from "@clanker/api"
import { issueKey } from "@/lib/format"

/** Cómo se nombra el sujeto de una corrida: una clave corta y el título de lo que trabaja. */
export interface SubjectLabel {
  key: string
  title: string
}

/**
 * Nombra el sujeto de cada corrida. Una corrida de issue lleva su clave y su título; una de mantenimiento
 * sobre un PR lleva `repo#número` y el título de la issue que lo abrió (o el del PR), y si el PR ya se cerró o se
 * mergeó, lo dice. Si el caché no lo tiene, también lo dice.
 */
export function subjectLabeler(issues: readonly CachedIssue[], prs: readonly CachedPr[]): (run: Pick<Run, "subject">) => SubjectLabel {
  const issueById = new Map<string, CachedIssue>(issues.map((i) => [i.id, i]))
  const prById = new Map(prs.map((p) => [p.id, p]))
  const ofIssue = (issue: CachedIssue): SubjectLabel => ({ key: issueKey(issue), title: issue.title })
  return ({ subject }) => {
    if (subject.type === "issue") {
      const issue = issueById.get(subject.id)
      return issue ? ofIssue(issue) : { key: subject.id, title: "issue fuera del caché" }
    }
    const pr = prById.get(subject.id)
    if (pr?.local) return { key: pr.local.branch, title: pr.local.title }
    if (!pr?.ref) return { key: "PR", title: "un PR que Clanker Yard ya no tiene" }
    const issue = pr.issueId === null ? undefined : issueById.get(pr.issueId)
    const title = issue?.title ?? pr.state?.title ?? "PR sin issue en el caché"
    const closed = pr.state?.state === "merged" ? " (mergeado)" : pr.state?.state === "closed" ? " (cerrado)" : ""
    return { key: `${pr.ref.repo.split("/").pop()}#${pr.ref.number}`, title: `${title}${closed}` }
  }
}

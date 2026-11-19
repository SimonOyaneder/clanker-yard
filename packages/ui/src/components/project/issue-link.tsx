import type { CachedIssue } from "@clanker/api"
import { ListTodo } from "lucide-react"
import { Button } from "@/components/ui/button"
import { useAppActions } from "@/lib/app-context"
import { issueKey } from "@/lib/format"

/** La clave abre la ficha de Yard también cuando la issue no tiene tracker externo. */
export function IssueLink({ issue }: { issue: CachedIssue }) {
  const actions = useAppActions()
  return (
    <Button size="xs" variant="ghost" className="max-w-full font-mono" aria-label={`Ver issue ${issueKey(issue)}`} onClick={() => actions.openIssue(issue)}>
      <ListTodo /><span className="truncate">{issueKey(issue)}</span>
    </Button>
  )
}

import { GitPullRequest } from "lucide-react"
import { usePrActions } from "@/components/prs/pr-commands"
import { Button } from "@/components/ui/button"
import { keyOf, type OpenPr } from "@/lib/prs/prs"

export function PrLink({ pr }: { pr: OpenPr }) {
  const commands = usePrActions()
  return (
    <Button size="xs" variant="ghost" className="min-w-0 font-mono" aria-label={`Ver PR ${keyOf(pr)}`} onClick={() => commands.view(pr)}>
      <GitPullRequest /><span className="truncate">{keyOf(pr)}</span>
    </Button>
  )
}

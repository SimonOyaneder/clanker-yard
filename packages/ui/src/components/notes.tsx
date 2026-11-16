import type { Decision } from "@clanker/api"
import { Ago } from "@/components/common"

/** Una nota del agente: su título, el detalle si lo trae y en cuántas otras corridas se repite. */
export function NoteItem({ note, also = 0 }: { note: Decision; also?: number }) {
  return (
    <li className="flex flex-col gap-0.5 py-2">
      <p className="text-[13px] font-medium">{note.title}</p>
      {note.body ? <p className="text-xs whitespace-pre-line text-muted-foreground">{note.body}</p> : null}
      <p className="flex gap-2 text-[11px] text-muted-foreground">
        <Ago at={note.createdAt} />
        {also > 0 ? <span>también en {also === 1 ? "1 corrida" : `${also} corridas`}</span> : null}
      </p>
    </li>
  )
}

import { Ellipsis } from "lucide-react"
import type { ReactNode } from "react"
import { Hint, Pill } from "@/components/common"
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog"
import { Button } from "@/components/ui/button"
import { Card } from "@/components/ui/card"
import { ContextMenu, ContextMenuContent, ContextMenuItem, ContextMenuSeparator, ContextMenuTrigger } from "@/components/ui/context-menu"
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu"
import type { ChipLook } from "@/lib/connections"

export interface CardAction {
  label: string
  icon: ReactNode
  onSelect: () => void
  destructive?: boolean
  disabled?: boolean
}

interface Props {
  icon: ReactNode
  title: string
  /** La cuenta conectada, junto al título. */
  account?: string
  status: ChipLook
  /** Otros chips (vencimiento, plan, versión), ya como `Pill`. */
  chips?: ReactNode
  /** El botón principal; el resto de las acciones va en el menú "…" y en el menú contextual. */
  primary: ReactNode
  menu: CardAction[]
  children: ReactNode
}

// Una conexión (GitHub, Linear, Claude) con su estado y sus acciones. Lo destructivo va al final del menú.
export function ConnectionCard({ icon, title, account, status, chips, primary, menu, children }: Props) {
  const safe = menu.filter((a) => !a.destructive)
  const destructive = menu.filter((a) => a.destructive)
  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>
        <Card role="group" aria-label={title} className="gap-0 py-0">
          <header className="flex items-center gap-3 border-b px-4 py-3">
            <span className="grid size-8 flex-none place-items-center rounded-md bg-muted text-muted-foreground">{icon}</span>
            <div className="flex min-w-0 flex-1 flex-col gap-1">
              <div className="flex items-center gap-2">
                <h2 className="text-[13px] font-semibold">{title}</h2>
                {account ? <span className="truncate font-mono text-xs text-muted-foreground">{account}</span> : null}
              </div>
              <div className="flex flex-wrap items-center gap-1.5">
                <Pill className={status.tone} hint={status.hint}>
                  {status.label}
                </Pill>
                {chips}
              </div>
            </div>
            {primary}
            {menu.length ? (
              <DropdownMenu>
                <Hint label="Más acciones" side="top">
                  <DropdownMenuTrigger asChild>
                    <Button variant="ghost" size="icon-sm" aria-label={`Más acciones de ${title}`}>
                      <Ellipsis />
                    </Button>
                  </DropdownMenuTrigger>
                </Hint>
                <DropdownMenuContent align="end" className="w-60">
                  {safe.map((a) => (
                    <DropdownMenuItem key={a.label} disabled={a.disabled} onSelect={a.onSelect}>
                      {a.icon} {a.label}
                    </DropdownMenuItem>
                  ))}
                  {safe.length && destructive.length ? <DropdownMenuSeparator /> : null}
                  {destructive.map((a) => (
                    <DropdownMenuItem key={a.label} variant="destructive" disabled={a.disabled} onSelect={a.onSelect}>
                      {a.icon} {a.label}
                    </DropdownMenuItem>
                  ))}
                </DropdownMenuContent>
              </DropdownMenu>
            ) : null}
          </header>
          <div className="flex flex-col gap-3 px-4 py-3 text-[13px]">{children}</div>
        </Card>
      </ContextMenuTrigger>
      <ContextMenuContent className="w-60">
        {safe.map((a) => (
          <ContextMenuItem key={a.label} disabled={a.disabled} onSelect={a.onSelect}>
            {a.icon} {a.label}
          </ContextMenuItem>
        ))}
        {safe.length && destructive.length ? <ContextMenuSeparator /> : null}
        {destructive.map((a) => (
          <ContextMenuItem key={a.label} variant="destructive" disabled={a.disabled} onSelect={a.onSelect}>
            {a.icon} {a.label}
          </ContextMenuItem>
        ))}
      </ContextMenuContent>
    </ContextMenu>
  )
}

/** Lo destructivo pide confirmación: el token se borra y las corridas que lo usan esperan. */
export function ConfirmDisconnect({
  title,
  description,
  action = "Desconectar",
  onOpenChange,
  onConfirm,
}: {
  /** Mientras no sea `null` el diálogo está abierto. */
  title: string | null
  description: string
  action?: string
  onOpenChange: (open: boolean) => void
  onConfirm: () => void
}) {
  return (
    <AlertDialog open={title !== null} onOpenChange={onOpenChange}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{title}</AlertDialogTitle>
          <AlertDialogDescription>{description}</AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>Cancelar</AlertDialogCancel>
          <AlertDialogAction className="bg-destructive text-white hover:bg-destructive/90" onClick={onConfirm}>
            {action}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}

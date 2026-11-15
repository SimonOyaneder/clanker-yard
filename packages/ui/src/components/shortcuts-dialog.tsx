import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Shortcut } from "./common"

const SECTIONS: { title: string; items: [string, string][] }[] = [
  {
    title: "General",
    items: [
      ["Paleta de comandos", "⌘K"],
      ["Nuevo proyecto", "⌘N"],
      ["Actualizar datos", "⌘R"],
      ["Mostrar u ocultar barra lateral", "⌘B"],
      ["Atajos de teclado", "⌘/"],
    ],
  },
  {
    title: "Navegación",
    items: [
      ["Stacks de PR", "⇧⌘P"],
      ["Ir al proyecto 1…9 de la barra", "⌘1"],
      ["Atrás (también ⌘[ y el botón de pulgar trasero)", "⌘←"],
      ["Adelante (también ⌘] y el botón de pulgar delantero)", "⌘→"],
      ["Volver de la corrida al proyecto (sin diálogos abiertos)", "⎋"],
    ],
  },
  {
    title: "Corrida",
    items: [
      ["Ver el grafo del flujo", "G"],
      ["Ver la línea de tiempo", "L"],
    ],
  },
  {
    title: "Ventana",
    items: [
      ["Acercar / alejar", "⌘+"],
      ["Tamaño real", "⌘0"],
      ["Pantalla completa", "⌃⌘F"],
    ],
  },
]

export function ShortcutsDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[460px]">
        <DialogHeader>
          <DialogTitle>Atajos de teclado</DialogTitle>
          <DialogDescription>También están en el menú de la app. Click derecho en un proyecto, una corrida o una issue para más acciones.</DialogDescription>
        </DialogHeader>
        <div className="flex flex-col gap-4">
          {SECTIONS.map((s) => (
            <section key={s.title} className="flex flex-col gap-1">
              <h3 className="text-xs font-medium text-muted-foreground">{s.title}</h3>
              <ul>
                {s.items.map(([label, keys]) => (
                  <li key={label} className="flex h-8 items-center justify-between border-b border-border/60 last:border-b-0">
                    <span>{label}</span>
                    <Shortcut keys={keys} />
                  </li>
                ))}
              </ul>
            </section>
          ))}
        </div>
      </DialogContent>
    </Dialog>
  )
}

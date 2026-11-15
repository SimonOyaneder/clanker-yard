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
      ["Bandeja (también G y luego I)", "⇧⌘I"],
      ["Stacks de PR", "⇧⌘P"],
      ["Conexiones (G y luego C)", "GC"],
      ["Ir al proyecto 1…9 de la barra", "⌘1"],
      ["Atrás (también ⌘[ y el botón de pulgar trasero)", "⌘←"],
      ["Adelante (también ⌘] y el botón de pulgar delantero)", "⌘→"],
      ["Cerrar el panel del paso, o volver de la corrida al proyecto (sin diálogos abiertos)", "⎋"],
    ],
  },
  {
    title: "Corrida",
    items: [
      ["Ver el grafo del flujo", "G"],
      ["Ver la línea de tiempo", "L"],
      ["Abrir el panel del paso enfocado en el grafo", "⏎"],
      ["Interrumpir al agente en curso (confirma)", "⌘."],
      ["Pausar o retomar la corrida", "⇧⌘."],
      ["Reintentar el paso fallido", "⇧⌘R"],
      ["Cancelar la corrida (confirma)", "⇧⌘⌫"],
    ],
  },
  {
    title: "Proyecto",
    items: [["Pausar o reanudar el proyecto", "⇧⌘Y"]],
  },
  {
    title: "Panel del paso",
    items: [
      ["Transcript (o comando en una acción)", "T"],
      ["Brief que recibió", "B"],
      ["Reporte", "R"],
      ["Artefactos", "A"],
      ["Intentos", "I"],
    ],
  },
  {
    title: "Bandeja",
    items: [
      ["Decisión siguiente / anterior", "JK"],
      ["Elegir una opción de la decisión", "1"],
      ["Responder con texto libre", "R"],
      ["Abrir la corrida de la decisión", "⏎"],
      ["Deshacer la última respuesta (unos segundos)", "Z"],
    ],
  },
  {
    title: "Conexiones",
    items: [
      ["Conectar con Linear", "⇧⌘L"],
      ["Probar Claude (llamada mínima, gasta un poco de cuota)", "⇧⌘T"],
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

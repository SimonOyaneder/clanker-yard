import type { Host } from "./host"

// Para desarrollar la UI sola en el navegador: no hay menú, notificaciones ni editor.
export const browserHost: Host = {
  onMenu: () => () => {},
  onNavigate: () => () => {},
  notify: () => {},
  openExternal: (url) => void window.open(url, "_blank", "noopener,noreferrer"),
  openInEditor: () => {},
  setTheme: () => {},
}

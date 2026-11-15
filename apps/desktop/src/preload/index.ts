import type { CoreState, MenuAction, NavTarget, Theme } from "@clanker/ui";
import { contextBridge, ipcRenderer } from "electron";

// Suscripción a un canal del main; devuelve cómo cancelarla.
function on<T>(channel: string, cb: (payload: T) => void): () => void {
  const handler = (_e: Electron.IpcRendererEvent, payload: T) => cb(payload);
  ipcRenderer.on(channel, handler);
  return () => ipcRenderer.removeListener(channel, handler);
}

// Todo lo que la ventana puede pedirle al main. Del core solo llega su estado: el token y el puerto
// se quedan en el main, que los pone en cada llamada a `clanker-core://`.
const bridge = {
  onMenu: (cb: (action: MenuAction) => void) => on("menu", cb),
  onNavigate: (cb: (target: NavTarget) => void) => on("navigate", cb),
  notify: (n: { title: string; body: string; target?: NavTarget }) => ipcRenderer.send("host:notify", n),
  openExternal: (url: string) => ipcRenderer.send("host:open-external", url),
  openInEditor: (path: string) => ipcRenderer.send("host:open-in-editor", path),
  setTheme: (theme: Theme) => ipcRenderer.send("host:set-theme", theme),
  core: {
    // Entrega el estado actual y cada cambio. Un cambio que llega antes de la respuesta inicial gana.
    onState(cb: (state: CoreState) => void): () => void {
      let pushed = false;
      const off = on<CoreState>("core:state", (state) => {
        pushed = true;
        cb(state);
      });
      void ipcRenderer.invoke("core:state").then((state: CoreState) => {
        if (!pushed) cb(state);
      });
      return off;
    },
    retry: () => ipcRenderer.send("core:retry"),
    openLogs: () => ipcRenderer.send("core:open-logs"),
  },
};

export type ClankerBridge = typeof bridge;

contextBridge.exposeInMainWorld("clanker", bridge);

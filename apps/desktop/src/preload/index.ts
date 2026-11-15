import type { MenuAction, Theme } from "@clanker/ui";
import { contextBridge, ipcRenderer } from "electron";

type Target = { slug: string; issueId?: string };

export type CoreState =
  | { status: "starting" }
  | { status: "live"; version: string; port: number; token: string; bootId: string }
  | { status: "down"; reason: string };

// Suscripción a un canal del main; devuelve cómo cancelarla.
function on<T>(channel: string, cb: (payload: T) => void): () => void {
  const handler = (_e: Electron.IpcRendererEvent, payload: T) => cb(payload);
  ipcRenderer.on(channel, handler);
  return () => ipcRenderer.removeListener(channel, handler);
}

// Todo lo que la ventana puede pedirle al main. `port` y `token` del core llegan en el estado `live`.
const bridge = {
  onMenu: (cb: (action: MenuAction) => void) => on("menu", cb),
  onNavigate: (cb: (target: Target) => void) => on("navigate", cb),
  notify: (n: { title: string; body: string; target?: Target }) => ipcRenderer.send("host:notify", n),
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

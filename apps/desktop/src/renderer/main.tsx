import "@clanker/ui/styles.css";
import { createClient } from "@clanker/api";
import { App, createCoreAppData, type CoreLink, type CoreState, type Host } from "@clanker/ui";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

const { clanker } = window;

// El core que lanza y vigila el proceso main. La UI solo necesita saber si está vivo: la API la llama por
// `clanker-core://`, donde el main pone el token y el puerto del core de turno.
function coreLink(): CoreLink {
  let state: CoreState = { status: "starting" };
  const listeners = new Set<() => void>();
  clanker.core.onState((next) => {
    state = next.status === "live" ? { status: "live", version: next.version } : next;
    for (const cb of listeners) cb();
  });
  return {
    state: () => state,
    subscribe(cb) {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    retry: clanker.core.retry,
    openLogs: clanker.core.openLogs,
  };
}

const host: Host = {
  core: coreLink(),
  onMenu: clanker.onMenu,
  onNavigate: clanker.onNavigate,
  notify: clanker.notify,
  openExternal: clanker.openExternal,
  openInEditor: clanker.openInEditor,
  setTheme: clanker.setTheme,
};

// El main reemplaza el token por el real: la ventana nunca lo conoce.
const client = createClient({ url: "clanker-core://core/rpc", token: "lo-pone-el-main", origin: "ui" });

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App appData={createCoreAppData(client)} host={host} />
  </StrictMode>,
);

import "@clanker/ui/styles.css";
import { App, createMemoryAppData, type CoreLink, type CoreState, type Host } from "@clanker/ui";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

const { clanker } = window;

// El core que lanza y vigila el proceso main. La UI solo necesita saber si está vivo; `port` y `token`
// (en el estado `live` del preload) son para el `AppData` que hable con la API.
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

// Los datos siguen siendo los de ejemplo en memoria hasta que exista el `AppData` sobre la API del core.
createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App appData={createMemoryAppData()} host={host} />
  </StrictMode>,
);

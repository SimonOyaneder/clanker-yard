import { existsSync } from "node:fs";
import path from "node:path";
import { clankerDirs } from "@clanker/api/node";
import type { MenuAction, Theme } from "@clanker/ui";
import { app, BrowserWindow, dialog, ipcMain, nativeTheme, shell } from "electron";
import { createCoreSupervisor } from "./core-supervisor";
import { registerHostIpc } from "./host-ipc";
import { buildMenu } from "./menu";
import { createPrefs } from "./prefs";
import { createMainWindow } from "./window";

const devUrl = process.env.ELECTRON_RENDERER_URL;
const dirs = clankerDirs();

// Lo de Electron (cachés, preferencias) va en una subcarpeta de los datos de Clanker Yard: con
// `CLANKER_HOME` un arranque de prueba no toca nada del usuario.
app.setName("Clanker Yard");
app.setPath("userData", path.join(dirs.dataDir, "desktop"));

const prefs = createPrefs(path.join(app.getPath("userData"), "prefs.json"));

// El core se lanza como proceso (nunca se importa): en desarrollo es el bundle que deja `npm run build -w @clanker/core`.
const supervisor = createCoreSupervisor({
  dataDir: dirs.dataDir,
  logDir: dirs.logDir,
  entry: path.resolve(app.getAppPath(), "../../packages/core/dist/main.js"),
});

let mainWindow: BrowserWindow | null = null;
const send = (channel: string, payload: unknown) => mainWindow?.webContents.send(channel, payload);

function setTheme(theme: Theme): void {
  nativeTheme.themeSource = theme;
  prefs.set("theme", theme);
  refreshMenu();
}

const getTheme = (): Theme => {
  const theme = prefs.get<string>("theme", "system");
  return theme === "light" || theme === "dark" ? theme : "system";
};

function openLogs(): void {
  const log = path.join(dirs.logDir, "core.log");
  void shell.openPath(existsSync(log) ? log : dirs.logDir);
}

// "Salir y detener agentes": el cierre normal de la app no toca el core.
async function quitAndStopAgents(): Promise<void> {
  try {
    await supervisor.shutdownCore();
  } catch (error) {
    dialog.showErrorBox("No se pudo detener el core", error instanceof Error ? error.message : String(error));
    return;
  }
  app.quit();
}

function refreshMenu(): void {
  buildMenu({
    send: (action: MenuAction) => send("menu", action),
    theme: getTheme(),
    setTheme,
    openLogs,
    quitAndStopAgents: () => void quitAndStopAgents(),
    devTools: !!devUrl,
  });
}

function openMainWindow(): void {
  mainWindow = createMainWindow(prefs, {
    preload: path.join(import.meta.dirname, "../preload/index.cjs"),
    backgroundColor: nativeTheme.shouldUseDarkColors ? "#111114" : "#fcfcfd",
  });
  mainWindow.on("closed", () => (mainWindow = null));
  if (devUrl) void mainWindow.loadURL(devUrl);
  else void mainWindow.loadFile(path.join(import.meta.dirname, "../renderer/index.html"));
}

void app.whenReady().then(() => {
  nativeTheme.themeSource = getTheme();
  nativeTheme.on("updated", () => mainWindow?.setBackgroundColor(nativeTheme.shouldUseDarkColors ? "#111114" : "#fcfcfd"));

  ipcMain.handle("core:state", () => supervisor.state());
  ipcMain.on("core:retry", () => void supervisor.start());
  ipcMain.on("core:open-logs", openLogs);
  supervisor.onChange((state) => send("core:state", state));
  registerHostIpc({ getWindow: () => mainWindow, setTheme });

  refreshMenu();
  openMainWindow();
  void supervisor.start();

  app.on("activate", () => {
    if (!BrowserWindow.getAllWindows().length) openMainWindow();
    else mainWindow?.show();
  });
});

// Cerrar la ventana (o la app) no detiene el core: los flujos siguen.
app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
app.on("before-quit", () => supervisor.close());

// La UI no navega fuera de la app ni abre ventanas: los links pasan por `Host.openExternal`.
app.on("web-contents-created", (_event, contents) => {
  contents.setWindowOpenHandler(() => ({ action: "deny" }));
  contents.on("will-navigate", (event, url) => {
    const ok = url.startsWith("file://") || (!!devUrl && url.startsWith(devUrl));
    if (!ok) event.preventDefault();
  });
});

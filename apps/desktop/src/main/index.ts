import { existsSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { clankerDirs, isolatedUiKey } from "@clanker/api/node";
import type { MenuAction, Theme } from "@clanker/ui";
import { app, BrowserWindow, dialog, ipcMain, nativeTheme, protocol, safeStorage, shell } from "electron";
import { linkCli } from "./cli-link";
import { coreEntry } from "./core-entry";
import { CORE_SCHEME, createCoreProxy, windowCoreState } from "./core-proxy";
import { createCoreSupervisor, type CoreSupervisor } from "./core-supervisor";
import { isE2E } from "./e2e";
import { registerHostIpc } from "./host-ipc";
import { loginEnv } from "./login-env";
import { buildMenu } from "./menu";
import { createPrefs } from "./prefs";
import { loadUiKey } from "./ui-key";
import { createMainWindow } from "./window";

const devUrl = process.env.ELECTRON_RENDERER_URL;
const dirs = clankerDirs();

// En los E2E la app no entra al Dock ni a la barra de menú: macOS no la activa al lanzarla y no le quita el foco a nadie.
if (isE2E && process.platform === "darwin") app.setActivationPolicy("accessory");

// Abierta desde el Dock, la app hereda un PATH mínimo y ningún LANG: el core no encontraría `claude` ni `gh`.
if (app.isPackaged) Object.assign(process.env, loginEnv(process.env));

// Lo de Electron (cachés, preferencias) va en una subcarpeta de los datos de Clanker Yard: con
// `CLANKER_HOME` un arranque de prueba no toca nada del usuario.
app.setName("Clanker Yard");
app.setPath("userData", path.join(dirs.dataDir, "desktop"));

const prefs = createPrefs(path.join(app.getPath("userData"), "prefs.json"));

// Se arman al estar `ready`: `safeStorage` (la llave de la app) no está antes.
let supervisor: CoreSupervisor;
let uiKey: string;

// La ventana llama a la API del core por `clanker-core://`: el proxy pone el token y el puerto vigentes.
// El esquema se declara antes de `ready`.
protocol.registerSchemesAsPrivileged([{ scheme: CORE_SCHEME, privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true } }]);

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

// El lanzador `clanker` vive dentro de la app (`resources/bin`); el symlink lo hace alcanzable desde una terminal y desde `.mcp.json`.
function installCli(): void {
  if (!app.isPackaged) {
    dialog.showErrorBox("Comando clanker", "Solo la app instalada trae el lanzador. En desarrollo: npm run build -w @clanker/cli && npm link -w @clanker/cli.");
    return;
  }
  try {
    const { link, onPath } = linkCli({
      launcher: path.join(process.resourcesPath, "bin/clanker"),
      binDir: path.join(homedir(), ".local/bin"),
      pathEnv: process.env.PATH,
    });
    void dialog.showMessageBox({
      message: `Comando instalado en ${link}`,
      detail: onPath ? "Ya puedes correr `clanker --help` en una terminal nueva." : `${path.dirname(link)} no está en tu PATH: agrégalo a tu shell para usar \`clanker\`.`,
    });
  } catch (error) {
    dialog.showErrorBox("No se pudo instalar el comando clanker", error instanceof Error ? error.message : String(error));
  }
}

function refreshMenu(): void {
  buildMenu({
    send: (action: MenuAction) => send("menu", action),
    theme: getTheme(),
    setTheme,
    openLogs,
    installCli,
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
  // Con `CLANKER_HOME` no se toca el llavero.
  uiKey = process.env.CLANKER_HOME ? isolatedUiKey(process.env.CLANKER_HOME) : loadUiKey(path.join(app.getPath("userData"), "ui-key"), safeStorage);
  // El core se lanza como proceso (nunca se importa).
  supervisor = createCoreSupervisor({
    dataDir: dirs.dataDir,
    logDir: dirs.logDir,
    entry: coreEntry({ isPackaged: app.isPackaged, appPath: app.getAppPath(), resourcesPath: process.resourcesPath }),
    uiKey,
  });
  nativeTheme.themeSource = getTheme();
  nativeTheme.on("updated", () => mainWindow?.setBackgroundColor(nativeTheme.shouldUseDarkColors ? "#111114" : "#fcfcfd"));

  protocol.handle(
    CORE_SCHEME,
    createCoreProxy({
      uiKey,
      endpoint: () => {
        const state = supervisor.state();
        return state.status === "live" ? { port: state.port, token: state.token } : undefined;
      },
    }),
  );
  ipcMain.handle("core:state", () => windowCoreState(supervisor.state()));
  ipcMain.on("core:retry", () => void supervisor.start());
  ipcMain.on("core:open-logs", openLogs);
  supervisor.onChange((state) => send("core:state", windowCoreState(state)));
  app.on("before-quit", () => supervisor.close());
  registerHostIpc({ getWindow: () => mainWindow, setTheme });

  refreshMenu();
  openMainWindow();
  void supervisor.start();

  app.on("activate", () => {
    if (!BrowserWindow.getAllWindows().length) openMainWindow();
    else if (!isE2E) mainWindow?.show();
  });
});

// Cerrar la ventana (o la app) no detiene el core: los flujos siguen.
app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

// La UI no navega fuera de la app ni abre ventanas: los links pasan por `Host.openExternal`.
app.on("web-contents-created", (_event, contents) => {
  contents.setWindowOpenHandler(() => ({ action: "deny" }));
  contents.on("will-navigate", (event, url) => {
    const ok = url.startsWith("file://") || (!!devUrl && url.startsWith(devUrl));
    if (!ok) event.preventDefault();
  });
});

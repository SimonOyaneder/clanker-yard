import { BrowserWindow, screen, type Rectangle } from "electron";
import type { Prefs } from "./prefs";

const WINDOW_STATE = "window-state";

function visibleOnSomeDisplay(r: Rectangle): boolean {
  return screen.getAllDisplays().some((d) => {
    const w = d.workArea;
    return r.x < w.x + w.width && r.x + r.width > w.x && r.y < w.y + w.height && r.y + r.height > w.y;
  });
}

/** Ventana principal: recuerda su posición y tamaño, y no se muestra hasta tener el primer frame para no parpadear. */
export function createMainWindow(prefs: Prefs, opts: { preload: string; backgroundColor: string }): BrowserWindow {
  const saved = prefs.get<Rectangle | null>(WINDOW_STATE, null);
  const win = new BrowserWindow({
    width: 1440,
    height: 900,
    ...(saved && visibleOnSomeDisplay(saved) ? saved : {}),
    minWidth: 1024,
    minHeight: 640,
    backgroundColor: opts.backgroundColor,
    title: "Clanker Yard",
    titleBarStyle: "hiddenInset",
    trafficLightPosition: { x: 16, y: 15 },
    show: false,
    webPreferences: { preload: opts.preload, contextIsolation: true, nodeIntegration: false, sandbox: true, spellcheck: false },
  });
  win.once("ready-to-show", () => win.show());
  // Un estado con la ventana minimizada o maximizada no tiene un rectángulo útil: se guarda el normal.
  win.on("close", () => prefs.set(WINDOW_STATE, win.getNormalBounds()));
  // Logi Options+ convierte los botones de pulgar en gestos de swipe (NSEvent) en vez de los botones 4 y 5.
  // Misma dirección que VS Code (`swipeToNavigate`): left = atrás.
  win.on("swipe", (_e, direction) => {
    if (direction === "left") win.webContents.send("menu", "back");
    else if (direction === "right") win.webContents.send("menu", "forward");
  });
  return win;
}

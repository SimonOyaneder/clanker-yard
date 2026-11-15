import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { BrowserWindow, dialog, ipcMain, Notification, shell } from "electron";
import type { Theme } from "@clanker/ui";

const THEMES: readonly Theme[] = ["system", "light", "dark"];
const EDITORS = ["Zed", "Cursor", "Visual Studio Code"];

interface Target {
  slug: string;
  issueId?: string;
}

const isTarget = (v: unknown): v is Target =>
  typeof v === "object" && v !== null && typeof (v as Target).slug === "string" && ((v as Target).issueId === undefined || typeof (v as Target).issueId === "string");

export interface HostIpcOptions {
  getWindow(): BrowserWindow | null;
  setTheme(theme: Theme): void;
}

/** Lo propio del sistema que la UI pide por la interfaz `Host` (`packages/ui/src/host.ts`). La UI no es de confianza: cada payload se valida. */
export function registerHostIpc(opts: HostIpcOptions): void {
  // Una notificación sin referencia puede recogerla el GC antes del click.
  const live = new Set<Notification>();

  ipcMain.on("host:notify", (_e, n: unknown) => {
    const { title, body, target } = (n ?? {}) as { title?: unknown; body?: unknown; target?: unknown };
    if (typeof title !== "string" || typeof body !== "string" || !Notification.isSupported()) return;
    const notification = new Notification({ title, body });
    live.add(notification);
    notification.on("close", () => live.delete(notification));
    notification.on("click", () => {
      live.delete(notification);
      const win = opts.getWindow();
      if (!win) return;
      if (win.isMinimized()) win.restore();
      win.show();
      win.focus();
      if (isTarget(target)) win.webContents.send("navigate", target);
    });
    notification.show();
  });

  ipcMain.on("host:open-external", (_e, raw: unknown) => {
    if (typeof raw !== "string") return;
    let url: URL;
    try {
      url = new URL(raw);
    } catch {
      return;
    }
    if (url.protocol === "https:") void shell.openExternal(url.toString());
  });

  ipcMain.on("host:open-in-editor", (_e, raw: unknown) => {
    if (typeof raw !== "string" || !path.isAbsolute(raw)) return;
    void openInEditor(raw);
  });

  ipcMain.on("host:set-theme", (_e, theme: unknown) => {
    if (THEMES.includes(theme as Theme)) opts.setTheme(theme as Theme);
  });
}

async function openInEditor(target: string): Promise<void> {
  if (!existsSync(target)) return failed(`La ruta ya no existe: ${target}`);
  const editor = EDITORS.find((name) => existsSync(`/Applications/${name}.app`));
  if (!editor) {
    const error = await shell.openPath(target);
    if (error) failed(error);
    return;
  }
  execFile("open", ["-a", editor, target], (error) => {
    if (error) failed(error.message);
  });
}

const failed = (message: string) => dialog.showErrorBox("No se pudo abrir en el editor", message);

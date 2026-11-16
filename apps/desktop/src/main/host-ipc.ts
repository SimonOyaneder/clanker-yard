import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { BrowserWindow, dialog, ipcMain, Notification, shell } from "electron";
import type { Theme } from "@clanker/ui";
import { editorTarget, isTarget, isTheme, safeExternalUrl } from "./host-guards";

const EDITORS = ["Zed", "Cursor", "Visual Studio Code"];

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
    const url = safeExternalUrl(raw);
    if (url !== undefined) void shell.openExternal(url);
  });

  ipcMain.on("host:open-in-editor", (_e, raw: unknown) => {
    const target = editorTarget(raw);
    if (target !== undefined) void openInEditor(target);
  });

  // El payload no lleva nada: la ventana solo pide el selector, y la ruta que vuelve la valida el core al registrar el repo.
  ipcMain.handle("host:pick-directory", async (e) => {
    const win = BrowserWindow.fromWebContents(e.sender) ?? opts.getWindow();
    const options = { properties: ["openDirectory" as const] };
    const { canceled, filePaths } = win ? await dialog.showOpenDialog(win, options) : await dialog.showOpenDialog(options);
    return canceled ? null : (filePaths[0] ?? null);
  });

  ipcMain.on("host:set-theme", (_e, theme: unknown) => {
    if (isTheme(theme)) opts.setTheme(theme);
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

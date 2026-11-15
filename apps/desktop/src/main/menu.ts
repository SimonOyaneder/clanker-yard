import { app, Menu, type MenuItemConstructorOptions } from "electron";
import type { MenuAction, Theme } from "@clanker/ui";

export interface MenuHandlers {
  send(action: MenuAction): void;
  theme: Theme;
  setTheme(theme: Theme): void;
  openLogs(): void;
  installCli(): void;
  quitAndStopAgents(): void;
  devTools: boolean;
}

export function buildMenu(h: MenuHandlers): void {
  const themeItem = (label: string, value: Theme): MenuItemConstructorOptions => ({
    label,
    type: "radio",
    checked: h.theme === value,
    click: () => h.setTheme(value),
  });

  const template: MenuItemConstructorOptions[] = [
    { role: "appMenu" },
    {
      label: "Archivo",
      submenu: [
        { label: "Nuevo proyecto…", accelerator: "CmdOrCtrl+N", click: () => h.send("new-project") },
        { type: "separator" },
        { label: "Ver logs del core", click: h.openLogs },
        { label: "Instalar comando clanker…", click: h.installCli },
        // Cerrar la ventana o salir con ⌘Q deja el core y sus flujos corriendo; esto los apaga.
        { label: "Salir y detener agentes", accelerator: "Alt+CmdOrCtrl+Q", click: h.quitAndStopAgents },
        { type: "separator" },
        { role: "close", label: "Cerrar ventana" },
      ],
    },
    { role: "editMenu", label: "Edición" },
    {
      label: "Ver",
      submenu: [
        { label: "Paleta de comandos…", accelerator: "CmdOrCtrl+K", click: () => h.send("command") },
        // ⌘R actualiza los datos; no recarga la página (eso te sacaría de la vista donde estabas).
        { label: "Actualizar", accelerator: "CmdOrCtrl+R", click: () => h.send("refresh") },
        { label: "Mostrar u ocultar barra lateral", accelerator: "CmdOrCtrl+B", click: () => h.send("toggle-sidebar") },
        { type: "separator" },
        {
          label: "Apariencia",
          submenu: [themeItem("Igual que el sistema", "system"), themeItem("Clara", "light"), themeItem("Oscura", "dark")],
        },
        { type: "separator" },
        { role: "resetZoom", label: "Tamaño real" },
        { role: "zoomIn", label: "Acercar" },
        { role: "zoomOut", label: "Alejar" },
        { type: "separator" },
        { role: "togglefullscreen", label: "Pantalla completa" },
        ...(h.devTools ? ([{ type: "separator" }, { role: "toggleDevTools" }, { role: "forceReload" }] as MenuItemConstructorOptions[]) : []),
      ],
    },
    {
      label: "Ir",
      submenu: [
        // ⌘← / ⌘→ los maneja la UI (fuera de campos de texto); en el menú quedan ⌘[ / ⌘].
        { label: "Atrás", accelerator: "CmdOrCtrl+[", click: () => h.send("back") },
        { label: "Adelante", accelerator: "CmdOrCtrl+]", click: () => h.send("forward") },
        { type: "separator" },
        { label: "Bandeja", accelerator: "CmdOrCtrl+Shift+I", click: () => h.send("go-inbox") },
        { label: "Stacks de PR", accelerator: "CmdOrCtrl+Shift+P", click: () => h.send("go-prs") },
      ],
    },
    { role: "windowMenu", label: "Ventana" },
    {
      role: "help",
      label: "Ayuda",
      submenu: [{ label: "Atajos de teclado", accelerator: "CmdOrCtrl+/", click: () => h.send("shortcuts") }],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
  app.setName("Clanker Yard");
}

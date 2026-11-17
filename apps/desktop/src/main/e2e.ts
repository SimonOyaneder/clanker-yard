import { app } from "electron";

/**
 * `CLANKER_E2E=1` lo pone solo el harness de los E2E (`e2e/harness.ts`): la app corre con la ventana offscreen y sin mostrarla, sin ícono en
 * el Dock y sin notificaciones, para no quitarle el foco a quien está trabajando. Playwright maneja la ventana por CDP, que
 * no necesita verla. Una app empaquetada nunca entra en este modo.
 */
export const isE2E = process.env.CLANKER_E2E === "1" && !app.isPackaged;

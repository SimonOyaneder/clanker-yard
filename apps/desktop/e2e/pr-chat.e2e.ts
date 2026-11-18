import type { Page } from "@playwright/test";
import { expect, setTheme, snap, test } from "./harness";

// El chat de un PR contra el escenario `prs` del core de demo: el agente es el fake con los guiones de
// `packages/testkit/fixtures/runs/chat-demo` (un turno que propone, uno que solo responde y uno que rehace una propuesta que
// quedó atrás), y aplicar corre `chat-aplicar` o `chat-aplicar-local` de verdad contra el bare del demo y el GitHub simulado.
test.use({ scenario: "prs-chat" });
test.describe.configure({ mode: "serial" });

const sidebar = (page: Page) => page.locator("[data-sidebar=sidebar]");
const row = (page: Page, title: string) => page.getByRole("listitem").filter({ hasText: title });
const composer = (page: Page) => page.getByRole("textbox", { name: "Mensaje para el chat" });
const chat = (page: Page) => page.getByRole("region", { name: "Chat del PR" });

async function snapBoth(page: Page, view: string): Promise<void> {
  const hideToasts = await page.addStyleTag({ content: "[data-sonner-toaster] { visibility: hidden !important; }" });
  for (const theme of ["light", "dark"] as const) {
    await setTheme(page, theme);
    await snap(page, view, theme);
  }
  await hideToasts.evaluate((style: Element) => style.remove());
}

async function openList(page: Page): Promise<void> {
  await sidebar(page).getByRole("button", { name: /Stacks de PR/ }).click();
  await expect(page.getByRole("heading", { name: "Stacks de PR", exact: true })).toBeVisible();
  await page.getByRole("tab", { name: "Lista", exact: true }).click();
}

/** Desde la lista, `C` sobre la fila abre el PR con el composer del chat enfocado. */
async function chatAbout(page: Page, title: string): Promise<void> {
  await openList(page);
  const target = row(page, title).getByRole("button").first();
  await expect(target).toBeVisible({ timeout: 30_000 });
  await target.focus();
  await page.keyboard.press("c");
  await expect(page.getByRole("heading", { level: 1, name: title, exact: true })).toBeVisible();
  await expect(composer(page)).toBeFocused();
}

async function send(page: Page, text: string): Promise<void> {
  await composer(page).fill(text);
  // Hasta que el chat cargó (y no hay un turno en curso), ⌘Enter no manda nada.
  await expect(chat(page).getByRole("button", { name: /Enviar mensaje/ })).toBeEnabled({ timeout: 30_000 });
  await page.keyboard.press("Meta+Enter");
  await expect(composer(page)).toHaveValue("");
}

async function applyProposal(page: Page, where: RegExp): Promise<void> {
  await page.keyboard.press("Meta+Shift+Enter");
  const dialog = page.getByRole("alertdialog");
  await expect(dialog).toContainText(where);
  await snapBoth(page, `chat-aplicar-dialogo-${where.source.includes("local") ? "local" : "remoto"}`);
  await page.keyboard.press("Enter");
  await expect(chat(page).getByText(/Apliqué la propuesta/)).toBeVisible({ timeout: 90_000 });
}

test("PR local: C abre el chat, el turno se ve en vivo, la propuesta en su pestaña y aplicar commitea sin push", async ({ window: page }) => {
  await chatAbout(page, "Documentar las reglas de boundaries");
  await expect(chat(page).getByText("¿Qué quieres revisar de este PR?")).toBeVisible();
  await snapBoth(page, "chat-vacio");

  await send(page, "Agrega unas notas para revisar el PR");
  await expect(chat(page).getByRole("status", { name: "Turno en curso" })).toBeVisible({ timeout: 15_000 });
  await snapBoth(page, "chat-turno-en-vivo");
  await expect(chat(page).getByRole("heading", { name: "Propuesta 1" })).toBeVisible({ timeout: 30_000 });
  await snapBoth(page, "chat-propuesta");

  await chat(page).getByRole("button", { name: "Ver cambios" }).click();
  await expect(page.getByRole("tab", { name: "Propuesta 1", selected: true })).toBeVisible();
  await expect(page.getByTestId("proposal-files").getByRole("table")).toBeVisible();
  await snapBoth(page, "chat-pestana-propuesta");

  await applyProposal(page, /commits del PR local/);
  await snapBoth(page, "chat-aplicada-local");
});

test("PR remoto con hijos apilados: aplicar deja la punta nueva, restackea la cadena y la propuesta del hijo queda atrás hasta rehacerla", async ({ window: page }) => {
  // El hijo propone primero y después solo pregunta: su propuesta queda sobre la punta de hoy.
  await chatAbout(page, "Agregar checks de boundaries a CI");
  await send(page, "Agrega unas notas para revisar el PR");
  await expect(chat(page).getByRole("heading", { name: "Propuesta 1" })).toBeVisible({ timeout: 30_000 });
  await send(page, "¿Qué cambia tu propuesta?");
  await expect(chat(page).getByText("La propuesta solo agrega")).toBeVisible({ timeout: 30_000 });

  await chatAbout(page, "Lint de imports entre engines");
  await send(page, "Agrega unas notas para revisar el PR");
  await expect(chat(page).getByRole("heading", { name: "Propuesta 1" })).toBeVisible({ timeout: 30_000 });
  await applyProposal(page, /se squashean y se pushean con lease/);
  await expect(chat(page).getByText(/restackeado sobre la punta nueva/).first()).toBeVisible();
  await snapBoth(page, "chat-aplicada-remoto");

  await page.keyboard.press("Escape");
  await page.getByRole("tab", { name: "Grafo", exact: true }).click();
  await expect(page.getByRole("group", { name: /Agregar checks de boundaries/ })).toBeVisible();
  await expect(page.getByRole("group", { name: /Agregar checks de boundaries/ }).getByText("Propuesta")).toBeVisible();
  await snapBoth(page, "chat-grafo-restackeado");

  // El restack movió al hijo: su propuesta ya no calza y se rehace sobre la punta actual.
  await chatAbout(page, "Agregar checks de boundaries a CI");
  await expect(chat(page).getByText("Desactualizada")).toBeVisible({ timeout: 30_000 });
  await snapBoth(page, "chat-propuesta-stale");
  await chat(page).getByRole("button", { name: "Rehacer sobre el PR actual" }).click();
  await expect(chat(page).getByRole("heading", { name: "Propuesta 2" })).toBeVisible({ timeout: 30_000 });
  await expect(chat(page).getByText("Por aplicar")).toBeVisible();
  await snapBoth(page, "chat-propuesta-rehecha");
});

test("un hijo con base combinada sigue la punta nueva del padre al que se le aplica la propuesta", async ({ window: page }) => {
  await chatAbout(page, "Migrar el job de conciliación");
  await send(page, "Agrega unas notas para revisar el PR");
  await expect(chat(page).getByRole("heading", { name: "Propuesta 1" })).toBeVisible({ timeout: 30_000 });
  await page.keyboard.press("Meta+Shift+Enter");
  await expect(page.getByRole("alertdialog")).toContainText("(base combinada)");
  await page.keyboard.press("Enter");
  await expect(chat(page).getByText(/Apliqué la propuesta/)).toBeVisible({ timeout: 90_000 });
  await expect(chat(page).getByText(/restackeado sobre la punta nueva/)).toBeVisible();
  await snapBoth(page, "chat-aplicada-combinada");
});

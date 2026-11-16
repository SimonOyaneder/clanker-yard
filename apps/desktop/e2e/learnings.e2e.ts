import { createClient } from "@clanker/api";
import { readCoreJson } from "@clanker/api/node";
import type { Locator, Page } from "@playwright/test";
import { expect, setTheme, snap, test } from "./harness";

// La revisión de learnings contra el escenario `learnings` del core de demo (`packages/testkit/src/learnings-scenario.ts`):
// 33 por revisar (26 importados del clanker-loop, 5 de agentes, 2 escritos a mano) y 8 ya revisados. Lo que se aprueba lo
// manda la app al core con su llave (`origin: "ui"`); aquí se lee del core lo que quedó.
test.use({ scenario: "learnings" });
test.describe.configure({ mode: "serial" });

const sidebar = (page: Page) => page.locator("[data-sidebar=sidebar]");
const list = (page: Page) => page.getByRole("list", { name: /^Learnings:/ });
const rows = (page: Page) => list(page).getByRole("listitem");
const tab = (page: Page, name: string) => page.getByRole("tab", { name: new RegExp(`^${name}`) });
const select = async (page: Page, name: string, option: string) => {
  await page.getByRole("combobox", { name }).click();
  await page.getByRole("option", { name: option, exact: true }).click();
};

const coreClient = (home: string) => {
  const info = readCoreJson(home)!;
  return createClient({ url: `http://127.0.0.1:${info.port}/rpc`, token: info.token, origin: "cli" });
};
const statusCounts = async (home: string) => {
  const all = await coreClient(home).learnings.list();
  return Object.fromEntries((["proposed", "approved", "rejected", "archived"] as const).map((s) => [s, all.filter((l) => l.status === s).length]));
};

async function snapBoth(page: Page, view: string): Promise<void> {
  // Los toasts de la acción anterior taparían la captura.
  const hideToasts = await page.addStyleTag({ content: "[data-sonner-toaster] { visibility: hidden !important; }" });
  for (const theme of ["light", "dark"] as const) {
    await setTheme(page, theme);
    await snap(page, view, theme);
  }
  await hideToasts.evaluate((style: Element) => style.remove());
}

// Abre el menú contextual con un clic derecho en la fila.
async function openMenu(target: Locator): Promise<void> {
  await target.getByRole("button").first().click({ button: "right", position: { x: 120, y: 14 } });
}

test("la barra cuenta lo que hay por revisar y la lista trae los importados, los de agentes y los escritos a mano", async ({ window: page }) => {
  await expect(sidebar(page).getByRole("button", { name: /Learnings/ })).toBeVisible();
  await expect(sidebar(page).getByRole("button", { name: /Learnings/ })).toHaveAttribute("title", /33 por revisar/);
  await sidebar(page).getByRole("button", { name: /Learnings/ }).click();

  await expect(tab(page, "Por revisar")).toContainText("33");
  await expect(tab(page, "Aprobados")).toContainText("5");
  await expect(tab(page, "Rechazados")).toContainText("2");
  await expect(tab(page, "Retirados")).toContainText("1");
  await expect(rows(page)).toHaveCount(33);
  // El primero a la vista (el más reciente) con su detalle y su estado.
  await expect(page.getByRole("article", { name: "Learning" })).toContainText("por revisar");
  await snapBoth(page, "learnings-por-revisar");
});

test("filtrar por origen y rol, y buscar por texto", async ({ window: page }) => {
  await select(page, "Filtrar por origen", "Importado");
  await expect(rows(page)).toHaveCount(26);
  await select(page, "Filtrar por origen", "De un agente");
  await expect(rows(page)).toHaveCount(5);
  await select(page, "Filtrar por rol", "review-bugs");
  await expect(rows(page)).toHaveCount(1);
  await page.getByRole("button", { name: "Quitar filtros" }).click();
  await expect(rows(page)).toHaveCount(33);

  await select(page, "Filtrar por proyecto o repo", "SOPORTE");
  await expect(rows(page)).toHaveCount(6);
  await select(page, "Filtrar por proyecto o repo", "Demo");
  await expect(rows(page)).toHaveCount(8);
  await select(page, "Filtrar por proyecto o repo", "demo");
  await expect(rows(page)).toHaveCount(2);
  await page.getByRole("button", { name: "Quitar filtros" }).click();

  await page.keyboard.press("/");
  await page.getByLabel("Buscar learnings").fill("boundaries");
  await expect(rows(page)).toHaveCount(2);
  await page.getByLabel("Buscar learnings").fill("nada de esto existe");
  await expect(page.getByRole("heading", { name: "Ningún learning coincide con los filtros" })).toBeVisible();
  await snapBoth(page, "learnings-sin-resultados");
  await page.getByRole("button", { name: "Quitar filtros" }).first().click();
  await expect(rows(page)).toHaveCount(33);
});

test("triar en lote: marcar con X y Mayús+clic, aprobar y deshacer con Z sin que el core se entere", async ({ window: page, home }) => {
  await select(page, "Filtrar por origen", "Importado");
  await expect(rows(page)).toHaveCount(26);

  // J baja, X marca; Mayús+clic en la casilla de otra fila marca todo el rango.
  await page.keyboard.press("x");
  await page.keyboard.press("j");
  await page.keyboard.press("x");
  await rows(page).nth(5).getByRole("checkbox").click({ modifiers: ["Shift"] });
  await expect(page.getByText("6 marcados")).toBeVisible();

  // Con el menú contextual de una fila marcada, la acción es sobre las 6.
  await openMenu(rows(page).nth(2));
  await expect(page.getByRole("menuitem", { name: /Aprobar 6 marcados/ })).toBeVisible();
  await expect(page.getByRole("menuitem", { name: /Rechazar 6 marcados/ })).toBeVisible();
  await snapBoth(page, "learnings-lote-menu");
  await page.keyboard.press("Escape");

  await snapBoth(page, "learnings-lote");

  // A los aprueba: salen de "Por revisar" al instante, pero el core no los ve hasta pasar el plazo de deshacer.
  await page.keyboard.press("a");
  await expect(rows(page)).toHaveCount(20);
  await expect(tab(page, "Aprobados")).toContainText("10");
  await expect(page.getByText("Aprobaste 6 learnings")).toBeVisible();
  expect((await statusCounts(home)).approved).toBe(5);

  // Z los devuelve; pasado el plazo el core sigue sin saber nada.
  await page.keyboard.press("z");
  await expect(rows(page)).toHaveCount(26);
  await expect(tab(page, "Aprobados")).toContainText("4");
  await page.waitForTimeout(5500);
  expect(await statusCounts(home)).toEqual({ proposed: 33, approved: 5, rejected: 2, archived: 1 });
});

test("aprobar y rechazar manda al core con la llave de la app y el siguiente queda a la vista", async ({ window: page, home }) => {
  await page.getByRole("button", { name: "Quitar filtros" }).click();
  await expect(rows(page)).toHaveCount(33);
  const first = await rows(page).nth(0).innerText();
  await rows(page).nth(0).getByRole("button").click();
  await page.keyboard.press("a");
  // El que sigue pasa a ser el learning a la vista.
  await expect(page.getByRole("article", { name: "Learning" })).not.toContainText(first.split("\n")[0]!);
  await page.keyboard.press("r");
  await expect(rows(page)).toHaveCount(31);

  // Pasado el plazo, el core tiene uno aprobado y uno rechazado más (aprobar exige `origin: "ui"`: el cliente del test no podría).
  await expect.poll(() => statusCounts(home), { timeout: 15_000 }).toEqual({ proposed: 31, approved: 6, rejected: 3, archived: 1 });
  await expect(tab(page, "Aprobados")).toContainText("6");

  // El cliente con origin cli no puede aprobar: FORBIDDEN, la regla que esta vista existe para cumplir.
  const [anyProposed] = await coreClient(home).learnings.list({ status: ["proposed"] });
  await expect(coreClient(home).learnings.approve({ id: anyProposed!.id })).rejects.toThrow();
});

test("editar el texto y los roles de uno aprobado, y deshacer", async ({ window: page, home }) => {
  const original = "Mergear solo con el comando que comenta el pack: nunca con `gh pr merge`.";
  const approved = async () => (await coreClient(home).learnings.list({ status: ["approved"] })).find((l) => l.text.startsWith("Mergear solo con el comando"));
  await tab(page, "Aprobados").click();
  await expect(rows(page)).toHaveCount(6);
  await rows(page).filter({ hasText: "Mergear solo con el comando que comenta" }).getByRole("button").click();
  await page.keyboard.press("e");

  const form = page.getByRole("form", { name: "Editar learning" });
  await expect(form).toBeVisible();
  await expect(form.getByText("el cambio vale desde la próxima corrida")).toBeVisible();
  await form.getByLabel("Texto").fill("Mergear solo con el comando del pack, nunca con `gh pr merge` a mano.");
  await form.getByLabel("Roles").fill("committer");
  await form.getByLabel("Roles").press("Enter");
  await snapBoth(page, "learnings-editar");
  await page.keyboard.press("Meta+Enter");

  await expect(page.getByRole("form", { name: "Editar learning" })).toBeHidden();
  await expect.poll(async () => (await approved())?.roles).toEqual(["committer"]);
  expect((await approved())?.text).toBe("Mergear solo con el comando del pack, nunca con `gh pr merge` a mano.");
  await expect(page.getByRole("article", { name: "Learning" })).toContainText("nunca con `gh pr merge` a mano");

  await page.getByRole("button", { name: "Deshacer" }).click();
  await expect.poll(async () => (await approved())?.text).toBe(original);
  expect((await approved())?.roles).toEqual([]);
});

test("retirar un aprobado y volver a aprobar uno rechazado, desde la paleta", async ({ window: page, home }) => {
  await tab(page, "Aprobados").click();
  await rows(page).nth(0).getByRole("button").click();
  await page.getByRole("button", { name: "Buscar o ejecutar…" }).click();
  await page.getByRole("option", { name: /Retirar/ }).click();
  await expect(tab(page, "Retirados")).toContainText("2");
  await snapBoth(page, "learnings-retirados");
  await expect.poll(async () => (await statusCounts(home)).archived, { timeout: 15_000 }).toBe(2);

  await tab(page, "Rechazados").click();
  await rows(page).nth(0).getByRole("button").click();
  await page.keyboard.press("a");
  await expect(tab(page, "Rechazados")).toContainText("2");
});

test("los estados vacíos dicen qué hacer", async ({ window: page, home }) => {
  // Aprobar y rechazar todo lo que queda por revisar deja la pestaña vacía.
  await tab(page, "Por revisar").click();
  await page.keyboard.press("Meta+a");
  await page.keyboard.press("r");
  await expect(page.getByRole("heading", { name: "Nada por revisar" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Ver los aprobados" })).toBeVisible();
  await snapBoth(page, "learnings-vacio");
  await page.getByRole("button", { name: "Ver los aprobados" }).click();
  await expect(tab(page, "Aprobados")).toHaveAttribute("aria-selected", "true");
  await expect.poll(async () => (await statusCounts(home)).proposed, { timeout: 30_000 }).toBe(0);
});

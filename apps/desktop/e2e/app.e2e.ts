import { writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ElectronApplication, Page } from "@playwright/test";
import { expect, setTheme, snap, test } from "./harness";

// La fila de la corrida de "Saluda al mundo" (la de la cola no tiene el pill del flujo).
const finishedRun = (page: Page) => page.getByRole("listitem").filter({ hasText: "Saluda al mundo" }).filter({ hasText: /juguete v\d+/ });

const sidebar = (page: Page) => page.locator("[data-sidebar=sidebar]");

test.describe.configure({ mode: "serial" });

test("la app se conecta al core de demo", async ({ window: page }) => {
  await expect(page.getByText("Clanker Yard", { exact: true })).toBeVisible();
  await expect(sidebar(page).getByRole("button", { name: "Demo" })).toBeVisible();
});

test("crea un proyecto desde el diálogo", async ({ window: page }) => {
  await page.getByRole("button", { name: "Nuevo proyecto" }).click();
  const dialog = page.getByRole("dialog", { name: "Nuevo proyecto" });
  await dialog.getByLabel("Nombre").fill("Proyecto E2E");
  await expect(dialog.getByLabel("Slug")).toHaveValue("proyecto-e2e");
  // Parte en Linear, que todavía no está conectado: el proyecto de prueba usa el tracker local.
  await dialog.getByRole("combobox", { name: "Tracker" }).click();
  await page.getByRole("option", { name: "Local (para probar)" }).click();
  await dialog.getByRole("button", { name: "Crear proyecto" }).click();

  await expect(dialog).toBeHidden();
  await expect(sidebar(page).getByRole("button", { name: "Proyecto E2E" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Proyecto E2E" })).toBeVisible();
  await expect(page.getByText("Todavía no hay corridas")).toBeVisible();
});

test("corre la plantilla de juguete hasta que la corrida queda lista", async ({ window: page }) => {
  await sidebar(page).getByRole("button", { name: "Demo" }).click();
  await expect(page.getByRole("heading", { name: "Demo" })).toBeVisible();

  await page.getByRole("listitem").filter({ hasText: "Saluda al mundo" }).getByRole("button", { name: "Correr" }).click();

  // Las corridas del runtime fake duran unos 7 s.
  await expect(finishedRun(page).getByText("lista", { exact: true })).toBeVisible({ timeout: 30_000 });
});

const graph = (page: Page) => page.getByRole("group", { name: /Grafo del flujo juguete/ });
const node = (page: Page, id: string) => page.locator(`.react-flow__node[data-id="${id}"]`);

test("una corrida en curso se ve como el grafo de su flujo, con el paso actual pulsando", async ({ window: page }) => {
  await sidebar(page).getByRole("button", { name: "Demo" }).click();
  await page.getByRole("listitem").filter({ hasText: "Saluda a la luna" }).getByRole("button", { name: "Correr" }).click();
  await page.getByRole("button", { name: "Ver", exact: true }).click();

  await expect(graph(page)).toBeVisible();
  await expect(page.getByText("juguete@1")).toBeVisible();
  // El agente del juguete trabaja unos 7 s: el nodo actual late y los que faltan siguen pendientes.
  await expect(node(page, "saludar").locator('[data-current="true"]')).toBeVisible();
  await expect(node(page, "release").locator('[data-state="pending"]')).toBeVisible();
  // Los tokens del agente llegan a los 2,5 s: la captura muestra una corrida con algo que contar.
  await expect(page.getByLabel("Métricas")).toContainText("150");
  for (const theme of ["light", "dark"] as const) {
    await setTheme(page, theme);
    await snap(page, "corrida-en-curso", theme);
  }
  await page.keyboard.press("Escape");
});

test("el panel del paso muestra el transcript, el brief y el reporte del agente", async ({ window: page }) => {
  await sidebar(page).getByRole("button", { name: "Demo" }).click()
  await finishedRun(page).getByRole("button").click()
  await expect(graph(page)).toBeVisible()

  // El menú del nodo ofrece ver el transcript y copiar el sessionId.
  await node(page, "saludar").click({ button: "right" })
  await expect(page.getByRole("menuitem", { name: "Copiar sessionId" })).toBeVisible()
  await page.getByRole("menuitem", { name: "Ver transcript" }).click()

  const panel = page.getByRole("region", { name: "Panel del paso saludar" })
  await expect(panel).toBeVisible()
  await expect(panel.getByText("Leo la issue")).toBeVisible()
  // Las tool calls van plegadas: al abrir la de `Read` aparece lo que recibió y lo que devolvió.
  await panel.getByRole("button", { name: /Read/ }).click()
  await expect(panel.getByText("Criterios de aceptación:", { exact: false })).toBeVisible()
  for (const theme of ["light", "dark"] as const) {
    await setTheme(page, theme)
    await snap(page, "panel-transcript", theme)
  }

  // B, R e I cambian de pestaña con el panel abierto.
  await page.keyboard.press("b")
  await expect(panel.getByText("Brief que recibió")).toBeVisible()
  await expect(panel.getByText("juguete", { exact: true })).toBeVisible()
  await page.keyboard.press("r")
  await expect(panel.getByText("saludé")).toBeVisible()
  for (const theme of ["light", "dark"] as const) {
    await setTheme(page, theme)
    await snap(page, "panel-reporte", theme)
  }
  await page.keyboard.press("i")
  await expect(panel.getByRole("button", { name: /Intento 1/ })).toBeVisible()
  for (const theme of ["light", "dark"] as const) {
    await setTheme(page, theme)
    await snap(page, "panel-intentos", theme)
  }

  // Un paso que no es de agente no tiene transcript: su pestaña principal es el comando.
  await node(page, "release").click()
  await expect(page.getByRole("region", { name: "Panel del paso release" }).getByRole("tab", { name: "Comando" })).toBeVisible()

  // Esc cierra el panel y recién otro Esc vuelve al proyecto.
  await page.keyboard.press("Escape")
  await expect(page.getByRole("region", { name: /Panel del paso/ })).toBeHidden()
  await expect(graph(page)).toBeVisible()
  await page.keyboard.press("Escape")
  await expect(page.getByRole("heading", { name: "Demo" })).toBeVisible()
})

test("interrumpir una corrida en curso la pausa con su sesión y retomarla la termina", async ({ window: page }) => {
  await sidebar(page).getByRole("button", { name: "Demo" }).click()
  await page.getByRole("listitem").filter({ hasText: "Saluda al sol" }).getByRole("button", { name: "Correr" }).click()
  await page.getByRole("button", { name: "Ver", exact: true }).click()
  await expect(node(page, "saludar").locator('[data-current="true"]')).toBeVisible()
  await expect(page.getByRole("button", { name: "Pausar" })).toBeVisible()
  for (const theme of ["light", "dark"] as const) {
    await setTheme(page, theme)
    await snap(page, "corrida-acciones", theme)
  }

  // Interrumpir detiene al agente y pide confirmación antes.
  await page.getByRole("button", { name: "Interrumpir" }).click()
  await page.getByRole("alertdialog").getByRole("button", { name: "Interrumpir" }).click()
  await expect(page.getByText("pausada", { exact: true })).toBeVisible()
  await expect(page.getByRole("button", { name: "Retomar" })).toBeVisible()
  await expect(page.getByRole("button", { name: "Pausar" })).toBeHidden()
  await expect(page.getByText("se retoma").first()).toBeVisible()
  // El panel del agente ofrece dejarle un mensaje y reintentar.
  await node(page, "saludar").click()
  const panel = page.getByRole("region", { name: "Panel del paso saludar" })
  await expect(panel.getByRole("button", { name: "Mensaje al agente" })).toBeVisible()
  await expect(panel.getByRole("button", { name: "Reintentar" })).toBeVisible()
  for (const theme of ["light", "dark"] as const) {
    await setTheme(page, theme)
    await snap(page, "corrida-pausada", theme)
  }
  await page.keyboard.press("Escape")

  await page.getByRole("button", { name: "Retomar" }).click()
  await expect(page.getByText("terminó el flujo")).toBeVisible({ timeout: 30_000 })
  await expect(page.getByRole("button", { name: "Retomar" })).toBeHidden()
  await page.keyboard.press("Escape")
})

test("screenshots de cada vista en claro y oscuro", async ({ window: page }) => {
  for (const theme of ["light", "dark"] as const) {
    await setTheme(page, theme);

    await sidebar(page).getByRole("button", { name: "Demo" }).click();
    await expect(page.getByRole("heading", { name: "Demo" })).toBeVisible();
    await snap(page, "proyecto", theme);

    await finishedRun(page).getByRole("button").click();
    await expect(graph(page)).toBeVisible();
    await expect(page.getByText("terminó el flujo")).toBeVisible();
    await expect(node(page, "release").locator('[data-state="done"]')).toBeVisible();
    await snap(page, "corrida", theme);

    // L abre la línea de tiempo con los pasos y G vuelve al grafo.
    await page.keyboard.press("l");
    await expect(page.getByRole("heading", { name: /Línea de tiempo/ })).toBeVisible();
    await snap(page, "corrida-linea-de-tiempo", theme);
    await page.keyboard.press("g");
    await expect(graph(page)).toBeVisible();

    await sidebar(page).getByRole("button", { name: "Proyecto E2E" }).click();
    await expect(page.getByText("Todavía no hay corridas")).toBeVisible();
    await snap(page, "proyecto-vacio", theme);

    await sidebar(page).getByRole("button", { name: "Stacks de PR" }).click();
    await expect(page.getByRole("button", { name: "Stacks de PR" }).first()).toBeVisible();
    await snap(page, "prs", theme);

    await page.getByRole("button", { name: "Nuevo proyecto" }).click();
    await expect(page.getByRole("dialog", { name: "Nuevo proyecto" })).toBeVisible();
    await snap(page, "nuevo-proyecto", theme);
    await page.keyboard.press("Escape");

    await page.getByRole("button", { name: "Atajos de teclado" }).click();
    await expect(page.getByRole("dialog")).toBeVisible();
    await snap(page, "atajos", theme);
    await page.keyboard.press("Escape");
    await expect(page.getByRole("dialog")).toBeHidden();
  }
});

// El estado de las conexiones del core de demo cambia con este archivo (ver `packages/testkit/scripts/demo-core.ts`).
function setDemoControl(
  home: string,
  control: { clockDays?: number; claude?: string; closeAlert?: boolean; githubDeny?: boolean; githubRefresh?: "rejected"; githubInstalled?: boolean },
): void {
  writeFileSync(join(home, "demo-control.json"), JSON.stringify(control));
}

const card = (page: Page, name: string) => page.getByRole("group", { name, exact: true });

const snapBoth = async (page: Page, view: string) => {
  // Los toasts de la acción anterior taparían la captura.
  await page.addStyleTag({ content: "[data-sonner-toaster] { visibility: hidden !important; }" });
  for (const theme of ["light", "dark"] as const) {
    await setTheme(page, theme);
    await snap(page, view, theme);
  }
};

test("conexiones sin configurar: cada tarjeta dice qué hacer", async ({ window: page }) => {
  await sidebar(page).getByRole("button", { name: "Conexiones" }).click();
  await expect(page.getByRole("heading", { name: "Conexiones" })).toBeVisible();

  for (const name of ["GitHub", "Linear", "Claude"]) await expect(card(page, name).getByText("sin configurar")).toBeVisible();
  await expect(card(page, "Linear").getByRole("button", { name: "Conectar con Linear" })).toBeVisible();
  // El repo sin receta no se puede probar; la tabla trae los tres repos de la demo.
  await expect(page.getByRole("row", { name: /demo-rota/ }).getByText("inválida")).toBeVisible();
  await expect(page.getByRole("row", { name: /^demo / }).getByRole("button", { name: "Probar receta" })).toBeDisabled();
  await expect(sidebar(page).getByLabel("Algo está vencido o caído")).toBeHidden();
  await snapBoth(page, "conexiones-sin-configurar");
});

test("pegar un PAT contra el GitHub falso deja el chip en verde", async ({ window: page }) => {
  const github = card(page, "GitHub");
  await github.getByLabel("Personal access token (classic)").fill("token-que-no-es");
  await github.getByRole("button", { name: "Probar" }).click();
  await expect(github.getByRole("alert")).toContainText("GitHub rechazó el token");
  await expect(github.getByText("sin configurar")).toBeVisible();

  // El simulador solo acepta este token (`packages/testkit/scripts/demo-core.ts`).
  await github.getByLabel("Personal access token (classic)").fill("ghp_demo");
  await github.getByRole("button", { name: "Probar" }).click();

  await expect(github.getByText("conectada", { exact: true })).toBeVisible();
  await expect(github.getByText("@octocat")).toBeVisible();
  await expect(github.getByText("repo", { exact: true })).toBeVisible();
  // Con el token aceptado el campo desaparece: no queda el secreto en pantalla.
  await expect(github.getByLabel("Personal access token (classic)")).toBeHidden();
  // La tarjeta dice con qué credencial publican los agentes y cómo cambiarla.
  await expect(github.getByText("Token personal", { exact: true })).toBeVisible();
  await expect(github.getByRole("button", { name: "Cambiar a la GitHub App" })).toBeVisible();
});

test("conectar con Linear espera la aprobación en el navegador y la cuenta aparece sola", async ({ app, window: page }) => {
  // El main solo abre https, así que el link del Linear falso (http) no abre nada: lo recogemos del IPC y lo aprobamos nosotros.
  await app.evaluate(({ ipcMain }) => {
    ipcMain.on("host:open-external", (_event, url: string) => ((globalThis as { openedUrl?: string }).openedUrl = url));
  });
  const linear = card(page, "Linear");
  await linear.getByRole("button", { name: "Conectar con Linear" }).click();
  await expect(linear.getByText("Esperando que apruebes en el navegador")).toBeVisible();

  const openedUrl = () => app.evaluate(() => (globalThis as { openedUrl?: string }).openedUrl);
  await expect.poll(openedUrl).toBeTruthy();
  const url = (await openedUrl())!;
  // Aprobar es abrir el link: el Linear falso redirige al loopback del core, que cambia el código por los tokens.
  expect((await fetch(url)).ok).toBe(true);

  await expect(linear.getByText("conectada", { exact: true })).toBeVisible();
  await expect(linear.getByText("clanker-yard", { exact: true }).first()).toBeVisible();
});

test("probar Claude muestra el plan y su uso, y la barra vuelve al pie de la barra lateral", async ({ window: page }) => {
  const claude = card(page, "Claude");
  await claude.getByRole("button", { name: "Probar", exact: true }).click();

  await expect(claude.getByText("lista", { exact: true })).toBeVisible();
  await expect(claude.getByText("Claude Code 2.1.325 · plan max")).toBeVisible();
  await expect(claude.getByRole("meter", { name: /ventana de 5 h/ })).toHaveAttribute("aria-valuenow", "15");
  await expect(claude.getByRole("meter", { name: /ventana de 7 días/ })).toHaveAttribute("aria-valuenow", "42");
  await expect(sidebar(page).getByRole("meter", { name: /ventana de 5 h/ })).toHaveAttribute("aria-valuenow", "15");
  await expect(sidebar(page).getByLabel("Algo está vencido o caído")).toBeHidden();
  await snapBoth(page, "conexiones-ok");
});

test("probar la receta de un repo muestra su log en vivo en un Sheet", async ({ window: page }) => {
  await page.getByRole("row", { name: /demo-receta/ }).getByRole("button", { name: "Probar receta" }).click();

  const sheet = page.getByRole("dialog", { name: /Probar receta · demo-receta/ });
  await expect(sheet.getByRole("log", { name: "Salida de la receta" })).toContainText("instalando dependencias 1/3");
  await expect(sheet.getByText("La receta corrió completa.")).toBeVisible();
  await expect(sheet.getByRole("log")).toContainText("instalando dependencias 3/3");
  await snapBoth(page, "receta-sheet");
  await page.keyboard.press("Escape");

  await expect(page.getByRole("row", { name: /demo-receta/ }).getByText("ok", { exact: true })).toBeVisible();
});

test("con el token vencido y el login de Claude caído, los chips y el punto rojo lo dicen", async ({ home, window: page }) => {
  // 40 días después el PAT (vence en 35) y el refresh token de Linear (30) ya no valen; Claude pierde la sesión.
  setDemoControl(home, { clockDays: 40, claude: "login_expired" });
  await page.getByRole("button", { name: "core en vivo" }).click();
  const claude = card(page, "Claude");
  await claude.getByRole("button", { name: "Probar", exact: true }).click();

  await expect(card(page, "GitHub").getByText("vencida", { exact: true })).toBeVisible();
  await expect(card(page, "GitHub").getByLabel("Personal access token (classic)")).toBeVisible();
  await expect(card(page, "Linear").getByText("vencida", { exact: true })).toBeVisible();
  await expect(claude.getByText("sesión vencida", { exact: true })).toBeVisible();
  await expect(claude.getByRole("alert")).toContainText("claude auth login");
  await expect(sidebar(page).getByLabel("Algo está vencido o caído")).toBeVisible();
  await snapBoth(page, "conexiones-vencida");
});

// La bandeja: el core de demo deja una corrida por tipo de decisión en el proyecto "Bandeja de prueba" (un gate, un
// paso sin edge, un tope de gasto y una nota de revisión, que no entra a la bandeja) y una alerta suelta.
const inboxItem = (page: Page) => sidebar(page).getByRole("button", { name: "Bandeja", exact: true });
const inboxList = (page: Page) => page.getByRole("list", { name: "Decisiones pendientes" });
const decision = (page: Page, title: string) => page.getByRole("article", { name: title });
const GATE = "¿Publico el saludo?";
// El plazo de deshacer de la bandeja (`UNDO_MS`) más un margen.
const UNDO_WAIT = 6_500;

const runRow = (page: Page, issue: string) => page.getByRole("listitem").filter({ hasText: issue }).filter({ hasText: /juguete-\w+ v\d+/ });

test("una corrida estacionada avisa que espera y lleva a su decisión en la bandeja", async ({ window: page }) => {
  await sidebar(page).getByRole("button", { name: "Bandeja de prueba" }).click();
  const marte = runRow(page, "Saluda a Marte");
  await expect(marte.getByText("estacionada", { exact: true })).toBeVisible({ timeout: 30_000 });
  await marte.getByRole("button").click();

  await expect(page.getByRole("status").filter({ hasText: "no ocupa cupo en su carril" })).toBeVisible();
  await snapBoth(page, "corrida-estacionada");
  await page.getByRole("button", { name: "Abrir decisión" }).click();
  await expect(decision(page, GATE)).toBeVisible();
  await expect(decision(page, GATE).getByText(/^Estaciona/)).toBeVisible();
});

test("la bandeja trae solo lo accionable, con las que estacionan primero y sin las notas", async ({ window: page }) => {
  await expect(inboxList(page).getByRole("listitem")).toHaveCount(4, { timeout: 30_000 });
  await expect(inboxItem(page)).toHaveAttribute("title", /4 decisiones pendientes, alguna estaciona su corrida/);

  const order = ["¿Publico el saludo?", 'El paso "saludar" no puede seguir', "La corrida llegó a su tope"];
  const titles = (await inboxList(page).getByRole("listitem").locator("button > span:first-child > span.truncate").evaluateAll((els) => els.map((el) => el.textContent))) as string[];
  expect(titles.slice(0, 3).sort()).toEqual([...order].sort());
  expect(titles).not.toContain("El saludo quedó sin revisar");

  // Una captura por tipo, bajando por la lista con J.
  const kindOf: Record<string, string> = {
    [GATE]: "gate",
    'El paso "saludar" no puede seguir': "necesita-ayuda",
    "La corrida llegó a su tope": "tope",
    "La conexión de Linear venció": "alerta",
  };
  await inboxList(page).getByRole("listitem").first().getByRole("button").click();
  for (const [i, title] of titles.entries()) {
    if (i > 0) await page.keyboard.press("j");
    await expect(inboxList(page).getByRole("listitem").nth(i).getByRole("button")).toHaveAttribute("aria-current", "true");
    await expect(decision(page, title!)).toBeVisible();
    await snapBoth(page, `bandeja-${kindOf[title!]}`);
  }
});

test("Z deshace la respuesta y la corrida sigue estacionada", async ({ window: page }) => {
  await inboxList(page).getByRole("button", { name: new RegExp(GATE.replace("?", "\\?")) }).click();
  await expect(decision(page, GATE)).toBeVisible();

  await page.keyboard.press("1");
  await expect(inboxList(page).getByRole("listitem")).toHaveCount(3);
  await page.keyboard.press("z");
  await expect(inboxList(page).getByRole("listitem")).toHaveCount(4);
  await expect(decision(page, GATE)).toBeVisible();

  // Pasado el plazo sigue ahí: nunca se mandó al core.
  await page.waitForTimeout(UNDO_WAIT);
  await expect(inboxList(page).getByRole("listitem")).toHaveCount(4);
});

test("resolver un gate desde la bandeja reencola la corrida y esta termina", async ({ window: page }) => {
  await decision(page, GATE).getByRole("button", { name: /Publicar el saludo/ }).click();
  await expect(inboxList(page).getByRole("listitem")).toHaveCount(3);

  await sidebar(page).getByRole("button", { name: "Bandeja de prueba" }).click();
  // Vuelve a la cola de su carril, el agente saluda (unos 7 s) y el flujo llega al final.
  await expect(runRow(page, "Saluda a Marte").getByText("lista", { exact: true })).toBeVisible({ timeout: 40_000 });
});

test("las resueltas guardan lo que se eligió y sin pendientes la bandeja dice qué pasa", async ({ home, window: page }) => {
  await inboxItem(page).click();
  // Lo que queda: el paso sin edge, el tope y la alerta. Se cancelan las dos corridas.
  const pending = () => inboxList(page).getByRole("listitem");
  await expect(pending()).toHaveCount(3);
  await page.locator("body").click({ position: { x: 1000, y: 800 } });
  // Los dos primeros estacionan su corrida: su opción 3 es cancelar (la 2 es seguir con el perfil vigente).
  for (const option of ["3", "3"]) await page.keyboard.press(option);

  // La alerta no tiene botones: se cierra sola cuando la causa se va (aquí, cuando el demo la cierra).
  await expect(pending()).toHaveCount(1);
  await expect(decision(page, "La conexión de Linear venció").getByRole("group", { name: "Opciones" })).toBeHidden();
  await expect(decision(page, "La conexión de Linear venció").getByRole("button", { name: "Ir a Conexiones" })).toBeVisible();
  setDemoControl(home, { clockDays: 40, claude: "login_expired", closeAlert: true });
  await expect(page.getByText("No hay nada esperando tu decisión.")).toBeVisible();
  await snapBoth(page, "bandeja-vacia");

  await page.getByRole("button", { name: "Ver las resueltas" }).click();
  await expect(page.getByRole("list", { name: "Decisiones resueltas" }).getByRole("listitem")).toHaveCount(4, { timeout: 15_000 });
  await page.getByRole("list", { name: "Decisiones resueltas" }).getByRole("button", { name: new RegExp(GATE.replace("?", "\\?")) }).click();
  await expect(decision(page, GATE).getByRole("region", { name: "Resolución" })).toContainText("Publicar el saludo");
  await snapBoth(page, "bandeja-resueltas");
});

// La GitHub App por el device flow contra el OAuth falso del core de demo (`demo-control.json` hace de github.com: cancela,
// invalida el refresh token o desinstala la App). El main solo abre https, así que la página del GitHub falso (http) no abre
// nada: se recoge del IPC y la abrimos nosotros, que es aprobar.
const openedUrl = (app: ElectronApplication) => app.evaluate(() => (globalThis as { openedUrl?: string }).openedUrl);
const approve = async (app: ElectronApplication) => expect((await fetch((await openedUrl(app))!)).ok).toBe(true);
const forgetOpened = (app: ElectronApplication) => app.evaluate(() => ((globalThis as { openedUrl?: string }).openedUrl = undefined));
// El core de demo lee `demo-control.json` cada 200 ms (y en cada lectura del reloj): lo que hace "del lado de GitHub" no
// es instantáneo, así que lo que depende de eso se reintenta (`toPass`) hasta ver el cambio en la vista, sin un sleep fijo.

test("conectar con la GitHub App muestra el código en vivo, y al aprobarlo la cuenta aparece sola con su token", async ({ app, window: page }) => {
  await app.evaluate(({ ipcMain }) => {
    ipcMain.on("host:open-external", (_event, url: string) => ((globalThis as { openedUrl?: string }).openedUrl = url));
  });
  await forgetOpened(app);
  await sidebar(page).getByRole("button", { name: "Conexiones" }).click();
  const github = card(page, "GitHub");
  await github.getByRole("button", { name: "Conectar con la GitHub App" }).click();

  await expect(github.getByLabel("Código de GitHub")).toHaveText("WDJB-MJHT");
  await expect(github.getByText("aprueba la GitHub App")).toBeVisible();
  await expect(github.getByRole("status")).toContainText(/Esperando la aprobación en GitHub · el código vence en 1[45]:\d\d/);
  await snapBoth(page, "github-app-esperando");

  // Pulsar el botón copia el código y abre github.com otra vez (al empezar ya lo hizo una vez).
  await expect.poll(() => openedUrl(app)).toMatch(/\/login\/device$/);
  await forgetOpened(app);
  await github.getByRole("button", { name: "Copiar y abrir GitHub" }).click();
  await expect.poll(() => openedUrl(app)).toMatch(/\/login\/device$/);
  expect(await app.evaluate(({ clipboard }) => clipboard.readText())).toBe("WDJB-MJHT");
  // Aprobar es abrir la página del código: el GitHub falso lo da por escrito y el core lo ve en el siguiente sondeo.
  await approve(app);

  await expect(github.getByText("Conectado con la GitHub App")).toBeVisible();
  await expect(github.getByText("@octocat")).toBeVisible();
  await expect(github.getByText("conectada", { exact: true })).toBeVisible();
  await expect(github.getByText("GitHub App", { exact: true })).toBeVisible();
  await expect(github.getByLabel("Personal access token (classic)")).toBeHidden();
  // Instalada: no hay aviso.
  await expect(github.getByRole("alert")).toBeHidden();
  await snapBoth(page, "github-app-conectado");

  // Volver a un token personal está en el menú y abre el campo del PAT.
  await github.getByRole("button", { name: "Más acciones de GitHub" }).click();
  await page.getByRole("menuitem", { name: "Cambiar a un token personal" }).click();
  await expect(github.getByLabel("Personal access token (classic)")).toBeVisible();
});

test("si el usuario cancela en GitHub la tarjeta lo dice enseguida, sin esperar a que venza el código", async ({ home, window: page }) => {
  const github = card(page, "GitHub");
  setDemoControl(home, { githubDeny: true });
  await github.getByRole("button", { name: "Reconectar" }).first().click();

  await expect(github.getByRole("alert")).toContainText("Cancelaste la conexión en GitHub");
  await expect(github.getByLabel("Código de GitHub")).toBeHidden();
  await expect(github.getByRole("button", { name: "Intentar de nuevo" })).toBeVisible();
  // La cuenta que ya estaba conectada no se toca.
  await expect(github.getByText("conectada", { exact: true })).toBeVisible();
  await snapBoth(page, "github-app-cancelado");
});

test("si el código vence sin aprobarse la tarjeta avisa y ofrece intentar de nuevo", async ({ home, window: page }) => {
  const github = card(page, "GitHub");
  setDemoControl(home, {});
  await github.getByRole("button", { name: "Intentar de nuevo" }).click();
  await expect(github.getByLabel("Código de GitHub")).toBeVisible();
  // El reloj del core pasa de los 15 minutos del código: el siguiente sondeo lo da por vencido.
  setDemoControl(home, { clockDays: 1 });

  await expect(github.getByRole("alert")).toContainText("El código de GitHub venció");
  await expect(github.getByLabel("Código de GitHub")).toBeHidden();
  await snapBoth(page, "github-app-codigo-vencido");
});

test("sin instalar la App la cuenta conecta pero la tarjeta avisa y ofrece instalarla", async ({ home, app, window: page }) => {
  const github = card(page, "GitHub");
  setDemoControl(home, { githubInstalled: false });
  const warning = github.getByRole("alert").filter({ hasText: "La GitHub App no está instalada" });
  // Volver a la vista relee las instalaciones; hasta que el demo lea el archivo siguen ahí.
  await expect(async () => {
    await sidebar(page).getByRole("button", { name: "Bandeja", exact: true }).click();
    await sidebar(page).getByRole("button", { name: "Conexiones" }).click();
    await expect(warning).toBeVisible({ timeout: 1_000 });
  }).toPass();
  await snapBoth(page, "github-app-sin-instalar");

  await forgetOpened(app);
  await warning.getByRole("button", { name: "Instalar la GitHub App" }).click();
  await expect.poll(() => openedUrl(app)).toBe("https://github.com/apps/clanker-yard-demo/installations/new");
  // Al volver de instalarla, revisar de nuevo quita el aviso.
  setDemoControl(home, {});
  await expect(async () => {
    await warning.getByRole("button", { name: "Volver a revisar" }).click({ timeout: 1_000 });
    await expect(warning).toBeHidden({ timeout: 1_000 });
  }).toPass();
});

test("con el refresh token de la App vencido o rechazado, la tarjeta pide volver a conectar", async ({ home, window: page }) => {
  const github = card(page, "GitHub");
  // La lista de conexiones se relee con los eventos del core: probar Claude emite uno (y el reloj nuevo ya cuenta).
  const reload = () => card(page, "Claude").getByRole("button", { name: "Probar", exact: true }).click();

  // 250 días después, pasados los 6 meses del refresh token (se conectó con el reloj en el día 40), la cuenta está vencida.
  setDemoControl(home, { clockDays: 250 });
  await reload();
  await expect(github.getByText("vencida", { exact: true })).toBeVisible();
  await expect(github.getByText("El refresh token de la GitHub App venció")).toBeVisible();
  await expect(github.getByRole("button", { name: "Reconectar" }).first()).toBeVisible();
  await snapBoth(page, "github-app-vencido");

  // En el día 41 el access token (8 h) ya no sirve y GitHub rechaza el refresh: al revisar la instalación el core la deja revocada.
  // El demo aplica el reloj y el refresh rechazado en la misma lectura: revisar la instalación ya ve los dos.
  setDemoControl(home, { clockDays: 41, githubRefresh: "rejected" });
  await reload();
  await expect(github.getByText("revocada", { exact: true })).toBeVisible();
  await expect(github.getByText("GitHub rechazó la renovación del token")).toBeVisible();
  await expect(sidebar(page).getByLabel("Algo está vencido o caído")).toBeVisible();
  await snapBoth(page, "github-app-revocado");
});

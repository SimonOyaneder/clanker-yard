import { connectToCore } from "@clanker/api/node";
import { expect, setTheme, snap, test } from "./harness";

test.use({ scenario: "prs" });

test("una solicitud de publicación desde CLI llega a la Bandeja y se puede declinar sin publicar", async ({
  home, window: page,
}) => {
  const core = await connectToCore(home, "cli");
  if (!core) throw new Error("El core de demo no responde");
  const { client } = core;
  const repo = "octocat/demo";
  const branch = "engine-rules-docs";
  const base = "engine-rules";
  const pr = (await client.prs.list({ repo, state: "local" })).find((pr) => pr.local?.branch === branch);
  if (!pr?.local) throw new Error(`Falta el PR local ${branch} en el escenario prs`);
  const title = `¿Publicar ${pr.local.title} en GitHub?`;

  // La app ya está en la Bandeja cuando otro cliente abre la decisión: debe aparecer sin recargar.
  await page.locator("[data-sidebar=sidebar]").getByRole("button", { name: "Bandeja", exact: true }).click();
  const { decisionId } = await client.prs.requestLocalPublish({ id: pr.id });
  const pending = page.getByRole("list", { name: "Decisiones pendientes" });
  const row = pending.getByRole("button").filter({ hasText: title });
  await row.click();

  const decision = page.getByRole("article", { name: title, exact: true });
  await expect(decision).toContainText(`Destino: ${repo} · cuenta: octocat`);
  await expect(decision).toContainText(`Rama: ${branch} → ${base}`);
  const options = decision.getByRole("group", { name: "Opciones" });
  const publish = options.getByRole("button", { name: /Publicar borrador en GitHub/ });
  const decline = options.getByRole("button", { name: /No publicar/ });
  await expect(options.getByRole("button")).toHaveCount(2);
  await expect(publish).toBeVisible();
  await expect(decline).toBeVisible();
  await page.keyboard.press("r");
  await expect(options).toBeVisible();
  await expect(decision.getByRole("textbox")).toHaveCount(0);

  for (const theme of ["light", "dark"] as const) {
    await setTheme(page, theme);
    await snap(page, "bandeja-publicar-pr-local", theme);
  }

  await decline.click();
  await expect(row).toHaveCount(0);
  // La Bandeja oculta la pregunta de inmediato, pero espera el plazo de Deshacer antes de enviar la respuesta.
  await expect.poll(() => client.decisions.get({ id: decisionId }), { timeout: 15_000 }).toMatchObject({
    status: "answered", resolvedBy: "ui", resolution: { option: "No publicar" }, runId: null,
  });
  await page.getByRole("tab", { name: "Resueltas" }).click();
  await page.getByRole("list", { name: "Decisiones resueltas" }).getByRole("button").filter({ hasText: title }).click();
  await expect(decision.getByRole("region", { name: "Resolución" })).toContainText("No publicar");
  expect(await client.prs.list({ ids: [pr.id] })).toMatchObject([{ id: pr.id, ref: null, local: { branch, base } }]);
});

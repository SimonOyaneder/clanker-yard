import { expect, test } from "vitest";
import { editorTarget, isTarget, isTheme, safeExternalUrl } from "./host-guards";

test("solo se abren URLs https en el navegador", () => {
  expect(safeExternalUrl("https://github.com/octocat/demo/pull/1")).toBe("https://github.com/octocat/demo/pull/1");
  for (const raw of ["http://github.com", "javascript:alert(1)", "file:///etc/passwd", "no es una url", 42, null]) {
    expect(safeExternalUrl(raw)).toBeUndefined();
  }
});

test("en el editor solo se abre una ruta absoluta", () => {
  expect(editorTarget("/Users/ana/repo")).toBe("/Users/ana/repo");
  for (const raw of ["repo", "../etc", "", undefined, {}]) expect(editorTarget(raw)).toBeUndefined();
});

test("un destino de navegación es una decisión o un proyecto con issue opcional", () => {
  expect(isTarget({ decisionId: "dec_1" })).toBe(true);
  expect(isTarget({ slug: "demo" })).toBe(true);
  expect(isTarget({ slug: "demo", issueId: "iss_1" })).toBe(true);
  for (const raw of [null, "demo", { decisionId: 1 }, { slug: 1 }, { slug: "demo", issueId: 2 }, {}]) expect(isTarget(raw)).toBe(false);
});

test("el tema es uno de los tres", () => {
  expect(["system", "light", "dark"].every(isTheme)).toBe(true);
  expect(isTheme("sepia")).toBe(false);
});

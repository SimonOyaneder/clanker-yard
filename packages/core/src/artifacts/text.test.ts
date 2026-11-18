import { expect, test } from "vitest";
import { hashOf } from "./artifacts";
import { artifactTextPage } from "./text";

const artifact = (content: Uint8Array, mime = "text/plain; charset=utf-8") =>
  ({ hash: hashOf(content), kind: "report" as const, mime, size: content.length, content });

test("pagina bytes UTF-8 sin partir un carácter de cuatro bytes", () => {
  const report = artifact(Buffer.from("ab🙂ñz"));
  expect(artifactTextPage(report, 0, 4)).toMatchObject({ text: "ab", nextOffset: 2 });
  expect(artifactTextPage(report, 2, 4)).toMatchObject({ text: "🙂", nextOffset: 6 });
  expect(artifactTextPage(report, 6, 4)).toMatchObject({ text: "ñz", nextOffset: null });
  expect(artifactTextPage(report, report.size, 4)).toMatchObject({ text: "", nextOffset: null });
});

test("rechaza offsets inválidos, MIME binario y bytes que no son UTF-8", () => {
  const report = artifact(Buffer.from("á"), "application/json");
  expect(() => artifactTextPage(report, 1, 4)).toThrow("nextOffset");
  expect(() => artifactTextPage(report, 3, 4)).toThrow("nextOffset");
  expect(() => artifactTextPage({ ...report, mime: "application/octet-stream" }, 0, 4)).toThrow("no es de texto");
  expect(() => artifactTextPage(artifact(Uint8Array.of(0xff)), 0, 4)).toThrow("UTF-8");
});

import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { manualReviews } from "./incoming-context";

test("solo incluye el último reporte del PR y los de la misma issue y repo", async () => {
  const dir = await mkdtemp(join(tmpdir(), "incoming-reports-"));
  try {
    const report = (n: number, owner: string, title: string) => `# review council · ${owner}/app#${n} · ${title}`;
    const files = { "app-1-eco-20260101-1100.md": report(1, "example", "original"),
      "app-1-medio-20260101-1300.md": report(1, "example", "vigente"),
      "app-2-alto-20260101-1400.md": report(2, "example", "T-123"),
      "app-3-eco-20260101-1500.md": report(3, "otro", "T-123"),
      "app-4-eco-20260101-1500.md": report(4, "example", "T-1234") };
    for (const [name, text] of Object.entries(files)) await writeFile(join(dir, name), text);
    expect(await manualReviews("example/app", 1, "T-123", dir)).toEqual([report(2, "example", "T-123"), report(1, "example", "vigente")]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

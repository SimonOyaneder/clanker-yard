import { readFileSync } from "node:fs";
import { type Client, parseLegacyMetrics, type RoleMetrics } from "@clanker/api";
import { describe, expect, test } from "vitest";
import { compareByRole, metricsCompare } from "./metrics-compare";

const sample = readFileSync(new URL("./fixtures/metrics.sample.jsonl", import.meta.url), "utf8");

// Lo que Clanker Yard lleva: dev en 2 corridas ($6 y 4M tokens en total) y un rol que el loop actual no tiene.
const current: RoleMetrics[] = [
  { role: "dev", runs: 2, tokens: 4_000_000, costMicros: 6_000_000 },
  { role: "pr-feedback", runs: 1, tokens: 100_000, costMicros: 250_000 },
];

function fakeClient(byRole: RoleMetrics[] = current) {
  const calls: unknown[] = [];
  const client = {
    metrics: { byRole: (input: unknown) => (calls.push(input), Promise.resolve(byRole)) },
    projects: { list: () => Promise.resolve([{ id: "prj_01J0000000000000000000000A", slug: "demo" }]) },
  } as unknown as Pick<Client, "metrics" | "projects">;
  return { client, calls };
}
const readSample = () => sample;

describe("compareByRole", () => {
  test("promedia por corrida en que actuó cada rol, sin contar las corridas de council", () => {
    const rows = compareByRole(parseLegacyMetrics(sample), current);

    expect(rows.map((r) => r.role)).toEqual(["dev", "pr-feedback", "review-bugs", "techlead"]);
    // dev: 3 corridas reales en el loop actual ($2.5, $1.5 y $1; 4.8M tokens) contra $3 en promedio en Yard.
    expect(rows[0]).toEqual({
      role: "dev",
      legacy: { runs: 3, usd: 5 / 3, tokens: 4_800_000 / 3 },
      current: { runs: 2, usd: 3, tokens: 2_000_000 },
      usdChangePercent: ((3 - 5 / 3) / (5 / 3)) * 100,
    });
    expect(rows[1]).toMatchObject({ legacy: null, current: { runs: 1, usd: 0.25 }, usdChangePercent: null });
    expect(rows[2]).toMatchObject({ legacy: { runs: 2, usd: 0.5 }, current: null, usdChangePercent: null });
  });
});

describe("clanker metrics compare", () => {
  test("imprime una tabla por rol", async () => {
    const { client } = fakeClient();

    const out = await metricsCompare(["--legacy", "metrics.jsonl"], { client, readFile: readSample });

    expect(out).toBe(
      [
        "Rol          Loop n  Loop USD  Loop tokens  Yard n  Yard USD  Yard tokens  Δ USD",
        "dev               3     $1.67         1.6M       2     $3.00         2.0M   +80%",
        "pr-feedback       -         -            -       1     $0.25         100k      -",
        "review-bugs       2     $0.50         750k       -         -            -      -",
        "techlead          1     $1.00         1.5M       -         -            -      -",
      ].join("\n"),
    );
  });

  test("--legacy-project se queda con un proyecto del loop actual y --project pide las métricas de uno de Yard", async () => {
    const { client, calls } = fakeClient();

    const out = await metricsCompare(["--legacy", "m.jsonl", "--legacy-project", "otro-loop", "--project", "demo", "--json"], {
      client,
      readFile: readSample,
    });

    expect(calls).toEqual([{ projectId: "prj_01J0000000000000000000000A", imported: false }]);
    expect(JSON.parse(out)).toEqual([
      { role: "dev", legacy: { runs: 1, usd: 1, tokens: 800_000 }, current: { runs: 2, usd: 3, tokens: 2_000_000 }, usdChangePercent: 200 },
      { role: "pr-feedback", legacy: null, current: { runs: 1, usd: 0.25, tokens: 100_000 }, usdChangePercent: null },
    ]);
  });

  test("falla con un mensaje claro sin --legacy, con un proyecto desconocido o con una línea inválida", async () => {
    const { client } = fakeClient();
    const deps = { client, readFile: readSample };

    await expect(metricsCompare([], deps)).rejects.toThrow(/Falta --legacy/);
    await expect(metricsCompare(["--legacy", "m", "--project", "nope"], deps)).rejects.toThrow(/No existe el proyecto "nope"/);
    await expect(metricsCompare(["--legacy", "m"], { client, readFile: () => `${sample}{"issue": 1}\n` })).rejects.toThrow(/línea 5/);
    await expect(metricsCompare(["--legacy", "m"], { client, readFile: () => "no es json" })).rejects.toThrow(/línea 1: no es JSON/);
  });
});

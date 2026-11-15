import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, test } from "vitest";
import { compareWithControl, importInMemory, type Check } from "./summary-parity";

// Ver `./summary-parity` para qué se compara y qué difiere a propósito.

const FIXTURE = fileURLToPath(new URL("../../fixtures/legacy", import.meta.url));

const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
});

function compare(from: string): Check[] {
  const { store, dispose } = importInMemory(from);
  cleanups.push(dispose);
  return compareWithControl(store, from);
}

const value = (checks: Check[], project: string, field: string) => {
  const check = checks.find((c) => c.project === project && c.field === field);
  if (!check) throw new Error(`No hay la cifra "${field}" de ${project}`);
  return check;
};

describe("paridad del import con el LoopSummary de Control (fixture del loop)", () => {
  test("cada cifra de Yard es la de Control, salvo las corridas council", () => {
    const checks = compare(FIXTURE);
    expect(checks.filter((c) => !c.ok)).toEqual([]);

    // El fixture solo trae una corrida council (DEMO-7, $0.50, 6 min, solo el rol review-bugs).
    const explained = checks.filter((c) => c.note);
    expect([...new Set(explained.map((c) => c.project))]).toEqual(["demo-sin-linear"]);
    expect(explained.map((c) => c.field)).toEqual([
      "issues (corridas)",
      "USD",
      "USD promedio",
      "minutos",
      "minutos promedio",
      "rondas review (promedio)",
      "rondas bot (promedio)",
      "última corrida",
      "resultado done",
      "rol review-bugs USD",
      "rol review-bugs tokens",
      "modelo sonnet USD",
    ]);
  });

  test("las cifras de Control del fixture son las que se esperan", () => {
    const checks = compare(FIXTURE);
    expect(value(checks, "demo-lote-0a1b2c3d4e5f", "issues (corridas)")).toMatchObject({ control: "5", yard: "5" });
    expect(value(checks, "demo-lote-0a1b2c3d4e5f", "USD")).toMatchObject({ control: "22.150000", yard: "22.150000" });
    expect(value(checks, "demo-lote-0a1b2c3d4e5f", "rol dev USD")).toMatchObject({ control: "10.150000", yard: "10.150000" });
    expect(value(checks, "demo-sin-linear", "USD")).toMatchObject({ control: "4.250000", yard: "4.750000" });
    expect(value(checks, "demo-sin-linear", "issues (corridas)")).toMatchObject({ control: "3", yard: "4" });
  });
});

describe("filas que Control y Yard cuentan distinto", () => {
  /** Una carpeta con un proyecto vacío y estas líneas de `metrics.jsonl`. */
  function loopWith(lines: object[]): string {
    const dir = mkdtempSync(join(tmpdir(), "legacy-rows-"));
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
    mkdirSync(join(dir, "projects", "raro"), { recursive: true });
    writeFileSync(join(dir, "projects", "raro", "state.md"), "# Raro · clanker-loop\nparallel: 1\n## Historial\n");
    writeFileSync(join(dir, "metrics.jsonl"), `${lines.map((l) => JSON.stringify({ project: "raro", mode: "real", result: "listo", ...l })).join("\n")}\n`);
    return dir;
  }

  const row = (issue: string, extra: object = {}) => ({ issue, ts: `2026-11-01T1${issue.at(-1)}:00:00Z`, usd: 1, minutes: 10, por_rol: { dev: { modelo: "opus", tokens: 100, usd: 1 } }, ...extra });

  test("una línea repetida es una sola corrida en Yard", () => {
    const checks = compare(loopWith([row("RAR-1"), row("RAR-1"), row("RAR-2")]));
    expect(value(checks, "raro", "issues (corridas)")).toMatchObject({ control: "3", yard: "2", ok: false });
    expect(value(checks, "raro", "USD")).toMatchObject({ control: "3.000000", yard: "2.000000", ok: false });
  });

  test("sin usd, Yard cobra la suma de por_rol y Control cero; sin minutes, Yard promedia con 0 y Control no cuenta la corrida", () => {
    const checks = compare(loopWith([row("RAR-1"), row("RAR-2", { usd: undefined, minutes: undefined, por_rol: { dev: { modelo: "opus", tokens: 100, usd: 2 } } })]));
    expect(value(checks, "raro", "USD")).toMatchObject({ control: "1.000000", yard: "3.000000", ok: false });
    expect(value(checks, "raro", "minutos promedio")).toMatchObject({ control: "10.000000", yard: "5.000000", ok: false });
  });

  test("un modelo combinado queda con su nombre en Yard y entero en el primero en Control", () => {
    const checks = compare(loopWith([row("RAR-1", { por_rol: { dev: { modelo: "opus+sonnet", tokens: 100, usd: 1 } } })]));
    expect(value(checks, "raro", "modelo opus USD")).toMatchObject({ control: "1.000000", yard: "0.000000", ok: false });
    expect(value(checks, "raro", "modelo opus+sonnet USD")).toMatchObject({ control: "0.000000", yard: "1.000000", ok: false });
  });
});

import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FlowBody, Profile } from "@clanker/api";
import { eq, sql } from "drizzle-orm";
import { createArtifacts } from "../../src/artifacts/artifacts";
import { createDefs } from "../../src/defs/defs";
import { createLegacyImporter } from "../../src/import/legacy";
import { createMetrics } from "../../src/metrics/metrics";
import { projects } from "../../src/store/schema";
import { openStore, type Store } from "../../src/store/store";
import { getLoopSummary, readMetrics, type LoopSummary, type MetricRow } from "./loop-summary";

// Paridad del import con el LoopSummary de Clanker Control (`docs/design.html#d-data`, "Test de paridad del import"):
// `metrics.jsonl` pasa por el cálculo copiado de Control (`./loop-summary`) y por `clanker import legacy` +
// `projects.summary` / `metrics.*`, y se comparan cifra a cifra, proyecto por proyecto.
//
// Lo que Yard hace distinto a propósito (la primera sale con su `note` en el reporte; las demás no están en los datos reales y las fija `summary-parity.test.ts`):
// - Cuenta las corridas `mode: council`: son plata gastada y trabajo hecho, y Yard no tiene un campo `mode` que las separe.
//   Control las deja fuera de su resumen. La comparación lo explica: contra Control sobre todas las filas, sin su filtro de `mode`.
// - Una línea idéntica repetida (misma issue y `ts`) es una sola corrida, y una sin `ts` válido falla el import (es la clave de origen).
// - Un `modelo` combinado (`opus+sonnet`, un rol que rotó de modelo) queda con ese nombre en `byModel`; Control lo cuenta entero en el primero.
// - Sin `usd`, Yard cobra la suma de `por_rol` y Control cero; sin `minutes`, Yard cuenta 0 minutos en el promedio y Control no cuenta la corrida.
// Lo que no se compara: lo que Control saca del estado vivo y de los transcripts (EM, issues en vuelo, `prs`, `decisions`; ver `./loop-summary`).

export interface Check {
  project: string;
  field: string;
  /** El valor de Control tal cual lo muestra (solo `mode: real`). */
  control: string;
  yard: string;
  /** Por qué Yard difiere de Control a propósito, si es el caso. */
  note?: string;
  /** `yard` es lo que Yard debe dar. Una diferencia con `note` no falla; una sin `note` sí. */
  ok: boolean;
}

/** El outcome del core de un `result` del loop: la copia independiente de la del importador, para que el test detecte un cambio en una sola. */
const OUTCOMES: Record<string, string> = {
  listo: "done",
  "council-listo": "done",
  "sin-lgtm": "done",
  pendientes: "blocked",
  "necesita-humano": "blocked",
  bloqueada: "blocked",
  falló: "failed",
  fallo: "failed",
};

const COUNCIL_NOTE = "Yard cuenta las corridas council; Control solo las de mode real.";

/** Importa `from` a una base en memoria (nunca a un `CLANKER_HOME` real) y devuelve el store; `dispose` lo cierra y borra lo temporal. */
export function importInMemory(from: string): { store: Store; dispose: () => void } {
  const store = openStore({ path: ":memory:" });
  const dir = mkdtempSync(join(tmpdir(), "legacy-parity-"));
  const defs = createDefs({ store });
  defs.register("flow", FlowBody);
  defs.register("profile", Profile);
  createLegacyImporter({ store, defs, artifacts: createArtifacts({ store, dir: join(dir, "artifacts") }) }).run({ from, dryRun: false });
  return {
    store,
    dispose() {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

const money = (usd: number) => usd.toFixed(6);
const micros = (n: number) => money(n / 1e6);
const fixed = (n: number | null) => (n === null ? "-" : n.toFixed(6));
/** `Date.parse` de un ts de Control: Yard guarda el cierre en ms. */
const at = (ts: string | null) => (ts === null ? "-" : String(Date.parse(ts)));

/** Los proyectos de `from` (carpetas con `state.md`, como `listLoopSlugs` de Control) comparados con `projects.summary` de `store`. */
export function compareWithControl(store: Store, from: string): Check[] {
  const rows: MetricRow[] = readMetrics(readFileSync(join(from, "metrics.jsonl"), "utf8"));
  // Lo que Yard muestra por diseño: las mismas filas con el filtro de `mode` de Control levantado.
  const withCouncil = rows.map((row) => ({ ...row, mode: "real" }));
  const metrics = createMetrics({ store });
  const projectsDir = join(from, "projects");
  const slugs = readdirSync(projectsDir, { withFileTypes: true })
    .filter((d) => d.isDirectory() && existsSync(join(projectsDir, d.name, "state.md")))
    .map((d) => d.name)
    .sort();

  const checks: Check[] = [];
  for (const project of slugs) {
    const control = getLoopSummary(project, rows);
    const expected = getLoopSummary(project, withCouncil);
    const row = store.db.select({ id: projects.id }).from(projects).where(eq(projects.slug, project)).get();
    if (!row) {
      checks.push({ project, field: "proyecto", control: "existe", yard: "no está", ok: false });
      continue;
    }
    const summary = metrics.summary(row.id, { imported: true });
    const bot = store.db
      .get<{ valid: number | null; falsePositive: number | null }>(
        sql`SELECT sum(json_extract(m.outcomes, '$.bot.valid')) AS valid, sum(json_extract(m.outcomes, '$.bot.false_positive')) AS falsePositive
            FROM run_metrics m JOIN runs ON runs.id = m.run_id WHERE runs.project_id = ${row.id} AND runs.source_key IS NOT NULL`,
      );
    const rounds = new Map(summary.rounds.map((r) => [r.counter, r]));

    const check = (field: string, controlValue: string, expectedValue: string, yard: string) =>
      checks.push({ project, field, control: controlValue, yard, ...(controlValue !== expectedValue ? { note: COUNCIL_NOTE } : {}), ok: yard === expectedValue });

    check("issues (corridas)", String(control.issuesRecorded), String(expected.issuesRecorded), String(summary.runs));
    check("USD", money(control.teamsUsd), money(expected.teamsUsd), micros(summary.costMicros));
    check("USD promedio", fixed(control.avgUsd), fixed(expected.avgUsd), fixed(summary.avgCostMicros === null ? null : summary.avgCostMicros / 1e6));
    check("minutos", fixed(control.agentMinutes), fixed(expected.agentMinutes), fixed(summary.minutes));
    check("minutos promedio", fixed(control.avgMinutes), fixed(expected.avgMinutes), fixed(summary.avgMinutes));
    check("rondas review (promedio)", fixed(control.rounds.review), fixed(expected.rounds.review), fixed(summary.runs === 0 ? null : (rounds.get("review")?.total ?? 0) / summary.runs));
    check("rondas bot (promedio)", fixed(control.rounds.bot), fixed(expected.rounds.bot), fixed(summary.runs === 0 ? null : (rounds.get("bot")?.total ?? 0) / summary.runs));
    check("fallas de CI", String(control.rounds.ciFails), String(expected.rounds.ciFails), String(rounds.get("ci")?.total ?? 0));
    check("hallazgos del bot válidos", String(control.rounds.botValid), String(expected.rounds.botValid), String(bot?.valid ?? 0));
    check("hallazgos del bot falsos positivos", String(control.rounds.botFp), String(expected.rounds.botFp), String(bot?.falsePositive ?? 0));
    check("primera corrida", at(control.firstTs), at(expected.firstTs), String(summary.firstAt ?? "-"));
    check("última corrida", at(control.lastTs), at(expected.lastTs), String(summary.lastAt ?? "-"));

    const outcomes = (s: LoopSummary) => {
      const byOutcome = new Map<string, number>();
      for (const { result, count } of s.results) {
        const outcome = OUTCOMES[result] ?? `?${result}`;
        byOutcome.set(outcome, (byOutcome.get(outcome) ?? 0) + count);
      }
      return byOutcome;
    };
    const yardOutcomes = new Map(summary.results.map((r) => [r.result, r.count]));
    for (const outcome of [...new Set([...outcomes(control).keys(), ...outcomes(expected).keys(), ...yardOutcomes.keys()])].sort()) {
      check(`resultado ${outcome}`, String(outcomes(control).get(outcome) ?? 0), String(outcomes(expected).get(outcome) ?? 0), String(yardOutcomes.get(outcome as "done") ?? 0));
    }

    const yardRoles = new Map(summary.byRole.map((r) => [r.role, r]));
    for (const role of [...new Set([...control.byRole.map((r) => r.role), ...expected.byRole.map((r) => r.role), ...yardRoles.keys()])].sort()) {
      const c = control.byRole.find((r) => r.role === role);
      const e = expected.byRole.find((r) => r.role === role);
      check(`rol ${role} USD`, money(c?.usd ?? 0), money(e?.usd ?? 0), micros(yardRoles.get(role)?.costMicros ?? 0));
      check(`rol ${role} tokens`, String(c?.tokens ?? 0), String(e?.tokens ?? 0), String(yardRoles.get(role)?.tokens ?? 0));
    }

    const yardModels = new Map(metrics.byModel({ projectId: row.id, imported: true }).map((m) => [m.model, m.costMicros]));
    for (const model of [...new Set([...control.byModel.map((m) => m.model), ...expected.byModel.map((m) => m.model), ...yardModels.keys()])].sort()) {
      check(`modelo ${model} USD`, money(control.byModel.find((m) => m.model === model)?.usd ?? 0), money(expected.byModel.find((m) => m.model === model)?.usd ?? 0), micros(yardModels.get(model) ?? 0));
    }
  }
  return checks;
}

/** Una línea por cifra: lo de Control, lo de Yard y la nota si difiere a propósito; `✗` donde no cuadra. */
export function formatChecks(checks: readonly Check[]): string {
  const width = (pick: (c: Check) => string) => Math.max(...checks.map((c) => pick(c).length));
  const [pw, fw, cw] = [width((c) => c.project), width((c) => c.field), width((c) => c.control)];
  return checks
    .map((c) => `${c.ok ? (c.note ? "~" : "=") : "✗"} ${c.project.padEnd(pw)}  ${c.field.padEnd(fw)}  Control ${c.control.padStart(cw)}  Yard ${c.yard}${c.note ? `  (${c.note})` : ""}`)
    .join("\n");
}

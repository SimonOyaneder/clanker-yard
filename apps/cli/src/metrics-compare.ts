import { parseArgs } from "node:util";
import { type Client, type LegacyMetricsRow, parseLegacyMetrics, type RoleMetrics } from "@clanker/api";

/** Corridas en que actuó el rol y lo que gastó en promedio en cada una. */
interface RoleAverage {
  runs: number;
  usd: number;
  tokens: number;
}

export interface RoleComparison {
  role: string;
  /** `null` si el loop actual no usó el rol. */
  legacy: RoleAverage | null;
  /** `null` si Clanker Yard no usó el rol. */
  current: RoleAverage | null;
  /** Cuánto más (o menos) cuesta una corrida del rol en Clanker Yard; `null` si falta un lado o el loop actual no cobró. */
  usdChangePercent: number | null;
}

/** Promedio por rol del loop actual (solo `mode: real`) frente al de Clanker Yard, por rol y en orden alfabético. */
export function compareByRole(legacy: readonly LegacyMetricsRow[], current: readonly RoleMetrics[]): RoleComparison[] {
  const legacyTotals = new Map<string, RoleAverage>();
  for (const row of legacy) {
    if (row.mode !== "real") continue;
    for (const [role, cost] of Object.entries(row.por_rol ?? {})) {
      const acc = legacyTotals.get(role) ?? { runs: 0, usd: 0, tokens: 0 };
      legacyTotals.set(role, { runs: acc.runs + 1, usd: acc.usd + (cost.usd ?? 0), tokens: acc.tokens + (cost.tokens ?? 0) });
    }
  }
  const currentByRole = new Map(current.map((r) => [r.role, r]));

  return [...new Set([...legacyTotals.keys(), ...currentByRole.keys()])].sort().map((role) => {
    const l = legacyTotals.get(role);
    const c = currentByRole.get(role);
    const legacyAvg = l && { runs: l.runs, usd: l.usd / l.runs, tokens: l.tokens / l.runs };
    const currentAvg = c && { runs: c.runs, usd: c.costMicros / 1e6 / c.runs, tokens: c.tokens / c.runs };
    return {
      role,
      legacy: legacyAvg ?? null,
      current: currentAvg ?? null,
      usdChangePercent: legacyAvg && currentAvg && legacyAvg.usd > 0 ? ((currentAvg.usd - legacyAvg.usd) / legacyAvg.usd) * 100 : null,
    };
  });
}

const usd = (n: number) => `$${n.toFixed(2)}`;
const tokens = (n: number) => (n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${Math.round(n / 1e3)}k` : String(Math.round(n)));
const percent = (n: number) => `${n > 0 ? "+" : ""}${n.toFixed(0)}%`;

/** La tabla por rol, con columnas alineadas; un guion donde un lado no usó el rol. */
export function formatComparison(rows: readonly RoleComparison[]): string {
  const side = (a: RoleAverage | null) => (a ? [String(a.runs), usd(a.usd), tokens(a.tokens)] : ["-", "-", "-"]);
  const table = [
    ["Rol", "Loop n", "Loop USD", "Loop tokens", "Yard n", "Yard USD", "Yard tokens", "Δ USD"],
    ...rows.map((r) => [r.role, ...side(r.legacy), ...side(r.current), r.usdChangePercent === null ? "-" : percent(r.usdChangePercent)]),
  ];
  const widths = table[0]!.map((_, i) => Math.max(...table.map((row) => row[i]!.length)));
  return table
    .map((row) => row.map((cell, i) => (i === 0 ? cell.padEnd(widths[i]!) : cell.padStart(widths[i]!))).join("  "))
    .join("\n");
}

export interface MetricsCompareDeps {
  client: Pick<Client, "metrics" | "projects">;
  readFile(path: string): string;
}

export const METRICS_COMPARE_USAGE = "Uso: clanker metrics compare --legacy <metrics.jsonl> [--project <slug>] [--legacy-project <slug>] [--json]";

/**
 * `clanker metrics compare`: lee el `metrics.jsonl` del loop actual y lo compara, rol por rol, con lo
 * que Clanker Yard lleva (todos los proyectos, o `--project`). `--legacy-project` se queda con las
 * líneas de un proyecto del loop actual. Devuelve lo que se imprime.
 */
export async function metricsCompare(args: string[], { client, readFile }: MetricsCompareDeps): Promise<string> {
  const { values } = parseArgs({
    args,
    options: {
      legacy: { type: "string" },
      project: { type: "string" },
      "legacy-project": { type: "string" },
      json: { type: "boolean" },
    },
  });
  if (!values.legacy) throw new Error(`Falta --legacy. ${METRICS_COMPARE_USAGE}`);

  const legacyProject = values["legacy-project"];
  const legacy = parseLegacyMetrics(readFile(values.legacy)).filter((r) => legacyProject === undefined || r.project === legacyProject);

  let projectId;
  if (values.project !== undefined) {
    const project = (await client.projects.list()).find((p) => p.slug === values.project);
    if (!project) throw new Error(`No existe el proyecto "${values.project}" en Clanker Yard.`);
    projectId = project.id;
  }
  const rows = compareByRole(legacy, await client.metrics.byRole({ projectId }));
  return values.json ? JSON.stringify(rows, null, 2) : formatComparison(rows);
}

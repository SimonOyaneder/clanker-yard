import * as z from "zod";

const num = z.number().nonnegative();

/** Una línea de `metrics.jsonl` del clanker-loop (`docs/design.html#d-data`, "Migración desde el clanker-loop"). */
export const LegacyMetricsRow = z.looseObject({
  issue: z.string(),
  project: z.string().optional(),
  /** `real` por defecto; las corridas de council vienen como `council` y no cuentan. */
  mode: z.string().default("real"),
  /** `listo`, `falló`, `necesita-humano`... */
  result: z.string(),
  pr: z.string().optional(),
  /** ISO 8601. */
  ts: z.string().optional(),
  minutes: num.nullish(),
  usd: num.nullish(),
  "review-rounds": num.optional(),
  "bot-rounds": num.optional(),
  "bot-valid": num.optional(),
  "bot-fp": num.optional(),
  "ci-fails": num.optional(),
  por_rol: z
    .record(
      z.string(),
      z.looseObject({ modelo: z.string().optional(), effort: z.string().optional(), tokens: num.optional(), usd: num.optional() }),
    )
    .nullish(),
});
export type LegacyMetricsRow = z.infer<typeof LegacyMetricsRow>;

/** Lee un `metrics.jsonl` entero. Una línea que no cumple el formato lanza con su número de línea. */
export function parseLegacyMetrics(text: string): LegacyMetricsRow[] {
  const rows: LegacyMetricsRow[] = [];
  for (const [i, line] of text.split("\n").entries()) {
    if (!line.trim()) continue;
    let json: unknown;
    try {
      json = JSON.parse(line);
    } catch {
      throw new Error(`metrics.jsonl línea ${i + 1}: no es JSON.`);
    }
    const parsed = LegacyMetricsRow.safeParse(json);
    if (!parsed.success) throw new Error(`metrics.jsonl línea ${i + 1}: ${z.prettifyError(parsed.error)}`);
    rows.push(parsed.data);
  }
  return rows;
}

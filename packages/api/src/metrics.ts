import * as z from "zod";
import { ProjectId } from "./domain";

/**
 * Las métricas salen de `run_metrics` y `run_role_costs` (`docs/design.html#d-data`), que el core llena
 * al cerrar cada corrida. Cuentan corridas cerradas, por el instante en que cerraron. Los costos suman
 * todas las corridas, hijas de subflujo incluidas; los conteos (`runs`, `issues`) solo las raíz, para no
 * contar dos veces el mismo trabajo.
 */
export const MetricsFilter = z.object({
  projectId: ProjectId.optional(),
  /** ms epoch, inclusive. */
  from: z.int().nonnegative().optional(),
  /** ms epoch, exclusive. */
  to: z.int().nonnegative().optional(),
  /** `true` solo las corridas importadas del clanker-loop; `false` solo las que corrió Clanker Yard; sin él, todas. */
  imported: z.boolean().optional(),
});
export type MetricsFilter = z.infer<typeof MetricsFilter>;

/** Lo que un rol gastó. `runs` son las corridas (raíz o hija) en las que actuó. */
export const RoleMetrics = z.object({
  role: z.string(),
  runs: z.int().nonnegative(),
  /** Entrada, salida y caché. */
  tokens: z.int().nonnegative(),
  costMicros: z.int().nonnegative(),
});
export type RoleMetrics = z.infer<typeof RoleMetrics>;

export const ModelMetrics = z.object({
  model: z.string(),
  tokens: z.int().nonnegative(),
  costMicros: z.int().nonnegative(),
});
export type ModelMetrics = z.infer<typeof ModelMetrics>;

export const DayMetrics = z.object({
  /** `YYYY-MM-DD` en la zona de `utcOffsetMinutes`. */
  day: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  /** Corridas raíz que cerraron ese día. */
  runs: z.int().nonnegative(),
  costMicros: z.int().nonnegative(),
});
export type DayMetrics = z.infer<typeof DayMetrics>;

export const DayMetricsFilter = MetricsFilter.extend({
  /** Minutos al este de UTC (el opuesto de `Date.getTimezoneOffset()`); por defecto UTC. */
  utcOffsetMinutes: z.int().min(-840).max(840).default(0),
});
export type DayMetricsFilter = z.input<typeof DayMetricsFilter>;

export const ProjectSummary = z.object({
  /** Corridas raíz cerradas. */
  runs: z.int().nonnegative(),
  /** `result` → corridas raíz, de más a menos. */
  results: z.array(z.object({ result: z.string(), count: z.int().positive() })),
  costMicros: z.int().nonnegative(),
  /** Costo por corrida raíz; `null` sin corridas. */
  avgCostMicros: z.number().nonnegative().nullable(),
  /** Suma de las corridas raíz. */
  minutes: z.number().nonnegative(),
  avgMinutes: z.number().nonnegative().nullable(),
  /** Por contador del flujo: vueltas de todas las corridas y su promedio por corrida raíz. */
  rounds: z.array(z.object({ counter: z.string(), total: z.int().nonnegative(), perRun: z.number().nonnegative() })),
  /** Por costo, de más a menos. */
  byRole: z.array(RoleMetrics),
  /** ms epoch del primer y del último cierre; `null` sin corridas. */
  firstAt: z.int().nonnegative().nullable(),
  lastAt: z.int().nonnegative().nullable(),
});
export type ProjectSummary = z.infer<typeof ProjectSummary>;

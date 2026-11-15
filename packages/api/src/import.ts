import * as z from "zod";

/** `imports.legacy`: lee el estado del clanker-loop en `from` (una carpeta absoluta, p. ej. `~/.local/share/clanker-loop`). */
export const LegacyImportInput = z.object({
  from: z.string().min(1),
  /** Calcula lo que se escribiría sin escribir nada. */
  dryRun: z.boolean().default(false),
});
export type LegacyImportInput = z.input<typeof LegacyImportInput>;

/** Cuántas filas de cada tabla escribió (o escribiría, con `dryRun`) una importación. Lo ya importado no cuenta. */
export const LegacyImportCounts = z.object({
  projects: z.int().nonnegative(),
  issues: z.int().nonnegative(),
  pullRequests: z.int().nonnegative(),
  /** Con su `run_metrics`: una fila de cada una por corrida. */
  runs: z.int().nonnegative(),
  runRoleCosts: z.int().nonnegative(),
  /** Las viñetas de "Decisiones y aprendizajes", `proposed` en la bandeja de learnings. */
  learnings: z.int().nonnegative(),
  /** Las notas de "Decisiones a revisar" (`review_note`, pendientes) y de "Omitidas" (`note`, aceptadas). */
  decisions: z.int().nonnegative(),
  /** Los archivos de `issues/*.md` y el brief de cada proyecto, ya enlazados a su corrida, issue o proyecto. */
  artifacts: z.int().nonnegative(),
  /** Los perfiles de `profiles.json` que no existían como def de usuario. */
  profiles: z.int().nonnegative(),
  modelPrices: z.int().nonnegative(),
});
export type LegacyImportCounts = z.infer<typeof LegacyImportCounts>;

export const LegacyImportResult = z.object({
  dryRun: z.boolean(),
  created: LegacyImportCounts,
  /**
   * Repos del loop viejo que no están registrados (ni por ruta ni por nombre): el import no los inventa.
   * Sus PRs y su lugar en `project_repos` quedan para repetir el import después de registrarlos.
   */
  unresolvedRepos: z.array(z.string()),
});
export type LegacyImportResult = z.infer<typeof LegacyImportResult>;

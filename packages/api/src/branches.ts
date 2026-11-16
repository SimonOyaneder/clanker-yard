import * as z from "zod";
import { ProjectId } from "./domain";

/** `branches.renameLegacy`: los PRs abiertos cuya branch se llama como el id de la issue (`iss_...`). */
export const RenameLegacyInput = z.object({
  /** Solo las issues de este proyecto; sin él, las de todos. */
  projectId: ProjectId.optional(),
  /** Calcula `from → to` de cada PR sin renombrar nada. */
  dryRun: z.boolean().default(false),
});
export type RenameLegacyInput = z.input<typeof RenameLegacyInput>;

/**
 * Qué pasó (o pasaría, con `dryRun`: `planned`) con la branch de un PR. `skipped` lleva su razón (una corrida viva de la
 * issue, el repo sin remoto de GitHub); `failed` la suya, y con la branch remota ya renombrada lo dice.
 */
export const BranchRename = z.object({
  repo: z.string().min(1),
  number: z.int().positive(),
  from: z.string().min(1),
  to: z.string().min(1).optional(),
  status: z.enum(["planned", "renamed", "skipped", "failed"]),
  reason: z.string().optional(),
});
export type BranchRename = z.infer<typeof BranchRename>;

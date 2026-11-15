import type { ZodType } from "zod";
import { Role, Profile } from "./agents";
import { Decision } from "./decisions";
import { type DefKind } from "./domain";
import { FlowBody } from "./flow";
import { Pack } from "./pack";
import { ClankerProject } from "./projects";
import { Recipe } from "./recipe";
import { RunDetail } from "./runs";

/**
 * Convención `.meta({ mcp })` (`docs/design.html#d-data`, "Tools MCP desde el mismo contrato").
 * Un procedimiento que se expone por MCP lo declara aquí, en el contrato, con una de tres formas:
 *
 * - CRUD por kind: `.meta({ mcp: { tool: "list", kind: "flow" } })`. Las tools `list`, `get`, `create`,
 *   `update` y `delete` reciben el `kind` y el input del procedimiento marcado para ese kind. Un
 *   procedimiento que sirve a varios kinds (`defs.list`) declara `kind` como lista y recibe además
 *   `kind` en su input.
 * - Acción: `.meta({ mcp: { action: "retry_step", annotations: { idempotentHint: true } } })`. Una tool
 *   por acción, con el input zod del procedimiento tal cual.
 * - Resource de lectura: `.meta({ mcp: { resource: "run_timeline" } })`; qué URI sirve cada uno lo
 *   decide el generador.
 *
 * Regla de anotaciones: `list` y `get` van con `readOnlyHint`, `update` con `idempotentHint`, `delete` e
 * `interrupt_run` con `destructiveHint`, y todas con `openWorldHint: false` salvo las que publican en
 * GitHub o Linear. Las tools por kind las toman de esa regla; una acción debe declararlas, y el
 * generador falla si no lo hace.
 */
export type McpMeta =
  | {
      tool: "list" | "get" | "create" | "update" | "delete";
      kind: McpKind | readonly McpKind[];
    }
  | { action: string; annotations?: McpAnnotations }
  | { resource: McpResourceName };

/** Los kinds que `list` y `get` entienden: los de `defs` que ya tienen esquema, más las entidades. */
export type McpKind = Exclude<DefKind, "context"> | "project" | "run" | "decision";

export type McpResourceName = "run_timeline" | "step_report";

export interface McpAnnotations {
  readOnlyHint?: boolean;
  idempotentHint?: boolean;
  destructiveHint?: boolean;
  openWorldHint?: boolean;
}

export interface ContractMeta {
  mcp?: McpMeta;
}

/**
 * El esquema que `clanker://schema/<kind>` publica. Los bodies de `defs` van con `io: "input"` (lo que se
 * escribe, con sus defaults opcionales) y las entidades con `io: "output"` (lo que `get` devuelve).
 */
export const MCP_KIND_SCHEMAS = {
  flow: { schema: FlowBody, io: "input" },
  role: { schema: Role, io: "input" },
  profile: { schema: Profile, io: "input" },
  recipe: { schema: Recipe, io: "input" },
  pack: { schema: Pack, io: "input" },
  project: { schema: ClankerProject, io: "output" },
  run: { schema: RunDetail, io: "output" },
  decision: { schema: Decision, io: "output" },
} as const satisfies Record<McpKind, KindSchema>;

export interface KindSchema {
  schema: ZodType;
  io: "input" | "output";
}

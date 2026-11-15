import { FlowDef, type FlowIssue, type Validation } from "@clanker/api";
import type { DefScope, Defs } from "../defs/defs";
import type { ActionDef, Catalog, ConsolidatorDef, RoleInfo, WaitDef } from "./catalog";
import { validateFlow } from "./validate";

/** El flujo se guarda sin `version`: la asigna `save` y vive en la versión de la def. */
const FlowBody = FlowDef.omit({ version: true });

/** `flows.save` con errores de validación: nada se guardó. */
export class FlowValidationError extends Error {
  constructor(
    readonly flowId: string,
    readonly errors: FlowIssue[],
  ) {
    super(`El flujo "${flowId}" es inválido:\n` + errors.map((e) => `  ${e.path || "(raíz)"}: ${e.message}`).join("\n"));
  }
}

export interface FlowVersion {
  /** Id de la def en `defs`. */
  id: string;
  version: number;
  /** `false`: el contenido no cambió y sigue la versión anterior. */
  changed: boolean;
  /** Los avisos no impiden guardar. */
  warnings: FlowIssue[];
}

export interface SaveFlowOptions {
  /** Por defecto `user`. */
  scope?: DefScope;
  /** Obligatorio con scope `repo`. */
  repoId?: string;
  /** `ui`, `mcp`, `import` o `repo:<ruta>@<sha>`. Por defecto `ui`. */
  source?: string;
}

export interface Flows {
  /** Cada módulo registra lo que aporta; registrar dos veces el mismo nombre es un bug. */
  registerAction(def: ActionDef): void;
  registerWait(def: WaitDef): void;
  registerConsolidator(def: ConsolidatorDef): void;
  /**
   * Esquema y reglas del diseño. Los errores llevan la ruta dentro del flujo
   * (`nodes.sync.on.conflict`); los avisos no impiden guardar. `repoId` resuelve los subflujos con scope repo.
   */
  validate(def: unknown, opts?: { repoId?: string }): Validation;
  /**
   * Valida y guarda el flujo en `defs` con slug = `def.id`. Crea una versión nueva solo si el
   * contenido cambió; si hay errores lanza `FlowValidationError`.
   */
  save(def: FlowDef, opts?: SaveFlowOptions): FlowVersion;
}

export interface FlowsDeps {
  defs: Defs;
  /** Los roles viven en Agents: aquí solo se consultan para validar agentes y consolidadores por rol. */
  roles: (id: string) => RoleInfo | undefined;
}

export function createFlows({ defs, roles }: FlowsDeps): Flows {
  const actions = new Map<string, ActionDef>();
  const waits = new Map<string, WaitDef>();
  const consolidators = new Map<string, ConsolidatorDef>();
  defs.register("flow", FlowBody);

  function register<T extends { name: string }>(kind: string, into: Map<string, T>, def: T) {
    if (into.has(def.name)) throw new Error(`Ya hay ${kind} registrado con el nombre "${def.name}".`);
    into.set(def.name, def);
  }

  function catalog(repoId: string | undefined): Catalog {
    return {
      action: (name) => actions.get(name),
      wait: (name) => waits.get(name),
      consolidator: (name) => consolidators.get(name),
      role: roles,
      flow: (id) => {
        const parsed = FlowDef.safeParse(defs.resolve("flow", id, { repoId })?.body);
        return parsed.success ? parsed.data : undefined;
      },
    };
  }

  function validate(def: unknown, opts: { repoId?: string } = {}): Validation {
    const parsed = FlowDef.safeParse(def);
    if (!parsed.success) {
      const errors = parsed.error.issues.map(({ path, message }) => ({ path: path.map(String).join("."), message }));
      return { errors, warnings: [] };
    }
    return validateFlow(parsed.data, catalog(opts.repoId));
  }

  return {
    registerAction: (def) => register("una acción", actions, def),
    registerWait: (def) => register("un wait", waits, def),
    registerConsolidator: (def) => register("un consolidador", consolidators, def),
    validate,

    save(def, { scope = "user", repoId, source = "ui" } = {}) {
      const { errors, warnings } = validate(def, { repoId });
      if (errors.length > 0) throw new FlowValidationError(def.id, errors);
      const body: Partial<FlowDef> = { ...def };
      delete body.version;
      const saved = defs.save({ kind: "flow", slug: def.id, scope, repoId, body, source });
      return { ...saved, warnings };
    },
  };
}

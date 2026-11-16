import { FlowBody, FlowDef, type FlowIssue, type Validation, type RepoId } from "@clanker/api";
import type { ZodType } from "zod";
import type { Agents } from "../agents/agents";
import type { Artifacts } from "../artifacts/artifacts";
import type { DefScope, Defs } from "../defs/defs";
import type { Store } from "../store/store";
import type { ActionDef, Catalog, ConsolidatorDef, RoleInfo, WaitDef } from "./catalog";
import { itemsMerge, worst, worstFlow } from "./consolidators";
import { createEngine, type Engine, type EngineDeps } from "./engine";
import { validateFlow } from "./validate";
import { issuesAsLines } from "../errors/format";

/** `flows.save` con errores de validación: nada se guardó. */
export class FlowValidationError extends Error {
  constructor(
    readonly flowId: string,
    readonly errors: FlowIssue[],
  ) {
    super(`El flujo "${flowId}" es inválido:\n` + issuesAsLines(errors));
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
  repoId?: RepoId;
  /** `ui`, `mcp`, `import` o `repo:<ruta>@<sha>`. Por defecto `ui`. */
  source?: string;
}

export interface Flows extends Engine {
  /**
   * Cada módulo registra lo que aporta; registrar dos veces el mismo nombre es un bug, y registrar
   * después de `recover()` lanza (los pasos que se recuperaron ya no la encontrarían).
   */
  registerAction<A extends ZodType>(def: ActionDef<A>): void;
  registerWait<A extends ZodType>(def: WaitDef<A>): void;
  /** `worst` e `items.merge` ya vienen registrados. */
  registerConsolidator<A extends ZodType>(def: ConsolidatorDef<A>): void;
  /**
   * Esquema y reglas del diseño. Los errores llevan la ruta dentro del flujo
   * (`nodes.sync.on.conflict`); los avisos no impiden guardar. `repoId` resuelve los subflujos con scope repo.
   */
  validate(def: unknown, opts?: { repoId?: RepoId }): Validation;
  /**
   * Valida y guarda el flujo en `defs` con slug = `def.id`. Crea una versión nueva solo si el
   * contenido cambió; si hay errores lanza `FlowValidationError`.
   */
  save(def: FlowDef, opts?: SaveFlowOptions): FlowVersion;
}

export interface FlowsDeps extends Omit<EngineDeps, "actions" | "consolidators" | "waits"> {
  store: Store;
  defs: Defs;
  agents: Agents;
  artifacts: Artifacts;
  /** Los roles viven en Agents: aquí solo se consultan para validar agentes y consolidadores por rol. */
  roles: (id: string) => RoleInfo | undefined;
}

export function createFlows({ roles, ...deps }: FlowsDeps): Flows {
  const { defs } = deps;
  const actions = new Map<string, ActionDef>();
  const consolidators = new Map<string, ConsolidatorDef>([
    [worst.name, worst],
    [worstFlow.name, worstFlow],
    [itemsMerge.name, itemsMerge],
  ]);
  const waits = new Map<string, WaitDef>();
  const engine = createEngine({ ...deps, actions, consolidators, waits });
  defs.register("flow", FlowBody);

  // Tras `recover()` el dispatcher ya corre: un paso recuperado de una acción aún sin registrar falla para siempre.
  let recovered = false;

  function register<T extends { name: string }>(kind: string, into: Map<string, T>, def: T) {
    if (recovered) throw new Error(`No se puede registrar ${kind} ("${def.name}") después de recover(): regístralo antes, o los pasos que la usan no la encuentran.`);
    if (into.has(def.name)) throw new Error(`Ya hay ${kind} registrado con el nombre "${def.name}".`);
    into.set(def.name, def);
  }

  function catalog(repoId: RepoId | undefined): Catalog {
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

  function validate(def: unknown, opts: { repoId?: RepoId } = {}): Validation {
    const parsed = FlowDef.safeParse(def);
    if (!parsed.success) {
      const errors = parsed.error.issues.map(({ path, message }) => ({ path: path.map(String).join("."), message }));
      return { errors, warnings: [] };
    }
    return validateFlow(parsed.data, catalog(opts.repoId));
  }

  return {
    ...engine,
    recover() {
      recovered = true;
      return engine.recover();
    },
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

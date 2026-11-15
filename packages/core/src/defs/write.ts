import type { ClientOrigin, DefChange, DefCreate, DefIssue, DefUpdate, DefWrite, DefWriteKind, FlowDef } from "@clanker/api";
import type { Flows } from "../flows/flows";
import { canonicalJson, DefValidationError, type Def, type DefScope, type Defs } from "./defs";

/** No existe la def que se quiere cambiar. */
export class DefNotFoundError extends Error {
  constructor(kind: string, id: string) {
    super(`No existe ${kind} ${id}.`);
  }
}

/** El body es inválido o la def no admite el cambio: no se guardó nada. */
export class DefWriteError extends Error {}

/** El core regenera las `builtin` en cada arranque y sincroniza las de un pack: un cambio no se queda. */
const WRITABLE_SCOPES: readonly DefScope[] = ["user", "repo"];

export interface DefWriter {
  /** `defs.create` (`@clanker/api`): valida, guarda la versión 1 y devuelve la def, o con `dryRun` solo valida. */
  create(input: DefCreate, origin: ClientOrigin): DefWrite;
  /** `defs.update`: una versión nueva si el body cambió; con `dryRun`, el diff contra la vigente sin guardar. */
  update(input: DefUpdate, origin: ClientOrigin): DefWrite;
  /** Archiva sin tocar las corridas que usaron la def. */
  archive(kind: DefWriteKind, id: string, origin: ClientOrigin): Def;
  restore(kind: DefWriteKind, id: string, origin: ClientOrigin): Def;
}

/**
 * La escritura de defs que comparten la API y el MCP. Un flujo se valida además con `flows.validate`
 * (roles, acciones y subflujos que existen) y se guarda con `flows.save`; los demás kinds, con el
 * validador de su kind. Todo lo que no se puede guardar vuelve junto, como `errors`: el modelo corrige de una vez.
 */
export function createDefWriter({ defs, flows }: { defs: Defs; flows: Pick<Flows, "validate" | "save"> }): DefWriter {
  interface Checked {
    slug: string | undefined;
    /** El body con sus defaults; falta si no cumple el esquema del kind. */
    parsed?: unknown;
    errors: DefIssue[];
    warnings: DefIssue[];
  }

  /** `slug` es el que ya se conoce (el de la def a actualizar, o el que dio quien crea); un flujo lo trae en su body. */
  function check(kind: DefWriteKind, slug: string | undefined, body: unknown, repoId: string | undefined): Checked {
    let parsed: unknown;
    try {
      parsed = defs.validate(kind, slug ?? "", body);
    } catch (error) {
      if (!(error instanceof DefValidationError)) throw error;
      return { slug, errors: error.issues.map(({ path, message }) => ({ path: path.map(String).join("."), message })), warnings: [] };
    }
    if (kind !== "flow") {
      const errors = slug === undefined ? [{ path: "slug", message: `un ${kind} necesita slug` }] : [];
      return { slug, parsed, errors, warnings: [] };
    }
    const { id } = parsed as { id: string };
    const validation = flows.validate(parsed, { repoId });
    const errors = [...validation.errors];
    if (slug !== undefined && slug !== id) errors.push({ path: "id", message: `el id del flujo es "${id}" y debe ser su slug "${slug}"` });
    return { slug: id, parsed, errors, warnings: validation.warnings };
  }

  function find(kind: DefWriteKind, id: string): Def {
    const def = defs.get(kind, id);
    if (!def) throw new DefNotFoundError(kind, id);
    return def;
  }

  /** Lo que `create` y `update` devuelven: los errores (o su `BAD_REQUEST`), el diff si es `dryRun`, o la def guardada. */
  function conclude(
    { kind, dryRun, checked, errors, before }: { kind: DefWriteKind; dryRun: boolean; checked: Checked; errors: DefIssue[]; before: unknown },
    save: () => { id: string; changed: boolean },
  ): DefWrite {
    const { warnings } = checked;
    if (errors.length > 0) {
      if (!dryRun) throw new DefWriteError(`No se guardó ${kind} "${checked.slug ?? ""}":\n` + errors.map((e) => `  ${e.path || "(raíz)"}: ${e.message}`).join("\n"));
      return { dryRun, errors, warnings, changed: false, diff: [], def: null };
    }
    const diff = diffBodies(before, checked.parsed);
    if (dryRun) return { dryRun, errors, warnings, changed: diff.length > 0, diff, def: null };
    const { id, changed } = save();
    return { dryRun, errors, warnings, changed, diff: changed ? diff : [], def: defs.get(kind, id)! };
  }

  return {
    create({ kind, slug, scope, repoId, body, dryRun }, origin) {
      const checked = check(kind, slug, body, repoId);
      const errors = [...checked.errors];
      if ((scope === "repo") !== (repoId !== undefined)) errors.push({ path: "repoId", message: 'es obligatorio con scope "repo" y no se admite con "user"' });
      const clash = checked.slug === undefined ? undefined : defs.list(kind, { includeArchived: true }).find((d) => d.slug === checked.slug && d.scope === scope && d.repoId === (repoId ?? null));
      if (clash) {
        const next = clash.archivedAt === null ? `usa update con su id ${clash.id}` : `está archivada: restáurala (defs.restore ${clash.id}) en vez de crearla`;
        errors.push({ path: "slug", message: `ya existe ${kind} "${clash.slug}" (${scope}): ${next}` });
      }
      return conclude({ kind, dryRun, checked, errors, before: undefined }, () => {
        if (kind === "flow") return flows.save(checked.parsed as FlowDef, { scope, repoId, source: origin });
        return defs.save({ kind, slug: checked.slug!, scope, repoId, body: checked.parsed, source: origin });
      });
    },

    update({ kind, id, body, dryRun }, origin) {
      const current = find(kind, id);
      const repoId = current.repoId ?? undefined;
      const checked = check(kind, current.slug, body, repoId);
      const errors = [...checked.errors];
      if (!WRITABLE_SCOPES.includes(current.scope)) errors.push({ path: "", message: scopeMessage(current) + " Para pisarla, créala con scope user y el mismo slug." });
      if (current.archivedAt !== null) errors.push({ path: "", message: `${kind} "${current.slug}" está archivada: restáurala (defs.restore) antes de editarla.` });
      return conclude({ kind, dryRun, checked, errors, before: current.body }, () => {
        if (kind === "flow") return flows.save(checked.parsed as FlowDef, { scope: current.scope, repoId, source: origin });
        return defs.save({ kind, slug: current.slug, scope: current.scope, repoId, body: checked.parsed, source: origin });
      });
    },

    archive(kind, id, origin) {
      const def = find(kind, id);
      if (!WRITABLE_SCOPES.includes(def.scope)) throw new DefWriteError(scopeMessage(def));
      defs.archive(kind, id, origin);
      return find(kind, id);
    },

    restore(kind, id, origin) {
      const def = find(kind, id);
      // Una builtin o de pack solo la archiva el core (un pack que ya no la trae): restaurarla la revive hasta el próximo sync.
      if (!WRITABLE_SCOPES.includes(def.scope)) throw new DefWriteError(scopeMessage(def));
      defs.restore(kind, id, origin);
      return find(kind, id);
    },
  };
}

function scopeMessage({ kind, slug, scope }: Def): string {
  return `${kind} "${slug}" es de scope ${scope}: el core la regenera al arrancar o sincronizar, y un cambio no se queda.`;
}

/** Las hojas que cambian entre dos bodies, con su ruta (`modes.dev.outcomes`); un arreglo se compara entero. */
export function diffBodies(before: unknown, after: unknown, path = ""): DefChange[] {
  if (isRecord(before) && isRecord(after)) {
    const keys = [...new Set([...Object.keys(before), ...Object.keys(after)])].sort();
    return keys.flatMap((key) => diffBodies(before[key], after[key], path === "" ? key : `${path}.${key}`));
  }
  return canonicalJson(before) === canonicalJson(after) ? [] : [{ path, before, after }];
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

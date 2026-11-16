import { createHash } from "node:crypto";
import type { DefKind, Origin, RepoId } from "@clanker/api";
import { and, asc, desc, eq, isNull } from "drizzle-orm";
import type { ZodType } from "zod";
import { newId } from "../store/conventions";
import { DEF_SCOPES, defs, defVersions } from "../store/schema";
import type { Store } from "../store/store";
import { issuesAsLines } from "../errors/format";

export type DefScope = (typeof DEF_SCOPES)[number];

/** El mismo orden en que se resuelve un slug: el primero que exista gana. */
const SCOPE_PRECEDENCE = ["user", "repo", "pack", "builtin"] as const satisfies readonly DefScope[];

export interface SaveDef {
  kind: DefKind;
  slug: string;
  scope: DefScope;
  /** Obligatorio con scope `repo`, y solo ahí. */
  repoId?: RepoId;
  body: unknown;
  /** `ui`, `cli`, `mcp`, `import` o `repo:<ruta>@<sha>`. */
  source: string;
}

export interface Def {
  id: string;
  kind: DefKind;
  slug: string;
  scope: DefScope;
  repoId: RepoId | null;
  archivedAt: number | null;
  currentVersion: number;
  /** La versión pedida (o la actual) con su contenido. */
  version: number;
  body: unknown;
  source: string;
  createdAt: number;
}

export interface DefVersion {
  version: number;
  bodyHash: string;
  source: string;
  createdAt: number;
}

export interface DefIssue {
  /** Ruta dentro del body, por ejemplo `["steps", 0, "id"]`. */
  path: PropertyKey[];
  message: string;
}

/** El body no cumple el validador de su kind. */
export class DefValidationError extends Error {
  constructor(
    readonly kind: DefKind,
    readonly slug: string,
    readonly issues: DefIssue[],
  ) {
    super(
      `El body de ${kind} "${slug}" es inválido:\n` +
        issuesAsLines(issues),
    );
  }
}

export interface Defs {
  /** Cada módulo enchufa el validador de los kinds que posee. Registrar un kind dos veces es un bug. */
  register(kind: DefKind, schema: ZodType): void;
  /**
   * Valida el body con el validador de su kind sin guardar nada. Lanza `DefValidationError`
   * con la ruta de cada problema. Devuelve el body ya parseado (con sus defaults).
   */
  validate(kind: DefKind, slug: string, body: unknown): unknown;
  /**
   * Valida el body con el validador de su kind y lo guarda. Crea la def (versión 1) o, si ya
   * existe, una versión nueva, pero solo cuando el body validado cambia: el mismo contenido
   * dos veces no suma versiones ni emite eventos. Devuelve el id de la def y su versión vigente.
   */
  save(input: SaveDef): { id: string; version: number; changed: boolean };
  /** La def con el body de `version`, o el de la vigente. `undefined` si el id no existe en ese kind. */
  get(kind: DefKind, id: string, version?: number): Def | undefined;
  /** Las defs del kind con su versión vigente. Las archivadas solo con `includeArchived`. */
  list(kind: DefKind, opts?: { includeArchived?: boolean }): Def[];
  /** Historial de la def, de la más nueva a la más vieja. */
  versions(kind: DefKind, id: string): DefVersion[];
  /**
   * La def que gana para `slug`: user, luego repo (si se da `repoId`), luego pack, luego builtin.
   * Una def archivada no participa, así que deja pasar a la de menor precedencia.
   */
  resolve(kind: DefKind, slug: string, opts?: { repoId?: RepoId }): Def | undefined;
  archive(kind: DefKind, id: string, origin: Origin): void;
  restore(kind: DefKind, id: string, origin: Origin): void;
}

export function createDefs(store: Store, now: () => number = Date.now): Defs {
  const schemas = new Map<DefKind, ZodType>();

  function load(kind: DefKind, id: string, version?: number): Def | undefined {
    return selectDefs(and(eq(defs.kind, kind), eq(defs.id, id)), version)[0];
  }

  function selectDefs(where: ReturnType<typeof and>, version?: number): Def[] {
    const rows = store.db
      .select({ def: defs, version: defVersions })
      .from(defs)
      .innerJoin(
        defVersions,
        and(
          eq(defVersions.defId, defs.id),
          version === undefined
            ? eq(defVersions.version, defs.currentVersion)
            : eq(defVersions.version, version),
        ),
      )
      .where(where)
      .orderBy(asc(defs.slug), asc(defs.scope))
      .all();
    return rows.map(({ def, version: v }) => ({
      id: def.id,
      kind: def.kind,
      slug: def.slug,
      scope: def.scope,
      repoId: def.repoId,
      archivedAt: def.archivedAt,
      currentVersion: def.currentVersion,
      version: v.version,
      body: v.body,
      source: v.source,
      createdAt: v.createdAt,
    }));
  }

  /** Marca archivada o vigente; no hace nada (ni emite) si ya está en ese estado. */
  function setArchived(kind: DefKind, id: string, archived: boolean, origin: Origin): void {
    store.tx((tx) => {
      const row = tx.db
        .select()
        .from(defs)
        .where(and(eq(defs.kind, kind), eq(defs.id, id)))
        .get();
      if (!row) throw new Error(`No existe la def ${kind} ${id}.`);
      if ((row.archivedAt !== null) === archived) return;
      tx.db
        .update(defs)
        .set({ archivedAt: archived ? now() : null })
        .where(eq(defs.id, id))
        .run();
      tx.emit({
        type: archived ? "def.archived" : "def.restored",
        origin,
        payload: { kind, defId: id, version: row.currentVersion },
      });
    });
  }

  function validate(kind: DefKind, slug: string, body: unknown): unknown {
    const schema = schemas.get(kind);
    if (!schema) {
      throw new Error(
        `No hay validador registrado para el kind "${kind}": el módulo que lo posee debe llamar a defs.register antes de guardar.`,
      );
    }
    const parsed = schema.safeParse(body);
    if (!parsed.success) {
      throw new DefValidationError(
        kind,
        slug,
        parsed.error.issues.map(({ path, message }) => ({ path, message })),
      );
    }
    return parsed.data;
  }

  return {
    register(kind, schema) {
      if (schemas.has(kind)) throw new Error(`Ya hay un validador registrado para el kind "${kind}".`);
      schemas.set(kind, schema);
    },

    validate,

    save({ kind, slug, scope, repoId, body, source }) {
      if ((scope === "repo") !== (repoId !== undefined)) {
        throw new Error(
          `La def ${kind} "${slug}" (${scope}): repoId es obligatorio con scope "repo" y no se admite en los demás.`,
        );
      }
      const parsed = validate(kind, slug, body);
      const bodyHash = hashBody(parsed);

      return store.tx((tx) => {
        const existing = tx.db
          .select()
          .from(defs)
          .where(
            and(
              eq(defs.kind, kind),
              eq(defs.slug, slug),
              eq(defs.scope, scope),
              repoId === undefined ? isNull(defs.repoId) : eq(defs.repoId, repoId),
            ),
          )
          .get();

        let id: string;
        let version: number;
        if (existing) {
          if (existing.archivedAt !== null) {
            throw new Error(
              `La def ${kind} "${slug}" (${scope}) está archivada: restáurala antes de guardar una versión nueva.`,
            );
          }
          const current = tx.db
            .select({ bodyHash: defVersions.bodyHash })
            .from(defVersions)
            .where(
              and(eq(defVersions.defId, existing.id), eq(defVersions.version, existing.currentVersion)),
            )
            .get();
          if (current?.bodyHash === bodyHash) {
            return { id: existing.id, version: existing.currentVersion, changed: false };
          }
          id = existing.id;
          version = existing.currentVersion + 1;
          tx.db.update(defs).set({ currentVersion: version }).where(eq(defs.id, id)).run();
        } else {
          id = newId("def");
          version = 1;
          tx.db
            .insert(defs)
            .values({ id, kind, slug, scope, repoId: repoId ?? null, currentVersion: version })
            .run();
        }
        tx.db
          .insert(defVersions)
          .values({ defId: id, version, body: parsed, bodyHash, source, createdAt: now() })
          .run();
        tx.emit({
          type: "def.versioned",
          origin: sourceOrigin(source),
          payload: { kind, defId: id, version, source },
        });
        return { id, version, changed: true };
      });
    },

    get: load,

    list(kind, opts = {}) {
      return selectDefs(
        and(eq(defs.kind, kind), opts.includeArchived ? undefined : isNull(defs.archivedAt)),
      );
    },

    versions(kind, id) {
      return store.db
        .select({
          version: defVersions.version,
          bodyHash: defVersions.bodyHash,
          source: defVersions.source,
          createdAt: defVersions.createdAt,
        })
        .from(defVersions)
        .innerJoin(defs, eq(defs.id, defVersions.defId))
        .where(and(eq(defs.kind, kind), eq(defs.id, id)))
        .orderBy(desc(defVersions.version))
        .all();
    },

    resolve(kind, slug, opts = {}) {
      const candidates = selectDefs(
        and(eq(defs.kind, kind), eq(defs.slug, slug), isNull(defs.archivedAt)),
      ).filter((d) => d.scope !== "repo" || d.repoId === opts.repoId);
      for (const scope of SCOPE_PRECEDENCE) {
        const winner = candidates.find((d) => d.scope === scope);
        if (winner) return winner;
      }
      return undefined;
    },

    archive: (kind, id, origin) => setArchived(kind, id, true, origin),
    restore: (kind, id, origin) => setArchived(kind, id, false, origin),
  };
}

function sourceOrigin(source: string): Origin {
  if (source === "ui" || source === "cli" || source === "mcp" || source === "import") return source;
  return "core";
}

/** SHA-256 del JSON con las claves ordenadas: el orden en que llegan no cambia el hash. */
function hashBody(body: unknown): string {
  return createHash("sha256").update(canonicalJson(body)).digest("hex");
}

/** Lo que `hashBody` hashea; `diffBodies` lo usa para decir que dos valores son el mismo. */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

/** Un objeto JSON (no `null` ni un arreglo). */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

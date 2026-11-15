import { readFile } from "node:fs/promises";
import { basename, extname, join } from "node:path";
import { NodeId, Pack, PackSettings, type DefKind, type PackScope, type ResolvedPack } from "@clanker/api";
import * as z from "zod";
import { DefValidationError, type DefIssue, type Defs } from "../defs/defs";

/** `PackSettings` sin ser estricto: lo que queda de un `Pack` al quitarle id, alcance y archivos. */
const SettingsOfPack = z.object(PackSettings.shape);

/** El pack de una carpeta no se pudo leer o no es válido; `file` es el archivo del problema. */
export class PackLoadError extends Error {
  constructor(
    readonly dir: string,
    readonly file: string,
    readonly issues: DefIssue[],
  ) {
    super(
      `El pack en ${dir} es inválido, ${file}:\n` +
        issues.map((i) => `  ${i.path.length === 0 ? "(raíz)" : i.path.map(String).join(".")}: ${i.message}`).join("\n"),
    );
  }
}

export interface Packs {
  /**
   * Lee `<dir>/pack.json` con los flujos y roles que lista y los guarda como defs: el pack con scope
   * `pack` y cada flujo y rol con scope `pack` y source `pack:<id>@<version>`. Valida todo antes de
   * escribir, así que un pack inválido no deja nada a medias. Lo que una versión anterior del pack traía
   * y esta ya no, se archiva. Cargar dos veces el mismo contenido no crea versiones.
   */
  load(dir: string): Promise<{ id: string; version: number; changed: boolean }>;
  /**
   * El pack que se activa para este repo o proyecto (por org de GitHub, workspace del tracker o proyecto), o
   * los defaults neutros si ninguno cubre el alcance. Si dos packs lo cubren gana el de menor id.
   */
  packFor(scope: PackScope): ResolvedPack;
}

interface PackedDef {
  file: string;
  kind: "flow" | "role";
  slug: string;
  body: unknown;
}

export function createPacks({ defs }: { defs: Defs }): Packs {
  defs.register("pack", Pack);

  async function readJson(dir: string, file: string): Promise<unknown> {
    let text: string;
    try {
      text = await readFile(join(dir, file), "utf8");
    } catch (error) {
      throw new PackLoadError(dir, file, [
        { path: [], message: `no se pudo leer: ${error instanceof Error ? error.message : String(error)}` },
      ]);
    }
    try {
      return JSON.parse(text);
    } catch (error) {
      throw new PackLoadError(dir, file, [
        { path: [], message: `no es JSON: ${error instanceof Error ? error.message : String(error)}` },
      ]);
    }
  }

  /** Valida con el validador del kind; los problemas salen con su ruta dentro del archivo. */
  function check(dir: string, file: string, kind: DefKind, slug: string, body: unknown): unknown {
    try {
      return defs.validate(kind, slug, body);
    } catch (error) {
      if (error instanceof DefValidationError) throw new PackLoadError(dir, file, error.issues);
      throw error;
    }
  }

  async function readPacked(dir: string, pack: Pack): Promise<PackedDef[]> {
    const out: PackedDef[] = [];
    for (const [kind, files] of [["role", pack.roles], ["flow", pack.flows]] as const) {
      for (const file of files) {
        const body = await readJson(dir, file);
        const slug = basename(file, extname(file));
        if (!NodeId.safeParse(slug).success) {
          throw new PackLoadError(dir, file, [
            { path: [], message: `el nombre del archivo es el id del ${kind} y no es válido: empieza con una letra y usa letras, números, _ y -` },
          ]);
        }
        check(dir, file, kind, slug, body);
        const id = (body as { id?: unknown }).id;
        if (kind === "flow" && id !== slug) {
          throw new PackLoadError(dir, file, [
            { path: ["id"], message: `el id del flujo ("${String(id)}") debe ser el nombre del archivo ("${slug}")` },
          ]);
        }
        if (out.some((d) => d.kind === kind && d.slug === slug)) {
          throw new PackLoadError(dir, file, [{ path: [], message: `el ${kind} "${slug}" está repetido en el pack` }]);
        }
        out.push({ file, kind, slug, body });
      }
    }
    return out;
  }

  return {
    async load(dir) {
      const manifest = await readJson(dir, "pack.json");
      const parsed = Pack.safeParse(manifest);
      if (!parsed.success) {
        throw new PackLoadError(dir, "pack.json", parsed.error.issues.map(({ path, message }) => ({ path, message })));
      }
      const pack = parsed.data;
      const source = `pack:${pack.id}@${pack.version}`;
      const mine = (existingSource: string) => existingSource.startsWith(`pack:${pack.id}@`);

      const packed = await readPacked(dir, pack);
      const existing = (["flow", "role"] as const).flatMap((kind) =>
        defs.list(kind, { includeArchived: true }).filter((d) => d.scope === "pack"),
      );
      for (const def of packed) {
        const taken = existing.find((d) => d.kind === def.kind && d.slug === def.slug);
        if (taken && !mine(taken.source)) {
          throw new PackLoadError(dir, def.file, [
            { path: [], message: `el ${def.kind} "${def.slug}" ya lo trae otro pack (${taken.source}): renómbralo` },
          ]);
        }
      }

      // Lo que este pack traía antes y ya no: fuera de `resolve`. Lo que vuelve, se restaura.
      let changed = false;
      for (const def of existing.filter((d) => mine(d.source))) {
        const stillThere = packed.some((p) => p.kind === def.kind && p.slug === def.slug);
        if (!stillThere && def.archivedAt === null) {
          defs.archive(def.kind, def.id, "core");
          changed = true;
        }
        if (stillThere && def.archivedAt !== null) {
          defs.restore(def.kind, def.id, "core");
          changed = true;
        }
      }

      for (const def of packed) {
        changed = defs.save({ kind: def.kind, slug: def.slug, body: def.body, scope: "pack", source }).changed || changed;
      }
      const saved = defs.save({ kind: "pack", slug: pack.id, scope: "pack", body: manifest, source });
      return { id: pack.id, version: pack.version, changed: changed || saved.changed };
    },

    packFor(scope) {
      for (const def of defs.list("pack")) {
        const pack = Pack.parse(def.body);
        if (covers(pack.activate, scope)) return { id: pack.id, ...SettingsOfPack.parse(pack) };
      }
      return { id: null, ...PackSettings.parse({}) };
    },
  };
}

function covers(activate: Pack["activate"], scope: PackScope): boolean {
  const listed = (list: string[] | undefined, value: string | undefined) =>
    value !== undefined && (list ?? []).some((item) => item.toLowerCase() === value.toLowerCase());
  return (
    listed(activate.githubOrgs, scope.githubOrg) ||
    listed(activate.trackerWorkspaces, scope.trackerWorkspace) ||
    (scope.projectId !== undefined && (activate.projects ?? []).includes(scope.projectId))
  );
}

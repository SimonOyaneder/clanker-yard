import { cp, readdir, readFile, rm } from "node:fs/promises";
import { basename, extname, join, resolve } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { NodeId, Pack, PackSettings, Role, type DefKind, type PackInfo, type PackOrigin, type PackScope, type ResolvedPack } from "@clanker/api";
import * as z from "zod";
import { DefValidationError, type DefIssue, type Defs } from "../defs/defs";
import { issuesAsLines, messageOf } from "../errors/format";
import { BadRequestError } from "../errors/domain";

/** `PackSettings` sin ser estricto: lo que queda de un `Pack` al quitarle id, alcance y archivos. */
const SettingsOfPack = z.object(PackSettings.shape);

/** El pack de una carpeta no se pudo leer o no es válido; `file` es el archivo del problema. */
export class PackLoadError extends BadRequestError {
  constructor(
    readonly dir: string,
    readonly file: string,
    readonly issues: DefIssue[],
  ) {
    super(
      `El pack en ${dir} es inválido, ${file}:\n` +
        issuesAsLines(issues),
    );
  }
}

/** Instalar o quitar un pack no se puede: el mensaje dice qué cambiar. */
export class PackInstallError extends BadRequestError {}

export interface Packs {
  /**
   * Lee `<dir>/pack.json` con los flujos, roles y paquetes de contexto que lista y los guarda como defs: el pack con scope
   * `pack` y cada flujo, rol y paquete de contexto con scope `pack` y source `pack:<id>@<version>`. Valida todo antes de
   * escribir, así que un pack inválido no deja nada a medias. Lo que una versión anterior del pack traía
   * y esta ya no, se archiva. Cargar dos veces el mismo contenido no crea versiones.
   */
  load(dir: string): Promise<{ id: string; version: number; changed: boolean }>;
  /**
   * Deja activos los packs de la app (`factoryDir`) y los instalados (`installedDir`): de cada id, la versión más
   * alta, y a igual versión el instalado, para no pisar con el de fábrica lo que alguien copió a mano ni crear
   * versiones nuevas por cargar dos copias del mismo pack. Que una carpeta no exista es no tener packs. Un pack
   * roto no impide cargar los demás: sale en `errors` con su carpeta. Lo que ya no está en ninguna carpeta no se
   * archiva (para eso, `remove`).
   */
  reload(): Promise<{ errors: PackLoadError[] }>;
  /** Los packs activos, por id. */
  list(): PackInfo[];
  /**
   * Valida el pack de `dir`, lo copia a `installedDir` (sobre su carpeta si ya estaba instalado) y lo activa.
   * Falla con `PackLoadError` si no es válido y con `PackInstallError` si ya hay una versión más nueva activa.
   */
  install(dir: string): Promise<PackInfo>;
  /**
   * Borra el pack instalado `id`; si la app trae otro con ese id vuelve a regir ese, y si no sus defs se archivan.
   * Falla con `PackInstallError` si no está instalado.
   */
  remove(id: string): Promise<void>;
  /**
   * El pack que se activa para este repo o proyecto (por org de GitHub, workspace del tracker o proyecto), o
   * los defaults neutros si ninguno cubre el alcance. Si dos packs lo cubren gana el de menor id.
   */
  packFor(scope: PackScope): ResolvedPack;
}

/** Los kinds de def que un pack trae como archivos. */
const PACKED_KINDS = ["role", "flow", "context"] as const;
type PackedKind = (typeof PACKED_KINDS)[number];

interface PackedDef {
  file: string;
  kind: PackedKind;
  slug: string;
  body: unknown;
}

interface Candidate {
  id: string;
  version: number;
  origin: PackOrigin;
  dir: string;
}

/** `factoryDir` e `installedDir` son carpetas con una subcarpeta por pack; sin ellas (un test) no hay qué recargar ni instalar. */
export function createPacks({ defs, factoryDir, installedDir }: { defs: Defs; factoryDir?: string; installedDir?: string }): Packs {
  defs.register("pack", Pack);

  async function readJson(dir: string, file: string): Promise<unknown> {
    let text: string;
    try {
      text = await readFile(join(dir, file), "utf8");
    } catch (error) {
      throw new PackLoadError(dir, file, [
        { path: [], message: `no se pudo leer: ${messageOf(error)}` },
      ]);
    }
    try {
      return JSON.parse(text);
    } catch (error) {
      throw new PackLoadError(dir, file, [
        { path: [], message: `no es JSON: ${messageOf(error)}` },
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
    for (const [kind, files] of [["role", pack.roles], ["flow", pack.flows], ["context", pack.contexts]] as const) {
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

  /**
   * Un rol del pack con el slug de uno de la plantilla (`builtin`) lo pisa en todos los flujos que lo usan, así que
   * tiene que traer cada modo de ese rol con los mismos outcomes, sesión, payload y reporte (puede sumar modos).
   */
  function checkOverride(dir: string, def: PackedDef): void {
    if (def.kind !== "role") return;
    const builtin = defs.list("role").find((d) => d.slug === def.slug && d.scope === "builtin");
    if (builtin === undefined) return;
    const ours = Role.parse(def.body).modes;
    const issues: DefIssue[] = [];
    for (const [name, theirs] of Object.entries(Role.parse(builtin.body).modes)) {
      const mode = ours[name];
      if (mode === undefined) {
        issues.push({ path: ["modes", name], message: `falta: el rol "${def.slug}" de la plantilla lo tiene y sus flujos lo usan` });
        continue;
      }
      for (const field of ["outcomes", "session", "payload", "report"] as const) {
        if (!isDeepStrictEqual(mode[field], theirs[field])) {
          issues.push({
            path: ["modes", name, field],
            message: `distinto del rol "${def.slug}" de la plantilla, que este pisa: los flujos de la plantilla dependen de él`,
          });
        }
      }
    }
    if (issues.length > 0) throw new PackLoadError(dir, def.file, issues);
  }

  /** Lee y valida el pack de `dir` entero (manifiesto y archivos) sin escribir nada. */
  async function read(dir: string) {
    const manifest = await readJson(dir, "pack.json");
    const parsed = Pack.safeParse(manifest);
    if (!parsed.success) {
      throw new PackLoadError(dir, "pack.json", parsed.error.issues.map(({ path, message }) => ({ path, message })));
    }
    return { pack: parsed.data, manifest, packed: await readPacked(dir, parsed.data) };
  }

  /** Las carpetas de packs de `root`; que no exista es no tener packs. */
  async function packDirs(root: string): Promise<string[]> {
    const entries = await readdir(root, { withFileTypes: true }).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return [];
      throw error;
    });
    return entries.filter((e) => e.isDirectory()).map((e) => join(root, e.name)).sort();
  }

  /** Lo que encontró el último `reload`, para que `install` y `remove` sepan qué carpeta es de quién. */
  let candidates: Candidate[] = [];
  const origins = new Map<string, PackOrigin>();

  const self: Packs = {
    async load(dir) {
      const { pack, manifest, packed } = await read(dir);
      const source = `pack:${pack.id}@${pack.version}`;
      const mine = (existingSource: string) => existingSource.startsWith(`pack:${pack.id}@`);

      for (const def of packed) checkOverride(dir, def);

      const existing = PACKED_KINDS.flatMap((kind) =>
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
      // Un pack que se quitó y vuelve (`remove` archiva también su manifiesto).
      const archivedManifest = defs.list("pack", { includeArchived: true }).find((d) => d.slug === pack.id && d.archivedAt !== null);
      if (archivedManifest) {
        defs.restore("pack", archivedManifest.id, "core");
        changed = true;
      }

      for (const def of packed) {
        changed = defs.save({ kind: def.kind, slug: def.slug, body: def.body, scope: "pack", source }).changed || changed;
      }
      const saved = defs.save({ kind: "pack", slug: pack.id, scope: "pack", body: manifest, source });
      return { id: pack.id, version: pack.version, changed: changed || saved.changed };
    },

    async reload() {
      const errors: PackLoadError[] = [];
      const found: Candidate[] = [];
      for (const [origin, root] of [["factory", factoryDir], ["installed", installedDir]] as const) {
        if (root === undefined) continue;
        for (const dir of await packDirs(root)) {
          try {
            const { pack } = await read(dir);
            found.push({ id: pack.id, version: pack.version, origin, dir });
          } catch (error) {
            if (!(error instanceof PackLoadError)) throw error;
            errors.push(error);
          }
        }
      }
      candidates = found;
      for (const winner of winners(found)) {
        try {
          await self.load(winner.dir);
          origins.set(winner.id, winner.origin);
        } catch (error) {
          if (!(error instanceof PackLoadError)) throw error;
          errors.push(error);
        }
      }
      return { errors };
    },

    list() {
      return defs.list("pack").map((def) => {
        const pack = Pack.parse(def.body);
        return { id: pack.id, version: pack.version, origin: origins.get(pack.id) ?? "installed", activate: pack.activate };
      });
    },

    async install(dir) {
      if (installedDir === undefined) throw new PackInstallError("Este core no tiene una carpeta de packs instalados.");
      const { pack } = await read(dir);
      const active = defs.list("pack").map((d) => Pack.parse(d.body)).find((p) => p.id === pack.id);
      if (active && active.version > pack.version) {
        throw new PackInstallError(
          `Ya está activa la versión ${active.version} del pack "${pack.id}", más nueva que la ${pack.version} de esa carpeta.`,
        );
      }
      const previous = candidates.find((c) => c.origin === "installed" && c.id === pack.id);
      const dest = previous?.dir ?? join(installedDir, pack.id);
      if (resolve(dir) !== resolve(dest)) {
        await rm(dest, { recursive: true, force: true });
        await cp(dir, dest, { recursive: true });
      }
      await self.reload();
      const installed = self.list().find((p) => p.id === pack.id);
      if (!installed) throw new PackInstallError(`El pack "${pack.id}" quedó copiado en ${dest} pero no se pudo activar: revisa el error de arranque.`);
      return installed;
    },

    async remove(id) {
      const installed = candidates.filter((c) => c.origin === "installed" && c.id === id);
      if (installed.length === 0) {
        const bundled = candidates.some((c) => c.id === id);
        throw new PackInstallError(
          bundled ? `El pack "${id}" viene con la app: no se puede quitar.` : `El pack "${id}" no está instalado.`,
        );
      }
      for (const { dir } of installed) await rm(dir, { recursive: true, force: true });
      await self.reload();
      if (candidates.some((c) => c.id === id)) return;
      // Sin otra copia que lo reemplace, sus defs salen de `resolve`.
      for (const kind of [...PACKED_KINDS, "pack"] as const) {
        for (const def of defs.list(kind).filter((d) => d.scope === "pack" && d.source.startsWith(`pack:${id}@`))) {
          defs.archive(kind, def.id, "core");
        }
      }
      origins.delete(id);
    },

    packFor(scope) {
      for (const def of defs.list("pack")) {
        const pack = Pack.parse(def.body);
        if (covers(pack.activate, scope)) return { id: pack.id, ...SettingsOfPack.parse(pack) };
      }
      return { id: null, ...PackSettings.parse({}) };
    },
  };
  return self;
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

/** De cada id, la versión más alta; a igual versión gana el instalado. */
function winners(found: Candidate[]): Candidate[] {
  const best = new Map<string, Candidate>();
  for (const c of found) {
    const current = best.get(c.id);
    if (!current || c.version > current.version || (c.version === current.version && c.origin === "installed" && current.origin === "factory")) {
      best.set(c.id, c);
    }
  }
  return [...best.values()];
}

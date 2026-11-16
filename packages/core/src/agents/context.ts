import { readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { ContextPackage, type ContextSource, type RepoId } from "@clanker/api";
import type { Defs } from "../defs/defs";
import type { Packs } from "../packs/packs";
import type { ContextReference, NativeContext } from "./runtime";

/** El `~/.claude` del usuario (o `CLAUDE_CONFIG_DIR`): donde Claude Code busca sus skills, comandos y reglas. */
export function userConfigDir(env: Record<string, string | undefined> = process.env): string {
  return env.CLAUDE_CONFIG_DIR ?? join(env.HOME ?? homedir(), ".claude");
}

export interface ContextRequest {
  /** Slug del rol: con él se eligen las convenciones del pack para este rol. */
  role: string;
  sources: ContextSource[];
  /** El worktree: de él se leen los `repo:` y contra él se resuelven los `file:` relativos. */
  cwd: string;
  /** Con él se resuelven los paquetes con scope repo y el pack de la org del repo. */
  repoId?: RepoId;
}

export interface ResolvedContext {
  native?: NativeContext;
  references: ContextReference[];
  /** Fuentes que no se pudieron resolver: el agente corre igual, sin ellas. */
  warnings: string[];
}

export interface ContextResolver {
  /**
   * Resuelve las fuentes de un rol en cada lanzamiento, leyendo siempre el archivo original: nunca
   * una copia guardada, así una skill o regla editada vale desde el siguiente lanzamiento. Nada de
   * lo que falta lanza: queda en `warnings`.
   */
  resolve(request: ContextRequest): Promise<ResolvedContext>;
}

export interface ContextResolverOptions {
  defs: Defs;
  /** Sin él no hay `conventions.context`. */
  packs?: Packs;
  /** El `owner/name` de GitHub de un repo; su org elige el pack. */
  remoteOf?: (repoId: RepoId) => string | null | undefined;
  userDir?: string;
}

const NATIVE_SOURCES = ["user", "project"] as const;

/**
 * Las fuentes de un rol (`docs/design.html#contexto`) quedan en tres cosas: lo que Claude carga solo
 * (`native`, más cada `skill:` que existe), archivos para el prompt (`repo`, `file`, `rule:`, paquetes
 * de contexto y `conventions.context` del pack de la org) y avisos.
 */
export function createContextResolver({ defs, packs, remoteOf, userDir = userConfigDir() }: ContextResolverOptions): ContextResolver {
  defs.register("context", ContextPackage);

  async function resolveContext({ role, sources, cwd, repoId }: ContextRequest): Promise<ResolvedContext> {
    const warnings: string[] = [];
    const refs: string[] = [];
    let native: NativeContext | undefined;
    for (const source of sources) {
      if (source.kind === "native") native = mergeNative(native, source);
      else if (source.kind === "repo") refs.push(...source.files.map((file) => `repo:${file}`));
      else if (source.kind === "file") refs.push(`file:${source.path}`);
      else {
        const def = defs.resolve("context", source.id, { repoId });
        if (def) refs.push(...ContextPackage.parse(def.body).refs);
        else warnings.push(`El rol "${role}" pide el paquete de contexto "${source.id}" y no existe: corre sin él.`);
      }
    }
    refs.push(...conventionsFor(role, repoId));

    const references: ContextReference[] = [];
    const seen = new Set<string>();
    const skills: string[] = [];
    for (const ref of new Set(refs)) {
      const [type = "", value = ""] = splitRef(ref);
      if (type === "skill") {
        const found = await findSkill(value, cwd, native?.sources ?? NATIVE_SOURCES);
        if (found) skills.push(value);
        else warnings.push(`El rol "${role}" pide la skill "${value}" y no está en ${skillRoots(cwd, native?.sources ?? NATIVE_SOURCES).join(" ni en ")}: corre sin ella.`);
        continue;
      }
      const candidates: [string, ...string[]] = type === "rule" ? ruleFiles(value, cwd) : [pathOf(type, value, cwd)];
      const read = await readFirst(candidates);
      if (!read.ok) {
        warnings.push(`El rol "${role}" pide el contexto "${ref}" y no se pudo leer (${read.path}): ${read.reason}. Corre sin él.`);
      } else if (!seen.has(read.path)) {
        seen.add(read.path);
        references.push({ label: type === "rule" ? ref : value, content: read.content });
      }
    }

    if (skills.length > 0) native = withSkills(native, skills);
    return { ...(native && { native }), references, warnings };
  }

  /** `conventions.context` del pack de la org del repo: las de `*` y las del rol. */
  function conventionsFor(role: string, repoId: RepoId | undefined): string[] {
    const remote = repoId === undefined ? undefined : remoteOf?.(repoId);
    const githubOrg = remote?.split("/")[0];
    if (!packs || !githubOrg) return [];
    const context = packs.packFor({ githubOrg }).conventions.context ?? {};
    return [...(context["*"] ?? []), ...(context[role] ?? [])];
  }

  function skillRoots(cwd: string, sources: readonly ("user" | "project")[]): string[] {
    return sources.flatMap((s) => (s === "user" ? [userDir] : [join(cwd, ".claude")]));
  }

  /** Una skill (`skills/<nombre>/SKILL.md`) o un comando (`commands/<nombre>.md`) en el `~/.claude` o el `.claude` del repo. */
  async function findSkill(name: string, cwd: string, sources: readonly ("user" | "project")[]): Promise<boolean> {
    for (const root of skillRoots(cwd, sources)) {
      for (const file of [join(root, "skills", name, "SKILL.md"), join(root, "commands", `${name}.md`)]) {
        if (await isFile(file)) return true;
      }
    }
    return false;
  }

  /** Una regla del repo gana a la del usuario. */
  function ruleFiles(name: string, cwd: string): [string, string] {
    return [join(cwd, ".claude", "rules", `${name}.md`), join(userDir, "rules", `${name}.md`)];
  }

  function pathOf(type: string, value: string, cwd: string): string {
    if (type === "repo") return resolve(cwd, value);
    const expanded = value === "~" || value.startsWith("~/") ? join(homedir(), value.slice(1)) : value;
    return isAbsolute(expanded) ? expanded : resolve(cwd, expanded);
  }

  return { resolve: resolveContext };
}

/** Los tipos válidos ya los fijó `ContextRef` al guardar el rol, el paquete o el pack. */
function splitRef(ref: string): [string, string] {
  const colon = ref.indexOf(":");
  return [ref.slice(0, colon), ref.slice(colon + 1)];
}

function mergeNative(base: NativeContext | undefined, add: NativeContext): NativeContext {
  if (!base) return { sources: [...add.sources], skills: add.skills === "all" ? "all" : [...add.skills] };
  return {
    sources: [...new Set([...base.sources, ...add.sources])],
    skills: base.skills === "all" || add.skills === "all" ? "all" : [...new Set([...base.skills, ...add.skills])],
  };
}

/** Un rol sin fuente `native` que pide una skill la recibe con las sources por defecto. */
function withSkills(native: NativeContext | undefined, names: string[]): NativeContext {
  const base = native ?? { sources: [...NATIVE_SOURCES], skills: [] };
  return { ...base, skills: base.skills === "all" ? "all" : [...new Set([...base.skills, ...names])] };
}

type Read = { ok: true; path: string; content: string } | { ok: false; path: string; reason: string };

/** El primer archivo que se pueda leer; si ninguno, se nombran todas las rutas probadas y el motivo de la primera. */
async function readFirst(paths: [string, ...string[]]): Promise<Read> {
  let firstReason: string | undefined;
  for (const path of paths) {
    try {
      return { ok: true, path, content: await readFile(path, "utf8") };
    } catch (error) {
      firstReason ??= (error as NodeJS.ErrnoException).code === "ENOENT" ? "no existe" : (error as Error).message;
    }
  }
  return { ok: false, path: paths.join(" ni "), reason: firstReason ?? "no existe" };
}

async function isFile(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isFile();
  } catch {
    return false;
  }
}

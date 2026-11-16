import type { DefWriteKind, FlowDef, RepoConfigSync } from "@clanker/api";
import { git, GitError, tryGit } from "../git/git";
import { canonicalJson, DefValidationError, type Defs } from "../defs/defs";
import type { Flows } from "../flows/flows";
import type { ErrorReporter } from "../errors/reporter";
import type { Repos } from "../repos/repos";
import { RepoNotFoundError } from "../repos/repos";
import { parseRepoConfigPath, parseRepoFile, REPO_CONFIG_DIRS, RepoFileSyntaxError } from "./files";
import { issuesInline } from "../errors/format";

export interface RepoConfigSyncer {
  /**
   * Carga `.clanker/flows/*.json`, `roles/*.md` y `profiles/*.json` de la branch por defecto del repo
   * (`origin/<default>`, o la local si el checkout no tiene remoto) como defs con scope `repo`, con source
   * `repo:<archivo>@<commit>`. Un archivo inválido no se guarda ni toca lo que ya había (sale en `errors`
   * con su ruta); una def cuyo archivo desapareció se archiva (y se restaura si el archivo vuelve con otro
   * contenido). Lo que una persona editó o archivó en la app sobrevive hasta que el archivo cambia. Roles primero, luego
   * perfiles y flujos: un flujo puede citar un rol del mismo repo. Lanza `RepoNotFoundError`.
   */
  sync(repoId: string): Promise<RepoConfigSync>;
}

export function createRepoConfigSyncer({ defs, flows, repos }: { defs: Defs; flows: Pick<Flows, "validate" | "save">; repos: Repos }): RepoConfigSyncer {
  /** Los archivos de `.clanker/` de la punta por defecto; uno que git no pudo leer queda con su `GitError`, sin borrar su def. */
  async function readTree(repoId: string): Promise<{ commit: string; files: Map<string, string | GitError> } | undefined> {
    const repo = repos.get(repoId);
    if (!repo) throw new RepoNotFoundError(repoId);
    let commit: string | undefined;
    for (const ref of [`refs/remotes/origin/${repo.defaultBranch}`, `refs/heads/${repo.defaultBranch}`]) {
      commit = await tryGit(repo.path, ["rev-parse", "--verify", "--quiet", `${ref}^{commit}`]);
      if (commit) break;
    }
    // Sin la branch por defecto (un repo recién creado) no hay nada que leer, y tampoco que archivar.
    if (!commit) return undefined;
    const listed = await git(repo.path, ["ls-tree", "-r", "--name-only", "-z", commit, "--", ...REPO_CONFIG_DIRS]);
    const files = new Map<string, string | GitError>();
    for (const path of listed.split("\0").filter(Boolean)) {
      if (!parseRepoConfigPath(path)) continue;
      try {
        files.set(path, await git(repo.path, ["show", `${commit}:${path}`]));
      } catch (error) {
        if (!(error instanceof GitError)) throw error;
        files.set(path, error);
      }
    }
    return { commit, files };
  }

  return {
    async sync(repoId) {
      const result: RepoConfigSync = { loaded: 0, archived: 0, errors: [] };
      let tree: Awaited<ReturnType<typeof readTree>>;
      try {
        tree = await readTree(repoId);
      } catch (error) {
        // Un git que falla al leer no es un archivo malo, pero tampoco debe tumbar a quien registra el repo: sale como error de la carga.
        if (!(error instanceof GitError)) throw error;
        return { ...result, errors: [{ file: ".clanker", message: error.message }] };
      }
      if (!tree) return result;
      const source = (path: string) => `repo:${path}@${tree.commit.slice(0, 12)}`;
      const fileOf = (kind: DefWriteKind, slug: string) => [...tree.files.keys()].find((path) => {
        const parsed = parseRepoConfigPath(path);
        return parsed?.kind === kind && parsed.slug === slug;
      });
      const ownDefs = (kind: DefWriteKind) =>
        defs.list(kind, { includeArchived: true }).filter((d) => d.scope === "repo" && d.repoId === repoId && d.source.startsWith("repo:"));

      // Lo que ya no tiene archivo.
      for (const kind of ["role", "profile", "flow"] as const) {
        for (const def of ownDefs(kind)) {
          if (def.archivedAt === null && fileOf(kind, def.slug) === undefined) {
            defs.archive(kind, def.id, "core");
            result.archived++;
          }
        }
      }

      const order = { role: 0, profile: 1, flow: 2 } as const;
      const paths = [...tree.files.keys()].sort((a, b) => order[parseRepoConfigPath(a)!.kind] - order[parseRepoConfigPath(b)!.kind] || a.localeCompare(b));
      for (const path of paths) {
        const { kind, slug } = parseRepoConfigPath(path)!;
        const fail = (message: string) => result.errors.push({ file: path, message });
        const content = tree.files.get(path)!;
        if (content instanceof GitError) {
          fail(`git no pudo leer el archivo: ${content.message}`);
          continue;
        }
        let parsed: unknown;
        try {
          parsed = defs.validate(kind, slug, parseRepoFile(kind, content));
        } catch (error) {
          if (error instanceof RepoFileSyntaxError) fail(error.message);
          else if (error instanceof DefValidationError) fail(issuesInline(error.issues));
          else throw error;
          continue;
        }
        if (kind === "flow") {
          const { errors } = flows.validate(parsed, { repoId });
          if ((parsed as { id: string }).id !== slug) errors.push({ path: "id", message: `el id del flujo es "${(parsed as { id: string }).id}" y debe ser el nombre del archivo ("${slug}")` });
          if (errors.length > 0) {
            fail(issuesInline(errors));
            continue;
          }
        }
        const existing = ownDefs(kind).find((d) => d.slug === slug);
        // El archivo no cambió desde la última carga: lo que quedó en la app (una edición, un archivado) no se pisa.
        if (existing && unchangedSinceLastSync(defs, kind, existing.id, parsed)) continue;
        if (existing && existing.archivedAt !== null) defs.restore(kind, existing.id, "core");
        const saved =
          kind === "flow"
            ? flows.save(parsed as FlowDef, { scope: "repo", repoId, source: source(path) })
            : defs.save({ kind, slug, scope: "repo", repoId, body: parsed, source: source(path) });
        if (saved.changed) result.loaded++;
      }
      return result;
    },
  };
}

/** El body de la última versión que vino de un archivo es el de este archivo: no hay nada nuevo que cargar. */
function unchangedSinceLastSync(defs: Defs, kind: DefWriteKind, id: string, parsed: unknown): boolean {
  const last = defs.versions(kind, id).find((v) => v.source.startsWith("repo:"));
  return last !== undefined && canonicalJson(defs.get(kind, id, last.version)?.body) === canonicalJson(parsed);
}

/** Cada cuánto se relee `.clanker/` de los repos registrados: Watch trae `origin/<default>` y esto lo carga. */
export const REPO_CONFIG_SYNC_EVERY_MS = 5 * 60 * 1000;

/**
 * Carga `.clanker/` de todos los repos registrados al arrancar y cada `everyMs`. Nunca lanza: lo que falla se anota
 * una vez por repo con `errors` (un archivo inválido es un error del repo, no del core).
 */
export function startRepoConfigSync({ syncer, repos, errors, everyMs = REPO_CONFIG_SYNC_EVERY_MS }: { syncer: RepoConfigSyncer; repos: Pick<Repos, "list">; errors: ErrorReporter; everyMs?: number }): { stop(): Promise<void> } {
  let running: Promise<void> = Promise.resolve();
  let stopped = false;

  function pass(): void {
    if (stopped) return;
    running = running.then(async () => {
      for (const repo of repos.list()) {
        const scope = `repo-config.${repo.name}`;
        try {
          const { errors: bad } = await syncer.sync(repo.id);
          if (bad.length > 0) errors.report(scope, new Error(bad.map((e) => `${e.file}: ${e.message}`).join("\n")));
          else errors.clear(scope);
        } catch (error) {
          errors.report(scope, error);
        }
      }
    });
  }

  const timer = setInterval(pass, everyMs);
  timer.unref();
  pass();
  return {
    async stop() {
      stopped = true;
      clearInterval(timer);
      await running;
    },
  };
}

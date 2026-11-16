import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { DefExported, DefExportToRepo } from "@clanker/api";
import { RequestError } from "@octokit/request-error";
import * as z from "zod";
import type { Connections } from "../connections/connections";
import type { Defs } from "../defs/defs";
import { DefNotFoundError } from "../defs/write";
import { git } from "../git/git";
import type { GitRemote } from "../git/remote";
import type { Repos } from "../workspaces/repos";
import { RepoNotFoundError } from "../workspaces/repos";
import { repoConfigPath, renderRepoFile } from "./files";

/** No se puede exportar: el mensaje dice por qué y qué hacer. */
export class RepoExportError extends Error {}

export interface RepoConfigExporter {
  /**
   * Abre un PR en draft que agrega (o actualiza) el archivo de la def en `.clanker/` del repo. El archivo se
   * escribe en un worktree desechable sobre `origin/<default>` (recién traído), se commitea, se pushea a una
   * branch nueva `clanker/export-<kind>-<slug>-<n>` con la cuenta de GitHub del repo y el PR sale con esa
   * misma cuenta, como el de `pr.publish`. El checkout del usuario no se toca. Lanza `RepoExportError`,
   * `DefNotFoundError` o `RepoNotFoundError`.
   */
  exportDef(input: DefExportToRepo): Promise<DefExported>;
}

export interface RepoConfigExporterDeps {
  defs: Defs;
  repos: Repos;
  /** La config del repo (remoto y cuenta), la misma que usa Workspaces. */
  config: Repos["config"];
  remote: GitRemote;
  connections: Pick<Connections, "githubClient" | "markRevoked">;
  /** Los worktrees desechables viven en `<dataDir>/repo-config-export`. */
  dataDir: string;
  identity: { name: string; email: string };
}

const Pull = z.object({ number: z.int().positive(), html_url: z.string() });

export function createRepoConfigExporter({ defs, repos, config, remote, connections, dataDir, identity }: RepoConfigExporterDeps): RepoConfigExporter {
  const authorship = {
    GIT_AUTHOR_NAME: identity.name,
    GIT_AUTHOR_EMAIL: identity.email,
    GIT_COMMITTER_NAME: identity.name,
    GIT_COMMITTER_EMAIL: identity.email,
  };
  // Sin hooks: `pre-commit` y compañía son del repo del usuario, no de este commit.
  const NO_HOOKS = ["-c", "core.hooksPath=/dev/null"];

  return {
    async exportDef({ kind, id, repoId }) {
      const def = defs.get(kind, id);
      if (!def) throw new DefNotFoundError(kind, id);
      if (def.scope !== "user") {
        throw new RepoExportError(`${kind} "${def.slug}" es ${def.scope === "repo" ? "del repo" : "de la app"}: solo se exporta lo tuyo. Duplícalo para tener uno propio.`);
      }
      if (def.archivedAt !== null) throw new RepoExportError(`${kind} "${def.slug}" está archivado: restáuralo antes de exportarlo.`);
      const repo = repos.get(repoId);
      if (!repo) throw new RepoNotFoundError(repoId);
      const target = config(repoId).remote;
      if (!target) {
        throw new RepoExportError(`${repo.name} no tiene remoto de GitHub con una cuenta conectada: conecta GitHub en Conexiones para abrir el PR.`);
      }
      const [owner = "", name = ""] = target.repo.split("/");
      const remoteTarget = { cwd: repo.path, url: target.url, account: target.account };
      if ((await remote.fetch(remoteTarget)) === "unauthorized") {
        throw new RepoExportError(`GitHub rechazó el token de ${target.account}: reconecta la cuenta para exportar.`);
      }
      const base = `refs/remotes/origin/${repo.defaultBranch}`;

      const path = repoConfigPath(kind, def.slug);
      const content = renderRepoFile(kind, def.body);
      const scratchRoot = join(dataDir, "repo-config-export");
      mkdirSync(scratchRoot, { recursive: true });
      const scratch = mkdtempSync(join(scratchRoot, "x-"));
      const worktree = join(scratch, "worktree");
      let added = false;
      try {
        await git(repo.path, [...NO_HOOKS, "worktree", "add", "--detach", worktree, base]).catch((error: unknown) => {
          throw new RepoExportError(`No pude leer ${repo.defaultBranch} de ${repo.name} en el remoto: ${error instanceof Error ? error.message : String(error)}`);
        });
        added = true;
        const file = join(worktree, path);
        const existed = await git(worktree, ["cat-file", "-e", `HEAD:${path}`]).then(() => true, () => false);
        if (existed && readFileSync(file, "utf8") === content) {
          throw new RepoExportError(`${path} ya está igual en ${repo.defaultBranch} de ${repo.name}: no hay nada que exportar.`);
        }
        mkdirSync(dirname(file), { recursive: true });
        writeFileSync(file, content);
        await git(worktree, ["add", "--", path]);
        const verb = existed ? "actualizar" : "agregar";
        const title = `feat: ${verb} ${KIND_NAME[kind]} ${def.slug} en .clanker`;
        await git(worktree, [...NO_HOOKS, "commit", "--no-gpg-sign", "-m", title], authorship);
        const sha = await git(worktree, ["rev-parse", "HEAD"]);
        const branch = `clanker/export-${kind}-${def.slug}-${sha.slice(0, 7)}`;

        const pushed = await remote.push({ ...remoteTarget, cwd: worktree, branch, sha, expectedRemoteSha: null });
        if (pushed === "unauthorized") throw new RepoExportError(`GitHub rechazó el token de ${target.account}: reconecta la cuenta para exportar.`);
        if (pushed === "lease-rejected") throw new RepoExportError(`La branch ${branch} ya existe en el remoto con otro contenido: bórrala o exporta de nuevo.`);

        try {
          const { data } = await connections.githubClient(target.account).request("POST /repos/{owner}/{repo}/pulls", {
            owner,
            repo: name,
            title,
            head: branch,
            base: repo.defaultBranch,
            draft: true,
            body: prBody({ kind, slug: def.slug, path, verb }),
          });
          const pull = Pull.parse(data);
          return { url: pull.html_url, number: pull.number, branch, path };
        } catch (error) {
          if (error instanceof RequestError && error.status === 401) connections.markRevoked("github", target.account, "core");
          throw error;
        }
      } finally {
        if (added) await git(repo.path, ["worktree", "remove", "--force", worktree]).catch(() => undefined);
        rmSync(scratch, { recursive: true, force: true });
      }
    },
  };
}

const KIND_NAME = { flow: "el flujo", role: "el rol", profile: "el perfil" } as const;

function prBody({ kind, slug, path, verb }: { kind: keyof typeof KIND_NAME; slug: string; path: string; verb: string }): string {
  return [
    `Este PR ${verb === "agregar" ? "agrega" : "actualiza"} \`${path}\`: ${KIND_NAME[kind]} \`${slug}\`, exportado desde Clanker Yard.`,
    "",
    "`.clanker/` es la configuración que viaja con el repo: cualquiera que lo registre en Clanker Yard la recibe. Al mergear este PR, la definición queda disponible para quien use este repo.",
    "",
    `Para probarlo: revisa el contenido de \`${path}\` y, ya mergeado, registra el repo en otra máquina (o corre "Sincronizar" en la app) y busca \`${slug}\` en Flujos como definición del repo.`,
  ].join("\n");
}

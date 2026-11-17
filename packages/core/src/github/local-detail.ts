import { LOCAL_PR_PATCH_MAX, type LocalPrCommit, type LocalPrDetail, type LocalPrFile, type RepoId } from "@clanker/api";
import { BadRequestError, NotFoundError } from "../errors/domain";
import { git, gitRaw, tryGit } from "../git/git";
import type { RepoConfig } from "../repos/repos";
import type { Store } from "../store/store";
import { prById } from "./pr-rows";

// `prs.localDetail` (stacks locales): un PR local no está en GitHub, así que su descripción, sus commits y su diff se
// leen de la fila y del repo en cada pedido.

export interface LocalPrDetails {
  get(id: string): Promise<LocalPrDetail>;
}

/** Separa los campos y los commits de `git log`: no aparecen en un mensaje de commit. */
const FIELD = "\x1f";
const RECORD = "\x1e";

/**
 * El detalle de un PR local: título y cuerpo de la fila, los commits de `base..branch` (sin los merges de la base) y el
 * diff desde el punto donde la branch sale de su base (`git diff base...branch`, lo que muestra GitHub). La base es
 * `origin/<base>` si existe (la de un padre publicado) y si no la branch local (un padre que también es local).
 */
export function createLocalPrDetails({ store, repoConfig }: { store: Store; repoConfig: (repoId: RepoId) => RepoConfig }): LocalPrDetails {
  return {
    async get(id) {
      const row = prById(store.db, id);
      if (!row) throw new NotFoundError(`No existe el PR ${id}.`);
      if (row.state !== "local") throw new BadRequestError(`${row.headRef} ya no es un PR local: míralo en GitHub.`);
      const { path, remote } = repoConfig(row.repoId);
      const branch = `refs/heads/${row.headRef}`;
      if ((await tryGit(path, ["rev-parse", "--verify", "--quiet", branch])) === undefined) {
        throw new BadRequestError(`La branch ${row.headRef} ya no está en ${path}: no hay commits que mostrar.`);
      }
      const base =
        (await tryGit(path, ["rev-parse", "--verify", "--quiet", `refs/remotes/origin/${row.baseRef}`])) ??
        (await tryGit(path, ["rev-parse", "--verify", "--quiet", `refs/heads/${row.baseRef}`]));
      if (base === undefined) throw new BadRequestError(`La base ${row.baseRef} de ${row.headRef} no está en ${path}.`);
      const from = await git(path, ["merge-base", base, branch]);

      const log = await gitRaw(path, ["log", "--reverse", "--no-merges", `--format=%H${FIELD}%s${FIELD}%b${FIELD}%an${FIELD}%aI${RECORD}`, `${from}..${branch}`]);
      const commits: LocalPrCommit[] = log
        .split(RECORD)
        .map((record) => record.replace(/^\n/, ""))
        .filter((record) => record.length > 0)
        .map((record) => {
          const [sha = "", subject = "", body = "", author = "", date = ""] = record.split(FIELD);
          return { sha, subject, body: body.trim(), author, date };
        });

      const files: LocalPrFile[] = (await gitRaw(path, ["diff", "--numstat", "-z", "--no-renames", from, branch]))
        .split("\0")
        .filter((line) => line.length > 0)
        .map((line) => {
          const [additions = "-", deletions = "-", ...rest] = line.split("\t");
          return { path: rest.join("\t"), additions: additions === "-" ? null : Number(additions), deletions: deletions === "-" ? null : Number(deletions) };
        });
      const patch = await gitRaw(path, ["diff", "--no-color", "--no-renames", from, branch]);

      return {
        id: row.id,
        repo: remote?.repo ?? row.repoId,
        branch: row.headRef,
        base: row.baseRef,
        title: row.title ?? row.headRef,
        body: row.body ?? "",
        head: await git(path, ["rev-parse", branch]),
        commits,
        files,
        patch: patch.slice(0, LOCAL_PR_PATCH_MAX),
        truncated: patch.length > LOCAL_PR_PATCH_MAX,
      };
    },
  };
}

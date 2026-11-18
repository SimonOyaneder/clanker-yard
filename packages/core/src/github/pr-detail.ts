import { LOCAL_PR_PATCH_MAX, type PrCommitDiff, type LocalPrCommit, type PrDetail, type LocalPrFile, type RepoId } from "@clanker/api";
import { RequestError } from "@octokit/request-error";
import { z } from "zod";
import type { Connections } from "../connections/connections";
import { BadRequestError, NotFoundError } from "../errors/domain";
import { git, gitRaw, tryGit } from "../git/git";
import type { FetchOutcome } from "../git/remote";
import type { RepoConfig } from "../repos/repos";
import type { Store } from "../store/store";
import type { Workspaces } from "../workspaces/workspaces";
import { isUnauthorized } from "./client";
import { prById } from "./pr-rows";

export interface PrDetails {
  get(id: string): Promise<PrDetail>;
  /** El diff de un commit del PR contra su padre; rechaza un commit que no es de los del PR. */
  commit(id: string, sha: string, range?: { head: string; base: string }): Promise<PrCommitDiff>;
}

/** Separa los campos y los commits de `git log`: no aparecen en un mensaje de commit. */
const FIELD = "\x1f";
const RECORD = "\x1e";
const tip = z.object({ ref: z.string(), sha: z.string() });
const metadata = z.object({ title: z.string(), body: z.string().nullable(), head: tip, base: tip });

/**
 * El detalle de un PR: descripción de la fila local o de GitHub, commits propios y diff desde el merge-base,
 * fijados por SHA. Una branch local divergida nunca sustituye la punta publicada.
 */
export function createPrDetails({ store, repoConfig, connections, workspaces }: {
  store: Store;
  repoConfig: (repoId: RepoId) => RepoConfig;
  connections: Pick<Connections, "githubClient">;
  workspaces: Pick<Workspaces, "fetch" | "fetchPr">;
}): PrDetails {
  /** La fila, el repo y desde dónde salen los commits propios del PR (el merge-base con su base). */
  async function locate(id: string) {
    const row = prById(store.db, id);
    if (!row) throw new NotFoundError(`No existe el PR ${id}.`);
    const { path, remote } = repoConfig(row.repoId);
    let branch = row.headRef;
    let base = row.baseRef;
    let title = row.title ?? row.headRef;
    let body = row.body ?? "";
    let head: string;
    let baseSha: string;
    if (row.state === "local") {
      const localHead = await tryGit(path, ["rev-parse", "--verify", "--quiet", `refs/heads/${branch}^{commit}`]);
      if (!localHead) throw new BadRequestError(`La branch ${branch} ya no está en ${path}: restáurala para ver el detalle.`);
      const localBase =
        (await tryGit(path, ["rev-parse", "--verify", "--quiet", `refs/remotes/origin/${base}^{commit}`])) ??
        (await tryGit(path, ["rev-parse", "--verify", "--quiet", `refs/heads/${base}^{commit}`]));
      if (!localBase) throw new BadRequestError(`La base ${base} de ${branch} no está en ${path}: restáurala para ver el detalle.`);
      head = localHead;
      baseSha = localBase;
    } else {
      if (!remote) throw new BadRequestError("Reconecta GitHub para leer el detalle de este PR, o ábrelo en GitHub.");
      const number = row.number!;
      const [owner, name] = remote.repo.split("/") as [string, string];
      const response = await connections.githubClient(remote.account).request("GET /repos/{owner}/{repo}/pulls/{pull_number}", {
        owner, repo: name, pull_number: number,
      });
      const pull = metadata.parse(response.data);
      title = pull.title;
      body = pull.body ?? "";
      branch = pull.head.ref;
      head = pull.head.sha;
      base = pull.base.ref;
      baseSha = pull.base.sha;
      const exists = (sha: string) => tryGit(path, ["cat-file", "-e", `${sha}^{commit}`]).then((result) => result !== undefined);
      const checkAuthorization = (outcome: FetchOutcome) => {
        if (outcome === "unauthorized") throw new BadRequestError("Reconecta GitHub para traer los commits de este PR.");
      };
      if (!(await exists(head)) || !(await exists(baseSha))) checkAuthorization(await workspaces.fetch(row.repoId));
      if (!(await exists(head))) checkAuthorization(await workspaces.fetchPr(row.repoId, number));
      if (!(await exists(head)) || !(await exists(baseSha))) {
        throw new BadRequestError("No se encontraron los commits del PR tras traer el remoto: actualiza el detalle o ábrelo en GitHub.");
      }
    }
    return { row, path, remote, branch, base, title, body, head, baseSha, from: await git(path, ["merge-base", baseSha, head]) };
  }

  async function reading<T>(fn: () => Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch (error) {
      if (error instanceof NotFoundError || error instanceof BadRequestError) throw error;
      if (isUnauthorized(error)) throw new BadRequestError("Reconecta GitHub para leer el detalle de este PR.");
      if (error instanceof RequestError && error.status === 404) {
        throw new NotFoundError("El PR no existe en GitHub o tu cuenta no tiene acceso: revisa la conexión o ábrelo en GitHub.");
      }
      throw new BadRequestError("No se pudo leer el detalle del PR: vuelve a intentarlo o ábrelo en GitHub.");
    }
  }

  async function commitsOf(path: string, from: string, branch: string): Promise<LocalPrCommit[]> {
    const log = await gitRaw(path, ["log", "--reverse", "--no-merges", `--format=%H${FIELD}%s${FIELD}%b${FIELD}%an${FIELD}%aI${RECORD}`, `${from}..${branch}`]);
    return log
      .split(RECORD)
      .map((record) => record.replace(/^\n/, ""))
      .filter((record) => record.length > 0)
      .map((record) => {
        const [sha = "", subject = "", body = "", author = "", date = ""] = record.split(FIELD);
        return { sha, subject, body: body.trim(), author, date };
      });
  }

  /** Los archivos y el patch de `from..to`, cortado en `LOCAL_PR_PATCH_MAX`. */
  async function diffOf(path: string, from: string, to: string) {
    const files: LocalPrFile[] = (await gitRaw(path, ["diff", "--numstat", "-z", "--no-renames", from, to]))
      .split("\0")
      .filter((line) => line.length > 0)
      .map((line) => {
        const [additions = "-", deletions = "-", ...rest] = line.split("\t");
        return { path: rest.join("\t"), additions: additions === "-" ? null : Number(additions), deletions: deletions === "-" ? null : Number(deletions) };
      });
    const patch = await gitRaw(path, ["diff", "--no-color", "--no-renames", from, to]);
    return { files, patch: patch.slice(0, LOCAL_PR_PATCH_MAX), truncated: patch.length > LOCAL_PR_PATCH_MAX };
  }

  return {
    async get(id) {
      return reading(async () => {
        const { row, path, remote, branch, base, title, body, head, baseSha, from } = await locate(id);
        return {
          id: row.id,
          repo: remote?.repo ?? row.repoId,
          branch,
          base,
          title,
          body,
          head,
          baseSha,
          commits: await commitsOf(path, from, head),
          ...(await diffOf(path, from, head)),
        };
      });
    },

    async commit(id, sha, range) {
      return reading(async () => {
        const { path, from, head, baseSha, branch } = await locate(id);
        if (range && (range.head !== head || range.base !== baseSha)) {
          throw new BadRequestError("El PR cambió desde que abriste el detalle: actualízalo antes de ver el commit.");
        }
        const commit = (await commitsOf(path, from, head)).find((c) => c.sha.startsWith(sha));
        if (!commit) throw new BadRequestError(`El commit ${sha.slice(0, 9)} no es de ${branch}.`);
        return { sha: commit.sha, ...(await diffOf(path, `${commit.sha}^`, commit.sha)) };
      });
    },
  };
}

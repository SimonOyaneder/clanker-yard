import { parseArgs } from "node:util";
import { RepoRemote, type LocalCommitDiff, type LocalPrDetail } from "@clanker/api";
import type { Command } from "./command";
import { formatTable } from "./format";

function localId(positionals: string[], usage: string): string {
  const [id, ...extra] = positionals;
  if (!id?.trim() || extra.length > 0) throw new Error(`Indica un solo id de PR local.\nUso: ${usage}`);
  return id;
}

function formatDiff({ files, patch, truncated }: Pick<LocalCommitDiff, "files" | "patch" | "truncated">): string {
  const rows = files.map((file) => [file.path, file.additions === null ? "-" : `+${file.additions}`, file.deletions === null ? "-" : `-${file.deletions}`]);
  return [
    "Archivos:",
    rows.length ? formatTable([["Ruta", "Adiciones", "Eliminaciones"], ...rows], 1) : "(Sin archivos)",
    "",
    "Patch:",
    patch || "(Sin cambios)",
    ...(truncated ? ["[Patch truncado]"] : []),
  ].join("\n");
}

function formatDetail(pr: LocalPrDetail): string {
  return [
    `PR local: ${pr.id} (${pr.repo})`,
    `Rama: ${pr.branch} → ${pr.base}`,
    `HEAD: ${pr.head}`,
    `Título: ${pr.title}`,
    "",
    "Descripción:",
    pr.body || "(Sin descripción)",
    "",
    "Commits:",
    ...(pr.commits.length ? pr.commits.map((commit) => `${commit.sha} ${commit.subject}`) : ["(Sin commits)"]),
    "",
    formatDiff(pr),
  ].join("\n");
}

export const prsListLocal: Command = {
  usage: "clanker prs list-local [--repo <owner/repo>] [--json]",
  async run(args, ctx) {
    const { values } = parseArgs({ args, options: { repo: { type: "string" }, json: { type: "boolean" } } });
    if (values.repo !== undefined && !RepoRemote.safeParse(values.repo).success) {
      throw new Error(`--repo pide un repo en formato owner/repo.\nUso: ${prsListLocal.usage}`);
    }

    const prs = await (await ctx.client()).prs.list({ state: "local", repo: values.repo });
    if (values.json) return ctx.write(JSON.stringify(prs, null, 2));
    const rows = prs.flatMap(({ id, repo, local }) => local ? [[id, repo, local.branch, local.base, local.title]] : []);
    if (!rows.length) return ctx.write("No hay PRs locales.");
    ctx.write(formatTable([["Id", "Repo", "Rama", "Base", "Título"], ...rows]));
  },
};

export const prsShowLocal: Command = {
  usage: "clanker prs show-local <id> [--commit <sha>] [--json]",
  async run(args, ctx) {
    const { values, positionals } = parseArgs({
      args, allowPositionals: true, options: { commit: { type: "string" }, json: { type: "boolean" } },
    });
    const id = localId(positionals, prsShowLocal.usage);
    const sha = values.commit;
    if (sha !== undefined && !/^[0-9a-f]{7,40}$/.test(sha)) {
      throw new Error(`--commit pide un SHA de 7 a 40 caracteres hexadecimales en minúsculas.\nUso: ${prsShowLocal.usage}`);
    }

    const client = await ctx.client();
    if (sha !== undefined) {
      const diff = await client.prs.localCommitDiff({ id, sha });
      return ctx.write(values.json ? JSON.stringify(diff, null, 2) : `Commit: ${diff.sha}\n\n${formatDiff(diff)}`);
    }
    const pr = await client.prs.localDetail({ id });
    ctx.write(values.json ? JSON.stringify(pr, null, 2) : formatDetail(pr));
  },
};

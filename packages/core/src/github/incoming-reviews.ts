import { mkdirSync, existsSync } from "node:fs";
import { readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { homedir } from "node:os";
import { setTimeout as delay } from "node:timers/promises";
import { ArtifactHash, type RunId } from "@clanker/api";
import { and, desc, eq } from "drizzle-orm";
import { z } from "zod";
import type { Connections } from "../connections/connections";
import { PermanentActionError, type ActionDef } from "../flows/catalog";
import type { Engine, StepBriefRequest } from "../flows/engine";
import { git, gitRaw, tryGit } from "../git/git";
import { githubUnauthorized } from "../breakers/breakers";
import type { Repos } from "../repos/repos";
import { artifactRefs, incomingReviews as requests } from "../store/schema";
import type { Artifacts } from "../artifacts/artifacts";
import type { Store } from "../store/store";
import type { Workspaces } from "../workspaces/workspaces";
import { ADD_FINDING, CREATE_DRAFT, currentRequest, searchRequested } from "./incoming-api";
import { Findings } from "./incoming-template";
import { cleanMessage } from "../commits/apply";
import { councilReferences, manualReviews } from "./incoming-context";

type Row = typeof requests.$inferSelect;
const Empty = z.object({});
const DELAY = 5 * 60_000;
const DraftInput = z.object({ findings: z.union([Findings.shape.findings, z.object({ artifact: ArtifactHash })]) });
const Report = Findings.extend({ number: z.number(), head: z.string(), branch: z.string(), baseBranch: z.string(), issue: z.string().nullable() });
const areas = {
  bugs: "correctitud, seguridad, integridad de datos y concurrencia",
  patterns: "diseño, alcance y consistencia con el código vecino",
  ops: "volumen, operación, datos, observabilidad y orden de deploy",
  lore: "convenciones documentadas del equipo; cita la regla y dónde aplica",
  tests: "cobertura del comportamiento, costo y patrones de specs",
  framework: "contratos del framework y compatibilidad de las versiones instaladas",
};

export function createIncomingReviews({ store, connections, repos, workspaces, dataDir, enabled, references: configured, artifacts, prefix, reportsDir }: {
  store: Store; connections: Pick<Connections, "githubClient">; repos: Pick<Repos, "byRemote" | "config">;
  workspaces: Pick<Workspaces, "fetch" | "fetchPr">; dataDir: string; enabled: string[];
  references?: string;
  reportsDir?: string;
  artifacts: Pick<Artifacts, "put" | "ref" | "get">;
  prefix?: (repo: string) => string;
}) {
  const references = councilReferences(configured);
  const byRun = (id: RunId) => store.db.select().from(requests).where(eq(requests.runId, id)).get();
  const dir = (id: RunId) => join(dataDir, "incoming-reviews", id);

  async function poll(account: string, at: number, flows: Pick<Engine, "start">,
    attempt: (scope: string, work: () => Promise<void>) => Promise<void> = (_, work) => work(),
    stopping: () => boolean = () => false) {
    const client = connections.githubClient(account);
    for (const name of enabled) {
      const repo = repos.byRemote(name);
      if (!repo || repos.config(repo.id).remote?.account !== account) continue;
      const repoId = repo.id;
      async function observe(number: number) {
        const current = await currentRequest(client, name, number);
        if (!current || stopping() || !enabled.includes(name)) return;
        const { requestId } = current;
        store.tx((tx) => {
          tx.db.insert(requests).values({ requestId, number, repoId, account, dueAt: at + DELAY, draftId: current.draft }).onConflictDoNothing().run();
          const row = tx.db.select().from(requests).where(eq(requests.requestId, requestId)).get()!;
          if (row.account !== account || row.runId || row.dueAt > at || (row.draftId && row.draftId !== current.draft)) return;
          const runId = flows.start("incoming-review", { type: "pr", id: `${name}#${number}:${requestId}` }, {}, { by: "watch", profile: "incoming-medio", tx });
          tx.db.update(requests).set({ runId, draftId: current.draft }).where(eq(requests.requestId, requestId)).run();
        });
      }
      await attempt(`${account} ${name} review requests`, async () => {
        for (let page = 1; !stopping(); page++) {
          const result = await searchRequested(client, store, account, name, page);
          for (const number of result.numbers) {
            if (stopping()) return;
            await attempt(`${account} ${name}#${number} assignment`, () => observe(number));
          }
          if (!result.more) break;
        }
      });
    }
  }

  async function live(runId: RunId) {
    const row = byRun(runId);
    if (!row) throw new PermanentActionError("La corrida no nació de una solicitud de review.");
    const { path, remote } = repos.config(row.repoId);
    if (!remote || !enabled.includes(remote.repo) || remote.account !== row.account) return;
    const client = connections.githubClient(row.account);
    const current = await currentRequest(client, remote.repo, row.number);
    if (current?.requestId !== row.requestId || (row.draftId && row.draftId !== current.draft)) return;
    return { row, client, path, name: remote.repo, ...current };
  }
  const save = (row: Row, changes: Partial<Row>) => store.tx((tx) =>
    tx.db.update(requests).set(changes).where(eq(requests.requestId, row.requestId)).run());

  async function removeSource(path: string, root: string) {
    if (existsSync(join(root, "source"))) await git(path, ["-c", "core.hooksPath=/dev/null", "worktree", "remove", "--force", join(root, "source")]);
  }

  async function rubric(area: string) {
    if (!references) return "";
    // lore se resuelve con el paquete de contexto del equipo.
    if (area === "lore") return "";
    return readFile(join(references, `${area}.md`), "utf8");
  }
  const issueOf = (title: string, branch: string) => /\b[a-z]+-\d+/i.exec(`${title} ${branch}`)?.[0].toUpperCase() ?? null;
  function previous(row: Row, branch: string, baseBranch: string, issue: string | null) {
    const refs = store.db.select({ hash: artifactRefs.hash }).from(requests)
      .innerJoin(artifactRefs, eq(artifactRefs.ownerId, requests.runId))
      .where(and(eq(requests.repoId, row.repoId), eq(requests.account, row.account), eq(artifactRefs.ownerType, "run"), eq(artifactRefs.role, "incoming.report")))
      .orderBy(desc(requests.dueAt)).all();
    const found = new Map<number, z.infer<typeof Report>>();
    for (const { hash } of refs) {
      const report = Report.parse(JSON.parse(new TextDecoder().decode(artifacts.get(hash)?.content)));
      if (!found.has(report.number) && (row.number === report.number || ((report.branch === baseBranch || report.baseBranch === branch || (issue && issue === report.issue)) && found.size < 5))) {
        found.set(report.number, report);
      }
    }
    return [...found.values()];
  }

  const snapshot: ActionDef<typeof Empty> = {
    name: "incoming.snapshot", args: Empty, effects: "local", outcomes: ["ok", "gone"],
    async run(_, ctx) {
      const target = await live(ctx.runId);
      if (!target) return { outcome: "gone" };
      const { row, path, pr, draft, client, name } = target;
      if (draft) save(row, { draftId: draft });
      const missing = async (sha: string) => await tryGit(path, ["cat-file", "-e", `${sha}^{commit}`]) === undefined;
      if ((await missing(pr.baseRefOid) && await workspaces.fetch(row.repoId) === "unauthorized") ||
          (await missing(pr.headRefOid) && await workspaces.fetchPr(row.repoId, row.number) === "unauthorized")) {
        throw githubUnauthorized(row.account, "traer el PR asignado");
      }
      const head = pr.headRefOid;
      const base = await git(path, ["merge-base", pr.baseRefOid, head]);
      const root = dir(ctx.runId);
      mkdirSync(root, { recursive: true });
      await removeSource(path, root);
      await git(path, ["-c", "core.hooksPath=/dev/null", "worktree", "add", "--detach", join(root, "source"), head]);
      const diff = await gitRaw(path, ["diff", "--no-ext-diff", "--no-textconv", base, head]);
      await writeFile(join(root, "diff.patch"), diff);
      const files = (await gitRaw(path, ["diff", "--name-only", "-z", base, head])).split("\0");
      const focuses = await Promise.all(Object.entries(areas)
        .filter(([key]) => files.some((file) => file.endsWith(".rb")) || !["tests", "framework"].includes(key))
        .map(async ([key, focus]) => {
          const text = await rubric(key);
          if (text) await writeFile(join(root, `${key}.md`), text);
          return { key, focus, rubric: text ? `${key}.md` : null };
        }));
      const comments: string[] = [];
      for (const route of [`/repos/${name}/pulls/${row.number}/comments`, `/repos/${name}/issues/${row.number}/comments`, `/repos/${name}/pulls/${row.number}/reviews`]) {
        for (let page = 1; ; page++) {
          const { data } = await client.request({ method: "GET", url: route, page, per_page: 100 });
          for (const item of z.array(z.object({ body: z.string().nullish(), path: z.string().optional() })).parse(data)) {
            if (item.body) comments.push(`${item.path ?? "PR"}: ${item.body}`);
          }
          if (data.length < 100) break;
        }
      }
      const lead = await rubric("lead");
      const voice = references ? await rubric("voz") : "";
      const personalVoice = references && existsSync(join(references, "voz-personal.md")) ? await rubric("voz-personal") : "";
      await writeFile(join(root, "lead.md"), [lead, voice, personalVoice].join("\n"));
      const issue = issueOf(pr.title, pr.headRefName);
      await writeFile(join(root, "pr.json"), JSON.stringify({ title: pr.title, body: pr.body, head, base, comments,
        previous: previous(row, pr.headRefName, pr.baseRefName, issue),
        manual: await manualReviews(name, row.number, issue, reportsDir ?? join(homedir(), ".local/share/review-council/reviews")) }, null, 2));
      save(row, { head, base });
      return { outcome: "ok", output: { areas: focuses, head, base } };
    },
  };

  const draft: ActionDef<typeof DraftInput> = {
    name: "incoming.draft", args: DraftInput, effects: "remote", outcomes: ["ok", "gone", "stale"],
    async run(input, ctx) {
      const findings = Array.isArray(input.findings) ? input.findings : Findings.shape.findings.parse(
        JSON.parse(new TextDecoder().decode(artifacts.get(input.findings.artifact)?.content)));
      const current = await live(ctx.runId);
      if (!current) return { outcome: "gone" };
      if (current.row.head !== current.pr.headRefOid) return { outcome: "stale" };
      const { pr, row } = current;
      const report = Report.parse({ findings, number: row.number, head: row.head, branch: pr.headRefName, baseBranch: pr.baseRefName, issue: issueOf(pr.title, pr.headRefName) });
      artifacts.ref(artifacts.put(JSON.stringify(report), "report"), { type: "run", id: ctx.runId, role: "incoming.report" });
      for (const [index, finding] of findings.entries()) {
        ctx.signal.throwIfAborted();
        if (index) await delay(1000, undefined, { signal: ctx.signal });
        const target = index ? await live(ctx.runId) : current;
        if (!target) return { outcome: "gone" };
        const { row, client, pr } = target;
        if (pr.headRefOid !== row.head) return { outcome: "stale" };
        let draftId = target.draft;
        if (!draftId) {
          // Si se perdió la respuesta y el usuario descartó el borrador, no lo vuelvas a crear.
          if (row.reserved.includes("draft")) throw new PermanentActionError("No se pudo confirmar el borrador reservado. Revisa el resultado en GitHub.");
          row.reserved.push("draft");
          save(row, { reserved: row.reserved });
          const result = await client.graphql<{ addPullRequestReview: { pullRequestReview: { id: string } } }>(CREATE_DRAFT, { pr: pr.id, head: row.head });
          draftId = result.addPullRequestReview.pullRequestReview.id;
        }
        save(row, { draftId });
        await ctx.once(`finding:${index}`, async () => {
          const key = `${ctx.key}:${index}`;
          if (row.reserved.includes(key)) throw new PermanentActionError("No se pudo confirmar el último comentario. Revisa la review pendiente; no se volvió a escribir.");
          // Después de un cambio de head el lead puede redactar distinto el mismo hallazgo.
          // No repoblar un ancla que la persona pudo haber editado o borrado en la visita anterior.
          const anchor = `:anchor:${JSON.stringify([finding.path, finding.line])}`;
          const text = JSON.stringify([finding.path, finding.comment]);
          if (row.reserved.some((entry) => entry.endsWith(anchor) && entry !== `${ctx.key}${anchor}`) || row.reserved.includes(text)) return false;
          if (!target.draft) {
            await delay(1000, undefined, { signal: ctx.signal });
            const afterCreate = await live(ctx.runId);
            if (!afterCreate || afterCreate.pr.headRefOid !== row.head) return false;
          }
          ctx.signal.throwIfAborted();
          save(row, { reserved: [...row.reserved, key, `${ctx.key}${anchor}`, text] });
          await client.graphql(ADD_FINDING, { review: draftId, path: finding.path, line: finding.line, kind: finding.line ? "LINE" : "FILE",
            body: (prefix?.(target.name) ?? "") + cleanMessage(finding.comment) });
          return true;
        });
      }
      const after = await live(ctx.runId);
      return { outcome: !after ? "gone" : after.pr.headRefOid === row.head ? "ok" : "stale" };
    },
  };
  function workspace(runId: RunId) {
    const row = byRun(runId);
    return row?.base ? { path: dir(runId), base: row.base, repoId: row.repoId } : undefined;
  }
  function brief(request: StepBriefRequest) {
    const ws = workspace(request.run.id);
    return ws && { run: request.run, worktree: ws.path, base: ws.base, mode: request.mode, artifacts: { diff: "diff.patch" }, payload: request.payload };
  }
  async function cleanup(runId: RunId) {
    const row = byRun(runId);
    if (!row) return;
    await removeSource(repos.config(row.repoId).path, dir(runId));
    await rm(dir(runId), { recursive: true, force: true });
  }
  return { poll, snapshot, draft, workspace, brief, cleanup };
}

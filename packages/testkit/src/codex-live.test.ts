import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createClient } from "@clanker/api";
import { clankerLoopTemplate, createCodexRuntime, createConnections, createFileSecrets, createProcs, createRepos, newId, openStore, type Core, type Store } from "@clanker/core";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { createFakeRuntime } from "./fake-runtime";
import { tempGitRepo, type TempGitRepo } from "./git";
import { startGitHttpServer } from "./git-http";
import { startGitHubSim, type GitHubSim } from "./github-sim";
import { seedDb, type TestHome } from "./home";
import { startCore } from "./start-core";
import { ACCOUNT, BOT, FIXTURES, REPO, TOKEN } from "./techlead-scenario";

describe.skipIf(process.env.CLANKER_LIVE_CODEX !== "1")("techlead-clasico con Codex en vivo", () => {
  let home: TestHome;
  let store: Store;
  let repo: TempGitRepo;
  let core: Core | undefined;
  let github: GitHubSim | undefined;
  let remote: Awaited<ReturnType<typeof startGitHttpServer>> | undefined;
  beforeEach(() => {
    home = seedDb("empty");
    store = openStore({ path: home.dbPath });
    repo = tempGitRepo({
      remote: true,
      commits: [{
        message: "chore: base",
        files: {
          "package.json": '{ "name": "web", "private": true }\n',
          "src/index.ts": "export {};\n",
          ".clanker/recipe.json": JSON.stringify({ version: 1, commands: { test: "npm test -- {{files}}" }, checks: ["test"] }),
        },
      }],
    });
  });
  afterEach(async () => {
    await core?.close();
    await github?.close();
    await remote?.close();
    store.close();
    repo.cleanup();
    home.cleanup();
    core = undefined;
    github = undefined;
    remote = undefined;
  });

  test("el perfil elige un reviewer Codex real y expone su costo y transcript hasta publicar el PR", { timeout: 300_000 }, async () => {
    repo.git("--git-dir", repo.remoteDir!, "config", "http.receivepack", "true");
    remote = await startGitHttpServer(repo.remoteDir!, { user: ACCOUNT, password: TOKEN });
    github = await startGitHubSim({ origin: repo, repo: REPO, account: ACCOUNT, token: TOKEN, bot: BOT });
    let reviews = 0;
    github.onComment((pr, body) => {
      if (body.split("\n")[0] !== "/review") return;
      if (reviews++ === 0) pr.botFindings([{ body: "Falta incluir el monto en el mensaje del error", path: "src/transfer.ts", line: 2 }]);
      else pr.botLgtm();
      pr.ci("green");
    });
    const packDir = join(home.path, "packs", "acme");
    await mkdir(packDir, { recursive: true });
    await writeFile(join(packDir, "pack.json"), JSON.stringify({
      id: "acme", version: 1, activate: { githubOrgs: [ACCOUNT] },
      reviewBot: {
        logins: [BOT], request: { type: "comment", body: "/review" },
        lgtm: { reviewState: "APPROVED", bodyMatch: "LGTM", sameSha: true }, resolvableAuthors: [BOT],
      },
      conventions: { commentPrefix: "[clanker] ", councilPrefix: "[clanker-council] " },
    }));
    const connections = createConnections({
      store, secrets: createFileSecrets({ dir: join(home.path, "secrets") }),
      github: { baseUrl: github.baseUrl }, codex: { cwd: home.path },
    });
    expect((await connections.testCodex("cli")).state).toBe("ready");
    await connections.connect({ provider: "github", account: ACCOUNT, scopes: [], token: TOKEN }, "core");
    const procs = createProcs({ store, bootId: newId("boot") });
    const codex = createCodexRuntime({ home: home.path, store, procs, onRateLimits: connections.updateCodexUsage });
    const options = await codex.describe!();
    expect(options.available, options.message).toBe(true);
    const model = process.env.CLANKER_LIVE_CODEX_MODEL ?? options.models[0]!.id;
    expect(options.models.map((item) => item.id)).toContain(model);
    core = await startCore({
      store, dataDir: home.path, connections, procs,
      runtimes: [createFakeRuntime({ fixtures: [FIXTURES], speed: Infinity }), codex],
      env: {}, scheduler: false, watch: true, gitUrl: () => remote!.url,
      coreVersion: "0.0.0", onShutdown: () => {}, pause: () => Promise.resolve(),
    });
    const client = createClient({ url: core.server.url, token: core.server.token, origin: "cli" });
    await client.defs.create({
      kind: "role", slug: "review-lore", scope: "user",
      body: {
        prompt: "Eres un reviewer informativo en una prueba de integración. Tus observaciones no bloquean el flujo ni piden cambios.",
        context: [],
        modes: {
          review: {
            instructions: "Lee src/transfer.ts y reporta las observaciones que consideres útiles como findings white. Puedes dejar la lista vacía. No edites archivos. Usa outcome ok.",
            outcomes: ["ok"], session: "new",
            report: {
              type: "object",
              properties: {
                findings: {
                  type: "array",
                  items: {
                    type: "object",
                    properties: {
                      id: { type: "string" }, severity: { type: "string", enum: ["white"] },
                      path: { type: "string" }, line: { type: "integer" },
                      claim: { type: "string" }, fix: { type: "string" },
                    },
                    required: ["id", "severity", "path", "line", "claim", "fix"],
                    additionalProperties: false,
                  },
                },
              },
              required: ["findings"],
              additionalProperties: false,
            },
          },
        },
      },
    });
    await client.defs.create({
      kind: "profile", slug: "codex-live", scope: "user",
      body: { roles: { ...clankerLoopTemplate.profiles.eco!.roles, "review-lore": { runtime: "codex", model, effort: "low" } } },
    });
    const repoId = createRepos({ store }).add({ name: "web", path: repo.dir, remote: REPO });
    const project = await client.projects.create({
      slug: "codex-live", name: "Codex en vivo", tracker: "local",
      defaultFlowId: "techlead-clasico", defaultProfileId: "codex-live", repos: [{ repoId }],
    });
    const issue = await client.issues.createLocal({
      projectId: project.id, title: "Validar el monto de una transfer",
      body: "Una transfer con un monto negativo no debería crearse.\n\nCriterios de aceptación\n- El monto se redondea\n- Un monto menor o igual a 0 se rechaza\n",
    });
    const { id } = await client.runs.start({ projectId: project.id, issueId: issue.id });
    const run = await vi.waitFor(async () => {
      const current = await client.runs.get({ id });
      expect(["done", "parked", "failed", "canceled"]).toContain(current.status);
      return current;
    }, { timeout: 240_000, interval: 250 });
    expect(run).toMatchObject({ status: "done", outcome: "done", flow: { slug: "techlead-clasico" } });
    const lore = run.steps.find((step) => step.nodeId === "rv-lore")!;
    const detail = await client.runs.step({ id: lore.id });
    expect(detail.sessions, JSON.stringify(detail.sessions.map(({ status, error }) => ({ status, error })))).toHaveLength(1);
    const session = detail.sessions[0]!;
    expect(session).toMatchObject({ runtime: "codex", status: "success", report: { outcome: "ok", payload: { findings: expect.any(Array) } } });
    expect(session.turns).toBeGreaterThan(0);
    expect(session.costMicros).toBeGreaterThan(0);
    expect(lore.costMicros).toBe(session.costMicros);
    const transcript = await client.runs.transcript({ sessionId: session.id });
    expect(transcript.entries.map((entry) => entry.kind)).toEqual(expect.arrayContaining(["prompt", "text", "result"]));
    expect(transcript.entries.at(-1)).toMatchObject({ kind: "result", subtype: "success", costUsd: session.costMicros / 1_000_000 });
    expect(store.db.$client.prepare("SELECT cost_source FROM agent_sessions WHERE id = ?").get(session.id)).toEqual({ cost_source: "estimate" });
    expect(github.pulls()).toMatchObject([{ draft: true, state: "open" }]);
    expect(run.costMicros).toBeGreaterThanOrEqual(session.costMicros);
  });
});

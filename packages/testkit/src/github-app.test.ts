import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createArtifacts,
  createAskpass,
  createConnections,
  createDefs,
  createFileSecrets,
  createGitRemote,
  createPacks,
  createRecipes,
  createSlots,
  createWorkspaces,
  newId,
  openStore,
  prPublishAction,
  startFakeGitHubOAuth,
  type ActionCtx,
  type Askpass,
  type Connections,
  type FakeGitHubOAuth,
  type Store,
  type WorkspaceLease,
  type Workspaces,
} from "@clanker/core";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { tempGitRepo, type TempGitRepo } from "./git";
import { startGitHttpServer } from "./git-http";
import { startGitHubSim, type GitHubSim } from "./github-sim";

// El core publica igual con el token de la GitHub App que con un PAT: el push (git por HTTP con Basic auth)
// y el PR (API de GitHub) salen con el token del device flow, y con el rotado después del refresh. Todo es
// local: OAuth falso (`startFakeGitHubOAuth`), GitHub simulado y un servidor git; nunca GitHub real.

vi.setConfig({ testTimeout: 20_000 });

const CLIENT_ID = "Iv23liTESTTESTTEST";
const ACCOUNT = "octocat";
const REPO = "octocat/secret-project";
const BRANCH = "cla-100";
const HOUR_MS = 60 * 60 * 1000;

let dataDir: string;
let store: Store;
let repo: TempGitRepo;
let askpass: Askpass;
let connections: Connections;
let workspaces: Workspaces;
let oauth: FakeGitHubOAuth;
let github: GitHubSim;
let gitServer: Awaited<ReturnType<typeof startGitHttpServer>>;
let lease: WorkspaceLease;
let publish: ReturnType<typeof prPublishAction>;
let clock: number;

beforeEach(async () => {
  clock = 1_700_000_000_000;
  dataDir = mkdtempSync(join(tmpdir(), "clanker-github-app-"));
  store = openStore({ path: ":memory:" });
  repo = tempGitRepo({ remote: true, commits: [{ message: "chore: base", files: { "a.txt": "a\n" } }] });
  repo.git("--git-dir", repo.remoteDir!, "config", "http.receivepack", "true");
  oauth = await startFakeGitHubOAuth({ clientId: CLIENT_ID, now: () => clock });
  // GitHub (la API y el git por HTTP) acepta solo el access token vigente del OAuth falso.
  github = await startGitHubSim({ origin: repo, repo: REPO, account: ACCOUNT, token: (bearer) => oauth.isAccessTokenValid(bearer) });
  gitServer = await startGitHttpServer(repo.remoteDir!, { user: ACCOUNT, password: () => oauth.latest().accessToken });

  askpass = createAskpass();
  connections = createConnections(store, createFileSecrets({ dir: join(dataDir, "secrets") }), {
    now: () => clock,
    github: { baseUrl: github.baseUrl },
    githubApp: {
      clientId: CLIENT_ID,
      endpoints: oauth.endpoints,
      sleep: async (ms) => {
        // El usuario aprueba en el primer sondeo.
        oauth.approve();
        clock += ms;
      },
    },
  });
  const connected = new Promise<void>((resolve) => store.events.subscribe(() => resolve(), { types: ["connection.changed"] }));
  await connections.startDeviceFlow("ui");
  await connected;

  const repos = () => ({ path: repo.dir, defaultBranch: "main", remote: { url: gitServer.url, repo: REPO, account: ACCOUNT } });
  workspaces = createWorkspaces({
    store,
    dataDir,
    repos,
    identity: { name: "Clanker Yard", email: "yard@clanker.invalid" },
    remote: createGitRemote({ askpass, connections }),
  });
  const defs = createDefs(store);
  const packs = createPacks({ defs });
  const packDir = join(dataDir, "pack");
  mkdirSync(packDir);
  writeFileSync(join(packDir, "pack.json"), JSON.stringify({ id: "acme", version: 1, activate: { githubOrgs: ["octocat"] } }));
  await packs.load(packDir);
  publish = prPublishAction({
    store,
    workspaces,
    recipes: createRecipes({ store, defs, workspaces, artifacts: createArtifacts({ store, dir: join(dataDir, "artifacts") }), slots: createSlots({ store }) }),
    repos,
    connections,
    packs,
  });
  lease = await workspaces.acquire({ repo: "r1", branch: BRANCH, base: "main", runId: newId("run") });
  writeFileSync(join(lease.path, "feature.txt"), "una feature\n");
});

afterEach(async () => {
  workspaces.release(lease);
  await askpass.close();
  await gitServer.close();
  await github.close();
  await oauth.close();
  repo.cleanup();
  store.close();
  rmSync(dataDir, { recursive: true, force: true });
});

const ctx = (): ActionCtx => ({
  runId: newId("run"),
  stepId: newId("stp"),
  key: "run:publish:1",
  signal: new AbortController().signal,
  once: (_stage, fn) => fn(),
});

function publishArgs() {
  const { workspaceId, path, branch, baseSha, fencingToken } = lease;
  return publish.args.parse({
    ws: { workspaceId, path, branch, baseSha, fencingToken },
    plan: {
      commits: [{ message: "feat: add feature", hunks: ["h1"], tests: [] }],
      pr: { title: "[CLA-100] Add feature", body: "## Contexto\n\nPor qué se hace.\n\n## Tests\n\n- [x] Tests unitarios" },
    },
  });
}

const basic = (password: string) => `Basic ${Buffer.from(`${ACCOUNT}:${password}`).toString("base64")}`;
const remoteSha = () => repo.git("--git-dir", repo.remoteDir!, "rev-parse", `refs/heads/${BRANCH}`);

describe("publicar con el token de la GitHub App", () => {
  test("el push y el PR salen con el token del device flow", async () => {
    const { accessToken } = oauth.latest();

    const result = await publish.run(publishArgs(), ctx());

    expect(result).toMatchObject({ outcome: "ok", output: { pr: { account: ACCOUNT, repo: REPO, number: 1 }, head: remoteSha() } });
    expect(github.pulls()).toMatchObject([{ number: 1, draft: true, head: { ref: BRANCH }, base: { ref: "main" } }]);
    expect(gitServer.authorizations).toContain(basic(accessToken));
    for (const request of github.requests.filter((r) => r.path === `/repos/${REPO}/pulls`)) {
      expect(request.authorization).toBe(`bearer ${accessToken}`);
    }
    expect(connections.list()).toMatchObject([{ account: ACCOUNT, auth: "app", status: "active" }]);
  });

  test("con el token a punto de vencer se refresca antes de publicar y el push y el PR salen con el nuevo", async () => {
    const first = oauth.latest();
    clock += 8 * HOUR_MS;

    await publish.run(publishArgs(), ctx());

    const { accessToken, refreshToken } = oauth.latest();
    expect(accessToken).not.toBe(first.accessToken);
    expect(refreshToken).not.toBe(first.refreshToken);
    expect(oauth.requests.filter((r) => r.form.grant_type === "refresh_token")).toHaveLength(1);
    expect(gitServer.authorizations).toContain(basic(accessToken));
    expect(gitServer.authorizations).not.toContain(basic(first.accessToken));
    expect(github.pulls()).toHaveLength(1);
    expect(github.requests.filter((r) => r.path === `/repos/${REPO}/pulls`).every((r) => r.authorization === `bearer ${accessToken}`)).toBe(true);
    expect(connections.list()).toMatchObject([{ account: ACCOUNT, status: "active" }]);
  });
});

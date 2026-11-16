import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { MergeStrategy, PrRef, RepoId } from "@clanker/api";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { createConnections, type Connections } from "../connections/connections";
import { createFileSecrets } from "../secrets/encrypted-file";
import { openStore, type Store } from "../store/store";
import { createRepos, type Repos } from "../repos/repos";
import { healthyGitHub, startFakeGitHub, type FakeGitHub } from "../testing/github/fake-github";
import { prGraphql, type DefaultBranchCommit } from "../testing/github/fake-pr-graphql";
import { createMergeScope } from "./merge-scope";
import { prNode } from "../testing/github/pr-fixtures";
import { seedPr } from "../testing/pull-requests";

const TOKEN = "github_pat_UNIQUE-0123456789";
const REF: PrRef = { account: "octocat", repo: "acme/api", number: 4251 };
const STRATEGY: MergeStrategy = {
  type: "comment",
  command: "/merge",
  queueCheck: "merge-queue",
  appliesWhen: { checkSeenOnDefault: "merge-queue" },
  ready: ["notDraft"],
  offer: ["ready"],
  auto: ["offer"],
  onOffer: "gate",
  onAuto: "act",
};
const DAY = 24 * 60 * 60 * 1000;

let dir: string;
let store: Store;
let github: FakeGitHub | undefined;
let repos: Repos;
let repoId: RepoId;
let clock: number;
/** Los commits de la branch por defecto que GitHub responde ahora. */
let history: DefaultBranchCommit[];

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "clanker-merge-scope-"));
  store = openStore({ path: ":memory:" });
  repos = createRepos(store);
  repoId = repos.add({ name: "api", path: dir, remote: "acme/api" });
  clock = Date.UTC(2026, 10, 15);
  history = [];
});

afterEach(async () => {
  await github?.close();
  github = undefined;
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

async function scope() {
  const rest = healthyGitHub();
  github = await startFakeGitHub((request) => (request.path === "/graphql" ? prGraphql(prNode(), { defaultBranchChecks: history })(request) : rest(request)));
  const connections: Connections = createConnections(store, createFileSecrets({ dir }), { github: { baseUrl: github.baseUrl } });
  await connections.setPat(TOKEN, "ui");
  return createMergeScope({ store, repos, connections, now: () => clock });
}

const asked = () => github!.requests.filter((r) => r.path === "/graphql").length;
const onDefault = (...checks: string[]): DefaultBranchCommit => ({ checks: [], statuses: checks });

describe("applies", () => {
  test("sin appliesWhen aplica siempre y no pregunta a GitHub", async () => {
    const merge = await scope();

    expect(await merge.applies(REF, { ...STRATEGY, appliesWhen: undefined })).toBe(true);
    expect(asked()).toBe(0);
  });

  test("aplica donde el check aparece en alguno de los últimos commits de la branch por defecto (status o check run)", async () => {
    history = [onDefault("ci/build"), null, { checks: ["merge-queue"], statuses: [] }];
    const merge = await scope();

    expect(await merge.applies(REF, STRATEGY)).toBe(true);
  });

  test("no aplica donde no aparece, también con una branch sin checks", async () => {
    history = [onDefault("ci/build"), null];
    const merge = await scope();

    expect(await merge.applies(REF, STRATEGY)).toBe(false);
  });

  test("lo que vio se recuerda: una semana si lo vio, un día si no", async () => {
    history = [onDefault("merge-queue")];
    const merge = await scope();
    expect(await merge.applies(REF, STRATEGY)).toBe(true);

    history = [];
    clock += 6 * DAY;
    expect(await merge.applies(REF, STRATEGY)).toBe(true);
    expect(asked()).toBe(1);
    clock += 2 * DAY;
    expect(await merge.applies(REF, STRATEGY)).toBe(false);
    expect(asked()).toBe(2);

    history = [onDefault("merge-queue")];
    clock += DAY / 2;
    expect(await merge.applies(REF, STRATEGY)).toBe(false);
    expect(asked()).toBe(2);
    clock += DAY;
    expect(await merge.applies(REF, STRATEGY)).toBe(true);
    expect(asked()).toBe(3);
  });

  test("el override del repo manda sobre lo detectado y no pregunta a GitHub", async () => {
    history = [onDefault("merge-queue")];
    const merge = await scope();

    repos.setMergeStrategy(repoId, "off");
    expect(await merge.applies(REF, STRATEGY)).toBe(false);
    repos.setMergeStrategy(repoId, "on");
    history = [];
    expect(await merge.applies(REF, STRATEGY)).toBe(true);
    expect(asked()).toBe(0);

    repos.setMergeStrategy(repoId, null);
    expect(await merge.applies(REF, STRATEGY)).toBe(false);
    expect(asked()).toBe(1);
  });

  test("un repo que el core no conoce se detecta igual", async () => {
    history = [onDefault("merge-queue")];
    const merge = await scope();

    expect(await merge.applies({ ...REF, repo: "otra/cosa" }, STRATEGY)).toBe(true);
  });
});

describe("hold", () => {
  test("es el de la fila del PR; sin fila, falso", async () => {
    const merge = await scope();
    expect(merge.hold(REF)).toBe(false);

    seedPr(store, { id: "pr_1", repoId, number: REF.number, headRef: "x", headSha: "a", owned: false, hold: true });

    expect(merge.hold(REF)).toBe(true);
    expect(merge.hold({ ...REF, number: 1 })).toBe(false);
    expect(merge.hold({ ...REF, repo: "otra/cosa" })).toBe(false);
  });
});

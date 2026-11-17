import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type PrRef, type RepoId } from "@clanker/api";
import {
  createConnections,
  createDefs,
  createFileSecrets,
  createMergeScope,
  createPacks,
  createPrCache,
  createPrCommands,
  createPrs,
  createRepos,
  openStore,
  PrCommandError,
  type PrCache,
  type PrCommands,
  type Store,
} from "@clanker/core";
import { afterEach, beforeEach, describe, expect, test} from "vitest";
import { tempGitRepo, type TempGitRepo } from "./git";
import { startGitHubSim, type GitHubSim, type SimPr } from "./github-sim";
import { seedPr } from "@clanker/core/testing";

// Lo que una persona le pide a un PR desde la app (`prs.merge`, `prs.requestReview`, `prs.rebase`, `prs.setHold`) con
// el pack de ejemplo (`fixtures/packs/example`, salvo su alcance) sobre el GitHub simulado.

const TOKEN = "github_pat_UNIQUE-0123456789";
const ACCOUNT = "octocat";
const REPO = "octocat/secret-project";
const EXAMPLE_PACK = new URL("../fixtures/packs/example/pack.json", import.meta.url);

let dir: string;
let store: Store;
let origin: TempGitRepo;
let sim: GitHubSim;
let cache: PrCache;
let commands: PrCommands;
let repoId: RepoId;

const ref = (number: number): PrRef => ({ account: ACCOUNT, repo: REPO, number });

async function setup(pack: "example" | "none") {
  const connections = createConnections({ store, secrets: createFileSecrets({ dir }), github: { baseUrl: sim.baseUrl } });
  await connections.connect({ provider: "github", account: ACCOUNT, scopes: [], token: TOKEN }, "core");
  const repos = createRepos({ store, remote: (repo) => ({ url: `file://${origin.remoteDir}`, repo, account: ACCOUNT }) });
  repoId = repos.add({ name: "secret-project", path: origin.dir, remote: REPO });

  const packs = createPacks({ defs: createDefs({ store }) });
  if (pack === "example") {
    const packDir = join(dir, "pack");
    mkdirSync(packDir);
    const example = JSON.parse(readFileSync(EXAMPLE_PACK, "utf8")) as Record<string, unknown>;
    writeFileSync(join(packDir, "pack.json"), JSON.stringify({ ...example, activate: { githubOrgs: ["octocat"] }, flows: [], roles: [], contexts: [] }));
    await packs.load(packDir);
  }
  const prs = createPrs({ connections, packs, merge: createMergeScope({ store, repos, connections }) });
  cache = createPrCache({ store, repos, packs, prs });
  commands = createPrCommands({ store, repos, connections, packs, prs, cache });
}

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "clanker-pr-commands-"));
  store = openStore({ path: ":memory:" });
  origin = tempGitRepo({
    remote: true,
    commits: [{ message: "chore: base", files: { "a.txt": "a\n" } }],
    branches: { one: [{ message: "feat: one", files: { "one.txt": "1\n" } }] },
  });
  sim = await startGitHubSim({ origin, token: TOKEN });
});

afterEach(async () => {
  await sim.close();
  origin.cleanup();
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

/** Un PR que Watch ya conoce (con su fila), y que si se quiere lo abrió el sistema. */
function known(pr: SimPr, { owned = false }: { owned?: boolean } = {}) {
  seedPr(store, { id: `pr_${pr.number}`, repoId, number: pr.number, headRef: "one", headSha: pr.headSha(), owned });
}

const sent = (pr: SimPr, body: string) => pr.node().comments.filter((c) => c.body === body && c.author?.login === ACCOUNT);
const approved = () => {
  sim.defaultBranchCheck("merge-queue");
  const pr = sim.openPr({ head: "one" });
  pr.ci("green");
  pr.review("ana", "APPROVED");
  return pr;
};

describe("merge", () => {
  test("un PR listo recibe el comando de merge del pack desde la cuenta del usuario y vuelve releído en cola", async () => {
    await setup("example");
    const pr = approved();
    known(pr);

    const state = await commands.merge(ref(pr.number), "ui");

    expect(sent(pr, "/merge")).toHaveLength(1);
    expect(state.merge).toMatchObject({ via: "comment", command: "/merge", queue: "queued", ready: false });
    expect(cache.list()[0]?.state?.merge.queue).toBe("queued");
  });

  test.each([
    ["no está aprobado", (pr: SimPr) => pr.review("ana", "CHANGES_REQUESTED"), /no está listo para mergear: pidieron cambios/],
    ["tiene el CI en rojo", (pr: SimPr) => pr.ci("red"), /no está listo para mergear: el CI no está verde/],
  ])("un PR que %s se rechaza con lo que falta y no comenta nada", async (_name, spoil, message) => {
    await setup("example");
    const pr = approved();
    known(pr);
    spoil(pr);

    await expect(commands.merge(ref(pr.number), "ui")).rejects.toThrow(message);

    expect(sent(pr, "/merge")).toEqual([]);
  });

  test("con hold se rechaza hasta que se quita", async () => {
    await setup("example");
    const pr = approved();
    known(pr);
    expect((await commands.setHold(ref(pr.number), true, "ui")).hold).toBe(true);

    await expect(commands.merge(ref(pr.number), "ui")).rejects.toThrow(/tiene hold/);
    expect(sent(pr, "/merge")).toEqual([]);

    await commands.setHold(ref(pr.number), false, "ui");
    await commands.merge(ref(pr.number), "ui");
    expect(sent(pr, "/merge")).toHaveLength(1);
    // Cada pedido queda con quién lo hizo: el hold y el comentario del merge.
    const asked = store.events.since(0, { types: ["pr.hold_changed", "pr.commented"] }).map((e) => [e.type, e.origin, e.payload.hold ?? e.payload.body]);
    expect(asked).toEqual([
      ["pr.hold_changed", "ui", true],
      ["pr.hold_changed", "ui", false],
      ["pr.commented", "ui", "/merge"],
    ]);
  });

  test("pedirlo dos veces no comenta dos veces: la segunda ve el PR en cola", async () => {
    await setup("example");
    const pr = approved();
    known(pr);
    await commands.merge(ref(pr.number), "ui");

    await expect(commands.merge(ref(pr.number), "ui")).rejects.toThrow(/ya está en cola/);
    expect(sent(pr, "/merge")).toHaveLength(1);
  });

  test("donde la estrategia del pack no aplica (sin merge-queue en la branch por defecto) se manda al botón de GitHub", async () => {
    await setup("example");
    const pr = sim.openPr({ head: "one" });
    pr.ci("green");
    pr.review("ana", "APPROVED");
    known(pr);

    await expect(commands.merge(ref(pr.number), "ui")).rejects.toThrow(/botón de GitHub/);
    expect(sent(pr, "/merge")).toEqual([]);
  });
});

describe("requestReview", () => {
  test("comenta el comando del bot del pack, tal cual", async () => {
    await setup("example");
    const pr = sim.openPr({ head: "one" });

    await commands.requestReview(ref(pr.number), "ui");

    expect(sent(pr, "/review")).toHaveLength(1);
  });

  test("sin bot en el pack no hay a quién pedírsela", async () => {
    await setup("none");
    const pr = sim.openPr({ head: "one" });

    await expect(commands.requestReview(ref(pr.number), "ui")).rejects.toThrow(PrCommandError);
    expect(pr.node().comments).toEqual([]);
  });

  test("un PR mergeado ya no la recibe", async () => {
    await setup("example");
    const pr = sim.openPr({ head: "one" });
    pr.merge();

    await expect(commands.requestReview(ref(pr.number), "ui")).rejects.toThrow(/ya está mergeado/);
  });
});

describe("rebase", () => {
  const conflicts = () => store.events.since(0, { types: ["pr.conflict"] });

  test("anota un pr.conflict con el sha y la base del PR para que arranque el flujo que lo atiende", async () => {
    await setup("example");
    const pr = sim.openPr({ head: "one" });
    known(pr, { owned: true });

    await commands.rebase(ref(pr.number), "ui");

    expect(conflicts()).toMatchObject([{ origin: "ui", subject: { type: "pr", id: `pr_${pr.number}` }, payload: { repo: REPO, number: pr.number, sha: pr.headSha(), base: "main" } }]);
  });

  test("un PR que el sistema no abrió no se rebasea nunca", async () => {
    await setup("example");
    const pr = sim.openPr({ head: "one" });
    known(pr);

    await expect(commands.rebase(ref(pr.number), "ui")).rejects.toThrow(/no lo abrió el sistema/);
    expect(conflicts()).toEqual([]);
  });

  test("con threads de council no se fuerza su historia", async () => {
    await setup("example");
    const pr = sim.openPr({ head: "one" });
    known(pr, { owned: true });
    pr.councilThread("revisa esto", { by: "otra" });

    await expect(commands.rebase(ref(pr.number), "ui")).rejects.toThrow(/council/);
    expect(conflicts()).toEqual([]);
  });

  test("un PR que el core no conoce se rechaza diciendo qué hacer", async () => {
    await setup("example");
    const pr = sim.openPr({ head: "one" });

    await expect(commands.rebase(ref(pr.number), "ui")).rejects.toThrow(/registra el repo y espera a que Watch lo vea/);
  });
});

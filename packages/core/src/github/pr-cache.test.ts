import { PackSettings, type PrRef, type PrState } from "@clanker/api";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { pullRequests } from "../store/schema";
import { openStore, type Store } from "../store/store";
import { createRepos, type Repos } from "../workspaces/repos";
import { createPrCache, type PrCache, type RestPull } from "./pr-cache";
import { prNode } from "./pr-fixtures";
import { buildPrState } from "./pr-state";

const ACCOUNT = "octocat";
const NOW = 1_000_000;

let store: Store;
let repos: Repos;
let repoId: string;
let cache: PrCache;
let state: PrState;
const onChange = vi.fn<(ref: PrRef, state: PrState) => void>();

const stateOf = (overrides: Parameters<typeof prNode>[0] = {}) => buildPrState(prNode({ number: 7, ...overrides }), { pack: { id: null, ...PackSettings.parse({}) }, viewer: ACCOUNT });
const ref = (number: number, repo = "acme/api"): PrRef => ({ account: ACCOUNT, repo, number });
const pull = (overrides: Partial<RestPull> = {}): RestPull => ({
  number: 7,
  node_id: "PR_7",
  state: "open",
  draft: false,
  merged: false,
  head: { ref: "feat/x", sha: "a".repeat(40) },
  base: { ref: "main" },
  ...overrides,
});

beforeEach(() => {
  store = openStore({ path: ":memory:" });
  repos = createRepos(store, { remote: (repo) => ({ url: `https://example.invalid/${repo}.git`, repo, account: ACCOUNT }) });
  repoId = repos.add({ name: "api", path: "/tmp/api", remote: "acme/api" });
  state = stateOf();
  cache = createPrCache({ store, repos, prs: { get: () => Promise.resolve(state) }, onChange, now: () => NOW });
  onChange.mockReset();
});

afterEach(() => store.close());

describe("saveRest", () => {
  test("un PR que el sistema no abrió entra como no propio, y el head que se mueve queda anotado", () => {
    const created = cache.saveRest(repoId, pull(), NOW);
    expect(created).toMatchObject({ number: 7, owned: false, state: "open", isDraft: false, headRef: "feat/x", headChangedAt: NOW });

    const same = cache.saveRest(repoId, pull({ draft: true }), NOW + 5);
    expect(same).toMatchObject({ id: created.id, isDraft: true, headChangedAt: NOW });

    const moved = cache.saveRest(repoId, pull({ head: { ref: "feat/x", sha: "c".repeat(40) } }), NOW + 10);
    expect(moved).toMatchObject({ id: created.id, headSha: "c".repeat(40), headChangedAt: NOW + 10 });
  });

  test("un PR mergeado queda merged, no solo closed", () => {
    expect(cache.saveRest(repoId, pull({ state: "closed", merged: true }), NOW).state).toBe("merged");
    expect(cache.saveRest(repoId, pull({ number: 8, state: "closed" }), NOW).state).toBe("closed");
  });

  test("open lista los abiertos, en draft o no", () => {
    cache.saveRest(repoId, pull(), NOW);
    cache.saveRest(repoId, pull({ number: 8, draft: true }), NOW);
    cache.saveRest(repoId, pull({ number: 9, state: "closed", merged: true }), NOW);

    expect(cache.open().map((row) => row.number)).toEqual([7, 8]);
  });
});

describe("refresh", () => {
  test("guarda el estado en la fila y avisa solo cuando cambió", async () => {
    cache.saveRest(repoId, pull(), NOW);

    expect(await cache.refresh(ref(7))).toEqual(state);
    expect(cache.row(repoId, 7)).toMatchObject({ detail: state, detailAt: NOW, state: "open", isDraft: false });
    expect(onChange).toHaveBeenCalledTimes(1);

    await cache.refresh(ref(7));
    expect(onChange).toHaveBeenCalledTimes(1);

    state = stateOf({ isDraft: true, headRefOid: "d".repeat(40) });
    await cache.refresh(ref(7));
    expect(onChange).toHaveBeenCalledTimes(2);
    expect(onChange).toHaveBeenLastCalledWith(ref(7), state);
    expect(cache.row(repoId, 7)).toMatchObject({ isDraft: true, headSha: "d".repeat(40), headChangedAt: NOW });
  });

  test("un PR que el caché no conoce se lee igual pero no entra ni avisa", async () => {
    expect(await cache.refresh(ref(7))).toEqual(state);
    expect(await cache.refresh(ref(7, "otra/cosa"))).toEqual(state);

    expect(store.db.select().from(pullRequests).all()).toEqual([]);
    expect(onChange).not.toHaveBeenCalled();
  });
});

describe("list", () => {
  test("filtra por repo, dueño y estado, y salta repos sin remoto", async () => {
    cache.saveRest(repoId, pull(), NOW);
    cache.saveRest(repoId, pull({ number: 8, state: "closed", merged: true }), NOW);
    const other = repos.add({ name: "otro", path: "/tmp/otro", remote: "acme/otro" });
    cache.saveRest(other, pull({ number: 1 }), NOW);
    const local = repos.add({ name: "local", path: "/tmp/local", remote: null });
    cache.saveRest(local, pull({ number: 2 }), NOW);
    await cache.refresh(ref(7));

    expect(cache.list().map((p) => [p.ref.repo, p.ref.number])).toEqual([
      ["acme/api", 7],
      ["acme/api", 8],
      ["acme/otro", 1],
    ]);
    expect(cache.list({ repo: "acme/otro" }).map((p) => p.ref.number)).toEqual([1]);
    expect(cache.list({ state: "merged" }).map((p) => p.ref.number)).toEqual([8]);
    expect(cache.list({ owned: true })).toEqual([]);
    expect(cache.list({ repo: "acme/api" })[0]).toMatchObject({ ref: ref(7), owned: false, state, readAt: NOW });
    expect(cache.list({ repo: "acme/api" })[1]).toMatchObject({ state: null, readAt: null });
  });
});

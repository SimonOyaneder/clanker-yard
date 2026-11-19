import { PackSettings, type PrRef, type PrState, type RepoId } from "@clanker/api";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { newId } from "../store/conventions";
import { prParents, pullRequests } from "../store/schema";
import { openStore, type Store } from "../store/store";
import { createRepos, type Repos } from "../repos/repos";
import { createPrCache, type PrCache, type PrCacheDeps, type RestPull } from "./pr-cache";
import { prNode } from "../testing/github/pr-fixtures";
import { buildPrState } from "./pr-state";
import { seedPr } from "../testing/pull-requests";

const ACCOUNT = "octocat";
const NOW = 1_000_000;

let store: Store;
let repos: Repos;
let repoId: RepoId;
let cache: PrCache;
let state: PrState;
const onChange = vi.fn<NonNullable<PrCacheDeps["onChange"]>>();

const NO_PACK = { id: null, ...PackSettings.parse({}) };
const packs = { packFor: () => NO_PACK };

const stateOf = (overrides: Parameters<typeof prNode>[0] = {}) => buildPrState(prNode({ number: 7, ...overrides }), { pack: NO_PACK, viewer: ACCOUNT });
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
  repos = createRepos({ store, remote: (repo) => ({ url: `https://example.invalid/${repo}.git`, repo, account: ACCOUNT }) });
  repoId = repos.add({ name: "api", path: "/tmp/api", remote: "acme/api" });
  state = stateOf();
  cache = createPrCache({ store, repos, packs, prs: { get: () => Promise.resolve(state) }, onChange, now: () => NOW });
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
    expect(onChange).toHaveBeenLastCalledWith(ref(7), state, expect.objectContaining({ number: 7, headSha: state.headSha }));
    expect(cache.row(repoId, 7)).toMatchObject({ isDraft: true, headSha: "d".repeat(40), headChangedAt: NOW });
  });

  test("emite pr.changed sobre el PR cuando lo que prs.list sirve cambió, y solo entonces", async () => {
    const row = cache.saveRest(repoId, pull(), NOW);
    const changed = () => store.events.since(0, { types: ["pr.changed"] });

    await cache.refresh(ref(7));
    await cache.refresh(ref(7));
    expect(changed()).toMatchObject([{ origin: "core", subject: { type: "pr", id: row.id }, payload: { key: "api#7" } }]);

    state = stateOf({ labels: [{ name: "risk:high", color: "d73a4a", description: null }] });
    await cache.refresh(ref(7));
    expect(changed()).toHaveLength(2);
  });

  test("un PR que el caché no conoce se lee igual pero no entra ni avisa", async () => {
    expect(await cache.refresh(ref(7))).toEqual(state);
    expect(await cache.refresh(ref(7, "otra/cosa"))).toEqual(state);

    expect(store.db.select().from(pullRequests).all()).toEqual([]);
    expect(onChange).not.toHaveBeenCalled();
  });
});

describe("list", () => {
  test("por issue incluye PRs locales y mergeados y descarta los ajenos", () => {
    const issueId = newId("iss");
    const merged = seedPr(store, { repoId, issueId, number: 9, state: "merged" });
    const local = seedPr(store, { repoId, issueId, number: null, state: "local", headRef: "feat/y", title: "PR local" });
    seedPr(store, { repoId, issueId: newId("iss"), number: 10 });

    expect(cache.list({ issueId }).map((pr) => pr.id)).toEqual([local, merged]);
  });

  test("filtra por repo, dueño y estado, y salta repos sin remoto", async () => {
    cache.saveRest(repoId, pull(), NOW);
    cache.saveRest(repoId, pull({ number: 8, state: "closed", merged: true }), NOW);
    const other = repos.add({ name: "otro", path: "/tmp/otro", remote: "acme/otro" });
    cache.saveRest(other, pull({ number: 1 }), NOW);
    const local = repos.add({ name: "local", path: "/tmp/local", remote: null });
    cache.saveRest(local, pull({ number: 2 }), NOW);
    await cache.refresh(ref(7));

    expect(cache.list().map((p) => [p.ref?.repo, p.ref?.number])).toEqual([
      ["acme/api", 7],
      ["acme/api", 8],
      ["acme/otro", 1],
    ]);
    expect(cache.list({ repo: "acme/otro" }).map((p) => p.ref?.number)).toEqual([1]);
    expect(cache.list({ state: "merged" }).map((p) => p.ref?.number)).toEqual([8]);
    expect(cache.list({ owned: true })).toEqual([]);
    expect(cache.list({ repo: "acme/api" })[0]).toMatchObject({ ref: ref(7), owned: false, state, readAt: NOW });
    expect(cache.list({ repo: "acme/api" })[1]).toMatchObject({ state: null, readAt: null });
  });

  test("un PR local sale sin ref, con su branch, base y título, y Watch no lo vigila", () => {
    cache.saveRest(repoId, pull(), NOW);
    const parent = seedPr(store, { repoId, number: 9, state: "merged", headRef: "feat/x" });
    const id = seedPr(store, { repoId, number: null, state: "local", headRef: "feat/y", baseRef: "feat/x", title: "feat: y", body: "cuerpo", parents: [parent] });

    expect(cache.list({ state: "local" })).toEqual([expect.objectContaining({ id, repo: "acme/api", ref: null, local: { branch: "feat/y", base: "feat/x", title: "feat: y" }, state: null, parents: [parent] })]);
    expect(cache.list({ state: "local", repo: "acme/otro" })).toEqual([]);
    expect(cache.list({ state: "open" })).toEqual([expect.objectContaining({ ref: ref(7), local: null })]);
    expect(cache.open().map((row) => row.number)).toEqual([7]);
  });
});

describe("list: lo del core y del pack que el estado de GitHub no trae", () => {
  const pack = (settings: Record<string, unknown>) => ({ packFor: () => ({ id: "demo", ...PackSettings.parse(settings) }) });
  const risk = { id: "risk", source: "label", match: "^risk:(high|low)$", levels: { high: { label: "Alto", tone: "bad", hint: "h" }, low: { label: "Bajo", tone: "ok", hint: "l" } }, empty: "Sin riesgo" };

  test("las señales y el bot de review son los del pack de la org del repo, y sin pack no hay ninguno", () => {
    cache.saveRest(repoId, pull(), NOW);
    expect(cache.list()[0]).toMatchObject({ signals: [], reviewBot: false });

    const withPack = createPrCache({
      store,
      repos,
      packs: pack({ signals: [risk], reviewBot: { logins: ["bot"], request: { type: "comment", body: "review" }, lgtm: { reviewState: "APPROVED" } } }),
      prs: { get: () => Promise.resolve(state) },
    });
    expect(withPack.list()[0]).toMatchObject({ reviewBot: true, signals: [{ id: "risk", match: "^risk:(high|low)$", empty: "Sin riesgo", levels: { high: { label: "Alto", tone: "bad" } } }] });
  });

  test("parents trae los PRs de que cuelga, de pr_parents: dos o más son una base combinada", () => {
    const base = cache.saveRest(repoId, pull({ number: 1 }), NOW);
    const other = cache.saveRest(repoId, pull({ number: 2 }), NOW);
    const child = cache.saveRest(repoId, pull({ number: 3 }), NOW);
    store.tx((tx) => {
      tx.db.insert(prParents).values([
        { childId: child.id, parentId: other.id },
        { childId: child.id, parentId: base.id },
      ]).run();
    });

    const [first, second, third] = cache.list();
    expect(first?.parents).toEqual([]);
    expect(second?.parents).toEqual([]);
    expect(third?.parents).toEqual([base.id, other.id].sort());
  });
});

describe("setHold", () => {
  test("marca el PR, lo relee con el hold ya puesto y avisa del cambio; quitarlo también", async () => {
    cache.saveRest(repoId, pull(), NOW);
    await cache.refresh(ref(7));
    onChange.mockReset();
    // El PrState de `prs.get` lee el hold de la fila: aquí se arma como lo haría `MergeScope`.
    cache = createPrCache({
      store,
      repos,
      packs,
      prs: { get: () => Promise.resolve(stateOfHold(cache.row(repoId, 7)!.hold)) },
      onChange,
      now: () => NOW,
    });

    const held = await cache.setHold(ref(7), true);

    expect(held.hold).toBe(true);
    expect(cache.row(repoId, 7)).toMatchObject({ hold: true, detail: { hold: true } });
    expect(onChange).toHaveBeenCalledTimes(1);

    expect((await cache.setHold(ref(7), false)).hold).toBe(false);
    expect(cache.row(repoId, 7)).toMatchObject({ hold: false, detail: { hold: false } });
    expect(onChange).toHaveBeenCalledTimes(2);
  });

  test("un PR que el core no conoce no se puede marcar", async () => {
    await expect(cache.setHold(ref(7), true)).rejects.toThrow("El core no conoce el PR acme/api#7");
    await expect(cache.setHold(ref(7, "otra/cosa"), true)).rejects.toThrow("otra/cosa#7");
  });
});

const stateOfHold = (hold: boolean) =>
  buildPrState(prNode({ number: 7 }), { pack: NO_PACK, viewer: ACCOUNT, hold });

import { PackSettings, type RepoId } from "@clanker/api";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { createRepos } from "../repos/repos";
import { watchMarks } from "../store/schema";
import { openStore, type Store } from "../store/store";
import { prNode } from "../testing/github/pr-fixtures";
import { seedPr } from "../testing/pull-requests";
import { closedPrsWithLiveChildren } from "./pr-rows";
import { buildPrState } from "./pr-state";

const CHECKED = "landed.checked";
const detail = buildPrState(prNode({ number: 1 }), { pack: { id: null, ...PackSettings.parse({}) }, viewer: "octocat" });

let store: Store;
let repoId: RepoId;

beforeEach(() => {
  store = openStore({ path: ":memory:" });
  repoId = createRepos({ store }).add({ name: "api", path: "/tmp/api", remote: "acme/api" });
});

afterEach(() => store.close());

const mark = (prId: string, kind: string) => store.tx((tx) => tx.db.insert(watchMarks).values({ prId, kind, key: "x", createdAt: 0 }).run());

describe("closedPrsWithLiveChildren", () => {
  test("solo los cerrados del sistema con detalle, algún hijo abierto o local y sin la marca", () => {
    const withOpenChild = seedPr(store, { repoId, number: 1, state: "closed", detail });
    seedPr(store, { repoId, number: 2, parents: [withOpenChild] });

    const withLocalChild = seedPr(store, { repoId, number: 3, state: "closed", detail });
    seedPr(store, { repoId, number: null, headRef: "local-1", state: "local", title: "local", parents: [withLocalChild] });

    const childMerged = seedPr(store, { repoId, number: 5, state: "closed", detail });
    seedPr(store, { repoId, number: 6, state: "merged", parents: [childMerged] });

    const checked = seedPr(store, { repoId, number: 7, state: "closed", detail });
    seedPr(store, { repoId, number: 8, parents: [checked] });
    mark(checked, CHECKED);

    const merged = seedPr(store, { repoId, number: 9, state: "closed", detail });
    seedPr(store, { repoId, number: 10, parents: [merged] });
    mark(merged, "pr.merged");

    const notOwned = seedPr(store, { repoId, number: 11, state: "closed", detail, owned: false });
    seedPr(store, { repoId, number: 12, parents: [notOwned] });

    const unread = seedPr(store, { repoId, number: 13, state: "closed" });
    seedPr(store, { repoId, number: 14, parents: [unread] });

    const rows = closedPrsWithLiveChildren(store.db, CHECKED);
    expect(rows.map((r) => r.number).sort((a, b) => a! - b!)).toEqual([1, 3]);
    expect(rows[0]!.detail).toEqual(detail);
  });
});

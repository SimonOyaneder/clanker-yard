import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RepoId } from "@clanker/api";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { events, pullRequests } from "../store/schema";
import { openStore, type Store } from "../store/store";
import { seedPr } from "../testing/pull-requests";
import { createStaleRoots } from "./stale-roots";

const REPO = "repo_01M7GXGA3FDXGQBT86RVH53HG9" as RepoId;

let dir: string;
let store: Store;

const git = (...args: string[]) =>
  execFileSync("git", ["-C", dir, "-c", "user.name=t", "-c", "user.email=t@t", ...args], { stdio: "pipe" }).toString().trim();
/** Un commit vacío sobre `from` en la branch `branch`; devuelve su sha. */
const commitOn = (branch: string, from: string) => {
  git("checkout", "-q", "-B", branch, from);
  git("commit", "-q", "--allow-empty", "-m", branch);
  return git("rev-parse", "HEAD");
};

const staleRoots = () =>
  createStaleRoots({ store, repos: { config: () => ({ path: dir, defaultBranch: "main", remote: { url: "https://github.com/octo/app.git", repo: "octo/app", account: "octo" } }) } });

const conflicts = () => store.db.select().from(events).where(eq(events.type, "pr.conflict")).all();

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "clanker-stale-roots-"));
  store = openStore({ path: ":memory:" });
  git("init", "-q", "-b", "main");
  git("commit", "-q", "--allow-empty", "-m", "m1");
});

afterEach(() => {
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

describe("rebaseStaleRoots", () => {
  /**
   * El caso de BA-9228: la cadena raíz (#1, sobre main) → hijo (#2) se armó sobre una punta vieja de main, y otra
   * cadena (#3) ya está al día. Ninguno choca con su propia base; la base combinada de #2 y #3 choca con main.
   */
  function stack() {
    const m1 = git("rev-parse", "main");
    const root = seedPr(store, { repoId: REPO, number: 1, headRef: "root", baseRef: "main", headSha: commitOn("root", m1) });
    const child = seedPr(store, { repoId: REPO, number: 2, headRef: "child", baseRef: "root", headSha: commitOn("child", "root"), parents: [root] });
    const m2 = commitOn("main", m1);
    git("update-ref", "refs/remotes/origin/main", m2);
    seedPr(store, { repoId: REPO, number: 3, headRef: "fresh", baseRef: "main", headSha: commitOn("fresh", m2) });
    return { root, child };
  }

  test("pide rebasear solo la raíz atrasada de la cadena de un padre, con un pr.conflict como el de prs.rebase", async () => {
    const { root } = stack();

    expect(await staleRoots()(REPO, ["child", "fresh"])).toEqual(["app#1"]);

    expect(conflicts()).toEqual([
      expect.objectContaining({ origin: "core", subject: { type: "pr", id: root }, payload: expect.objectContaining({ repo: "octo/app", number: 1, base: "main" }) }),
    ]);
  });

  test("no repite el pedido mientras no se muevan la raíz ni main, y no pide nada si la raíz ya está al día", async () => {
    const { root } = stack();
    await staleRoots()(REPO, ["child"]);

    expect(await staleRoots()(REPO, ["child"])).toEqual([]);
    expect(conflicts()).toHaveLength(1);

    // El rebase pusheó: la raíz ya trae la punta de main.
    git("checkout", "-q", "-B", "root", "main");
    git("commit", "-q", "--allow-empty", "-m", "root rebased");
    store.db.update(pullRequests).set({ headSha: git("rev-parse", "HEAD") }).where(eq(pullRequests.id, root)).run();
    expect(await staleRoots()(REPO, ["child"])).toEqual([]);
  });

  test("sigue la base del PR cuando no hay fila de pr_parents, y no toca una raíz que el sistema no abrió", async () => {
    const m1 = git("rev-parse", "main");
    seedPr(store, { repoId: REPO, number: 1, headRef: "root", baseRef: "main", headSha: commitOn("root", m1), owned: false });
    seedPr(store, { repoId: REPO, number: 2, headRef: "child", baseRef: "root", headSha: commitOn("child", "root") });
    git("update-ref", "refs/remotes/origin/main", commitOn("main", m1));

    expect(await staleRoots()(REPO, ["child"])).toEqual([]);
    expect(conflicts()).toEqual([]);
  });
});

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Brief } from "@clanker/api";
import {
  createArtifacts,
  createBriefs,
  createLearnings,
  createStepBriefs,
  createWorkspaces,
  newId,
  openStore,
  type Learnings,
  type Store,
  type WorkspaceLease,
  type Workspaces,
} from "@clanker/core";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { tempGitRepo, type TempGitRepo } from "./git";

// Los learnings llegan al brief por el mismo camino que usa el motor (`createStepBriefs`), sobre un
// worktree real: lo que se prueba es qué entra, no cómo se arma `.clanker-run/`.

const runId = newId("run");
const projectId = newId("prj");

let dataDir: string;
let store: Store;
let repo: TempGitRepo;
let workspaces: Workspaces;
let learnings: Learnings;
let lease: WorkspaceLease;
let briefFor: ReturnType<typeof createStepBriefs>;

beforeEach(async () => {
  dataDir = mkdtempSync(join(tmpdir(), "clanker-learnings-brief-"));
  store = openStore({ path: ":memory:" });
  repo = tempGitRepo({ remote: true, commits: [{ message: "base", files: { "README.md": "# demo\n" } }] });
  workspaces = createWorkspaces({
    store,
    dataDir,
    repos: () => ({ path: repo.dir, defaultBranch: "main" }),
    identityOf: async () => ({ name: "Ana Pérez", email: "ana@example.com" }),
  });
  const artifacts = createArtifacts({ store, dir: join(dataDir, "artifacts") });
  learnings = createLearnings(store);
  briefFor = createStepBriefs({ store, workspaces, briefs: createBriefs({ workspaces, artifacts }), artifacts, issues: { get: () => undefined }, learnings, trackers: () => undefined, projects: { get: () => undefined } });
  lease = await workspaces.acquire({ repo: "r1", branch: "cla-1", base: "main", runId });
});

afterEach(() => {
  workspaces.release(lease);
  repo.cleanup();
  store.close();
  rmSync(dataDir, { recursive: true, force: true });
});

function brief(role = "dev", project: typeof projectId | undefined = projectId, proposesLearnings = false): Promise<Brief> {
  return briefFor({
    run: { id: runId, subject: { type: "pr", id: "1" }, round: 1, attempt: 1 },
    nodeId: "dev",
    visit: 1,
    mode: "implement",
    role,
    proposesLearnings,
    projectId: project,
    payload: {},
    lineage: [runId],
  });
}

const propose = (text: string, extra: { roles?: string[]; repoId?: string } = {}) =>
  learnings.propose({ ...(extra.repoId ? { repoId: extra.repoId as never } : { projectId }), text, roles: extra.roles ?? [], tags: [] }, "ui");
const approve = (text: string, extra?: Parameters<typeof propose>[1]) => learnings.approve(propose(text, extra).id, "ui");

describe("learnings en el brief", () => {
  test("uno propuesto no entra al brief", async () => {
    propose("Usa el helper existente antes de escribir uno nuevo");

    expect((await brief()).learnings).toBeUndefined();
  });

  test("uno aprobado entra, y uno rechazado o retirado después sale", async () => {
    const learning = approve("Usa el helper existente antes de escribir uno nuevo");

    expect((await brief()).learnings).toEqual(["Usa el helper existente antes de escribir uno nuevo"]);

    learnings.reject(learning.id, "ui");
    expect((await brief()).learnings).toBeUndefined();
  });

  test("entran a lo más 10, los del repo del worktree primero y luego los más recientes del proyecto", async () => {
    for (let i = 1; i <= 12; i++) approve(`del proyecto ${i}`);
    approve("del repo", { repoId: "r1" });

    const { learnings: entered } = await brief();

    expect(entered).toHaveLength(10);
    expect(entered?.[0]).toBe("del repo");
    expect(entered?.slice(1)).toEqual(Array.from({ length: 9 }, (_, i) => `del proyecto ${12 - i}`));
  });

  test("se filtran por el rol del paso y por el proyecto de la corrida", async () => {
    approve("para todos");
    approve("solo reviewers", { roles: ["review-bugs"] });

    expect((await brief("dev")).learnings).toEqual(["para todos"]);
    expect((await brief("review-bugs")).learnings).toEqual(["solo reviewers", "para todos"]);
    expect((await brief("dev", newId("prj"))).learnings).toBeUndefined();
  });

  test("quien propone ve también los propuestos pendientes del proyecto, y quien no, no", async () => {
    approve("aprobado");
    propose("pendiente");
    learnings.reject(propose("rechazado").id, "ui");

    expect((await brief("dev", projectId, true)).proposedLearnings).toEqual(["pendiente"]);
    expect((await brief("dev", projectId, false)).proposedLearnings).toBeUndefined();
  });
});

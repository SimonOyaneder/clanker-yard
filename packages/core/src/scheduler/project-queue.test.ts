import { NewProject, type PrRef, type PrState, type ProjectId } from "@clanker/api";
import { trackersByKind } from "../tracker/trackers";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { z } from "zod";
import { createDefs } from "../defs/defs";
import { createProjects, ProjectNotFoundError, type Projects } from "../projects/projects";
import { newId } from "../store/conventions";
import { pullRequests } from "../store/schema";
import { openStore, type Store } from "../store/store";
import { createIssues, type Issues } from "../tracker/issues";
import { createLocalTracker, type LocalTracker } from "../tracker/local";
import type { Tracker } from "../tracker/tracker";
import { createRepos, type Repos } from "../repos/repos";
import { createProjectQueue, QueueUnavailableError } from "./project-queue";

let store: Store;
let local: LocalTracker;
let issues: Issues;
let projects: Projects;
let repos: Repos;
let reads: PrRef[];
let readPr: (ref: PrRef) => Promise<PrState>;

beforeEach(() => {
  store = openStore({ path: ":memory:" });
  local = createLocalTracker(store);
  issues = createIssues(store, local);
  const defs = createDefs(store);
  defs.register("flow", z.unknown());
  defs.register("profile", z.unknown());
  projects = createProjects({ store, defs });
  repos = createRepos(store, { remote: (repo) => ({ url: `https://example.com/${repo}.git`, repo, account: "octocat" }) });
  reads = [];
  readPr = () => Promise.reject(new Error("no se esperaba leer un PR"));
});

afterEach(() => store.close());

/** Un tracker que falla si se le pide cualquier cosa salvo quién es la persona: la cola sale del caché. */
const strictTracker = (): Tracker => ({
  id: "local",
  capabilities: local.capabilities,
  viewer: () => local.viewer(),
  listProjects: () => Promise.reject(new Error("la cola no lista proyectos del tracker")),
  listIssues: () => Promise.reject(new Error("la cola no lista issues del tracker")),
  getIssue: () => Promise.reject(new Error("la cola no lee issues del tracker")),
  claim: () => Promise.reject(new Error("la cola no reclama")),
  setStatus: () => Promise.reject(new Error("la cola no cambia estados")),
  comment: () => Promise.reject(new Error("la cola no comenta")),
  changesSince: () => Promise.reject(new Error("la cola no sincroniza")),
});

const queueOf = () => createProjectQueue({ store, projects, issues, repos, trackers: trackersByKind({ local: strictTracker() }), prs: { get: (ref) => (reads.push(ref), readPr(ref)) } });

function createProject(stackOn: "ready" | "ci_green" | "any_open" = "ci_green", repoIds: string[] = []) {
  return projects.create(
    NewProject.parse({ slug: "demo", name: "Demo", tracker: "local", stackOn, repos: repoIds.map((repoId) => ({ repoId })) }),
    "cli",
  );
}

async function sync(projectId: ProjectId) {
  await issues.sync(local, { projectId, project: { tracker: "local", id: projectId } });
}

function openPr(issueId: string, repoId: string, number: number, headRef: string, detail?: PrState) {
  store.tx((tx) =>
    tx.db
      .insert(pullRequests)
      .values({ id: newId("pr"), repoId, number, nodeId: `n${number}`, headRef, baseRef: "main", headSha: "abc", state: "open", isDraft: true, issueId, owned: true, detail })
      .run(),
  );
}

const prState = (state: PrState["state"], ci: PrState["ci"]["state"]): PrState => ({
  key: "demo#1",
  title: "PR de prueba",
  url: "https://github.com/acme/demo/pull/1",
  updatedAt: "2026-11-10T12:00:00Z",
  additions: 0,
  deletions: 0,
  comments: 0,
  state,
  headRef: "x",
  headSha: "abc",
  baseRef: "main",
  baseIsDefault: true,
  mergeable: "clean",
  reviewDecision: "none",
  reviewers: [],
  approvers: [],
  bot: { state: "none", findings: [] },
  ci: { state: ci, sha: "abc", failing: [], flaky: [] },
  threads: { unresolved: 0, humanOpen: 0, humanResolved: 0, botOpen: 0, councilOpen: [], councilEver: false },
  talk: [],
  labels: [],
  signals: {},
  merge: { via: "button", ready: false, blockers: [], queue: null, offer: false, auto: false },
  hold: false,
});

describe("la cola de un proyecto", () => {
  test("sale del caché sin tocar el tracker, salvo para saber quién es la persona", async () => {
    const project = createProject();
    await local.createIssue(project.id, { title: "a", priority: 2 });
    await local.createIssue(project.id, { title: "b", priority: 1 });
    await sync(project.id);

    const entries = await queueOf().of(project.id);

    expect(entries.map((e) => [e.issue.title, e.state])).toEqual([
      ["b", "ready"],
      ["a", "ready"],
    ]);
  });

  test("un proyecto que no existe lanza ProjectNotFoundError y un tracker sin adapter, QueueUnavailableError", async () => {
    await expect(queueOf().of(newId("prj"))).rejects.toThrow(ProjectNotFoundError);
    const jira = projects.create(NewProject.parse({ slug: "j", name: "J", tracker: "jira", trackerRef: "J" }), "cli");

    await expect(queueOf().of(jira.id)).rejects.toThrow(QueueUnavailableError);
  });

  test("si el tracker no dice quién es la persona (sin cuenta conectada), QueueUnavailableError con su motivo", async () => {
    const project = createProject();
    const disconnected: Tracker = { ...strictTracker(), viewer: () => Promise.reject(new Error("No hay una cuenta de Linear conectada")) };
    const queue = createProjectQueue({ store, projects, issues, repos, trackers: trackersByKind({ local: disconnected }), prs: { get: readPr } });

    const failure = queue.of(project.id);
    await expect(failure).rejects.toThrow(QueueUnavailableError);
    await expect(failure).rejects.toThrow(/No se pudo leer tu usuario de local para calcular la cola de demo: No hay una cuenta de Linear conectada/);
  });

  describe("apilar sobre el PR del bloqueante", () => {
    async function blockedPair(stackOn: "ready" | "ci_green" | "any_open") {
      const repoA = repos.add({ name: "app", path: "/tmp/app", remote: "acme/app" });
      const repoB = repos.add({ name: "api", path: "/tmp/api", remote: "acme/api" });
      const project = createProject(stackOn, [repoA]);
      const parent = await local.createIssue(project.id, { title: "padre", status: "in_progress" });
      const child = await local.createIssue(project.id, { title: "hijo" });
      await local.relate(parent.ref, "blocks", child.ref);
      await sync(project.id);
      const cached = issues.list({ projectId: project.id });
      const parentId = cached.find((i) => i.title === "padre")!.id;
      return { project, repoA, repoB, parentId };
    }

    test("any_open apila sobre un PR abierto sin leer GitHub", async () => {
      const { project, repoA, parentId } = await blockedPair("any_open");
      openPr(parentId, repoA, 12, "cla-1-padre");

      const entries = await queueOf().of(project.id);

      expect(entries.map((e) => [e.issue.title, e.state])).toEqual([["hijo", "ready"]]);
      expect(entries[0]).toMatchObject({ base: { kind: "stacked", parent: { key: "app#12", branch: "cla-1-padre" } } });
      expect(reads).toEqual([]);
    });

    test("ci_green lee el CI del PR en GitHub", async () => {
      const { project, repoA, parentId } = await blockedPair("ci_green");
      openPr(parentId, repoA, 12, "cla-1-padre");
      readPr = async () => prState("draft", "green");

      const [entry] = await queueOf().of(project.id);

      expect(entry).toMatchObject({ state: "ready", base: { kind: "stacked", parent: { key: "app#12" } } });
      expect(reads).toEqual([{ account: "octocat", repo: "acme/app", number: 12 }]);
    });

    test("ci_green usa el estado que Watch dejó en el caché sin leer GitHub", async () => {
      const { project, repoA, parentId } = await blockedPair("ci_green");
      openPr(parentId, repoA, 12, "cla-1-padre", prState("draft", "green"));

      const [entry] = await queueOf().of(project.id);

      expect(entry).toMatchObject({ state: "ready", base: { kind: "stacked", parent: { key: "app#12" } } });
      expect(reads).toEqual([]);
    });

    test("ci_green con el CI rojo no apila", async () => {
      const { project, repoA, parentId } = await blockedPair("ci_green");
      openPr(parentId, repoA, 12, "cla-1-padre");
      readPr = async () => prState("draft", "red");

      const [entry] = await queueOf().of(project.id);

      expect(entry).toMatchObject({ state: "blocked", reason: expect.stringContaining("app#12 todavía no cumple stackOn ci_green") });
    });

    test("un PR que GitHub ya dio por mergeado o cerrado no cuenta como abierto", async () => {
      const { project, repoA, parentId } = await blockedPair("ci_green");
      openPr(parentId, repoA, 12, "cla-1-padre");
      readPr = async () => prState("merged", "green");

      const [entry] = await queueOf().of(project.id);

      expect(entry).toMatchObject({ state: "blocked", reason: expect.stringContaining("no tiene PR abierto") });
    });

    test("si GitHub no se puede leer, la cola lo dice en el motivo en vez de fallar", async () => {
      const { project, repoA, parentId } = await blockedPair("ci_green");
      openPr(parentId, repoA, 12, "cla-1-padre");
      readPr = () => Promise.reject(new Error("GitHub respondió 401"));

      const [entry] = await queueOf().of(project.id);

      expect(entry).toMatchObject({ state: "blocked", reason: expect.stringContaining("no se pudo leer el CI de app#12 (GitHub respondió 401)") });
    });

    test("un PR de otro repo no es base: depende de repo#n", async () => {
      const { project, repoB, parentId } = await blockedPair("ci_green");
      openPr(parentId, repoB, 7, "cla-1-padre");
      readPr = async () => prState("draft", "red");

      const [entry] = await queueOf().of(project.id);

      expect(entry).toMatchObject({ state: "ready", base: { kind: "default" }, dependsOn: ["api#7"] });
    });
  });
});

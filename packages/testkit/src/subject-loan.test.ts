import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { FlowDef, type RunId } from "@clanker/api";
import {
  createAgents,
  createArtifacts,
  createDefs,
  createFlows,
  createWorkspaces,
  openStore,
  workspaceAcquireAction,
  workspaceReleaseAction,
  type Flows,
  type Store,
  type Workspaces,
} from "@clanker/core";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { z } from "zod";
import { createFakeRuntime } from "./fake-runtime";
import { tempGitRepo, type TempGitRepo } from "./git";

// El préstamo del sujeto con Workspaces de verdad: la corrida de dev estacionada presta el PR y su
// worktree al rebase, y al devolverlos sigue con el token nuevo. Va aquí y no en el core por los repos git reales.

vi.setConfig({ testTimeout: 20_000 });

const demoFixtures = fileURLToPath(new URL("../fixtures/runs/demo", import.meta.url));
const PR = { type: "pr", id: "pr_1" } as const;

let dataDir: string;
let store: Store;
let repo: TempGitRepo;
let workspaces: Workspaces;
let flows: Flows;

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), "clanker-loan-"));
  repo = tempGitRepo({ remote: true });
  store = openStore({ path: ":memory:" });
  workspaces = createWorkspaces({
    store,
    dataDir,
    repos: () => ({ path: repo.dir, defaultBranch: "main" }),
    identityOf: async () => ({ name: "Ana Pérez", email: "ana@example.com" }),
  });
  const defs = createDefs(store);
  flows = createFlows({
    store,
    defs,
    agents: createAgents({ store, defs, runtime: createFakeRuntime({ fixtures: demoFixtures }) }),
    artifacts: createArtifacts({ store, dir: join(dataDir, "artifacts") }),
    roles: () => undefined,
    workspaceOf: workspaces.held,
    handOverWorkspaces: workspaces.handOver,
  });
  flows.registerAction(workspaceAcquireAction(workspaces));
  flows.registerAction(workspaceReleaseAction(workspaces));
  flows.registerAction({
    name: "pr.claim",
    args: z.object({}),
    outcomes: ["ok"],
    effects: "local",
    run: (_args, ctx) => {
      store.db.$client.prepare("UPDATE runs SET claimed_pr_id = ? WHERE id = ?").run(PR.id, ctx.runId);
      return Promise.resolve({ outcome: "ok" });
    },
  });
  flows.registerAction({
    name: "test.rebase",
    args: z.object({ ws: z.object({ workspaceId: z.string(), path: z.string(), branch: z.string(), fencingToken: z.int() }) }),
    outcomes: ["ok"],
    effects: "local",
    run: async ({ ws }) => {
      await workspaces.git(ws, "commit", "--allow-empty", "-m", "rebase del PR");
      return { outcome: "ok" };
    },
  });
  const acquire = { type: "action", action: "workspace.acquire", args: { repo: "r1", branch: "cla-1", base: "main" } } as const;
  flows.save(
    FlowDef.parse({
      schema: 1,
      id: "dev",
      name: "Dev",
      trigger: { type: "manual" },
      start: "ws",
      nodes: {
        ws: { ...acquire, on: { ok: "claim" } },
        claim: { type: "action", action: "pr.claim", args: {}, on: { ok: "ask" } },
        ask: { type: "gate", question: "¿Sigo?", options: [{ id: "go", label: "Seguir" }], on: { go: "release" } },
        release: {
          type: "action",
          action: "workspace.release",
          args: { workspaceId: "$ws.workspaceId", fencingToken: "$ws.fencingToken" },
          on: { ok: "@done" },
        },
      },
    }),
  );
  flows.save(
    FlowDef.parse({
      schema: 1,
      id: "rebase",
      name: "Rebase",
      trigger: { type: "pr.conflict" },
      start: "ws",
      nodes: {
        ws: { ...acquire, on: { ok: "rebase" } },
        rebase: { type: "action", action: "test.rebase", args: { ws: "$ws" }, on: { ok: "@done" } },
      },
    }),
  );
});

afterEach(async () => {
  await flows.close();
  store.close();
  repo.cleanup();
  rmSync(dataDir, { recursive: true, force: true });
});

const holder = () => (store.db.$client.prepare("SELECT holder_run_id AS run, fencing_token AS token FROM workspaces").get() as { run: string | null; token: number });

test("mantenimiento rebasea en el worktree de la dueña estacionada y ella sigue con el token nuevo", async () => {
  const owner = flows.start("dev", { type: "issue", id: "CLA-1" }, {}) as RunId;
  await vi.waitFor(() => expect(flows.getRun(owner)).toMatchObject({ status: "parked", parkReason: "gate" }));
  expect(holder()).toEqual({ run: owner, token: 1 });

  const borrower = flows.start("rebase", PR, {});
  await vi.waitFor(() => expect(flows.getRun(borrower)).toMatchObject({ status: "done", outcome: "done" }));

  // Volvió a la dueña con tres tomas más: el préstamo, el `workspace.acquire` de quien lo tuvo y la devolución.
  expect(holder()).toEqual({ run: owner, token: 4 });
  expect(repo.git("log", "-1", "--format=%s", "cla-1")).toBe("rebase del PR");

  // El `$ws` de la dueña guarda el token 1: `workspace.release` valida el vigente porque el motor lo actualiza al resolver el ref.
  const [decision] = store.db.$client.prepare("SELECT id FROM decisions WHERE run_id = ? AND status = 'pending'").all(owner) as { id: string }[];
  flows.resolveGate(decision!.id as never, "go", "ui");
  await vi.waitFor(() => expect(flows.getRun(owner)).toMatchObject({ status: "done", outcome: "done" }));
  expect(holder().run).toBeNull();
  expect(workspaces.held(owner)).toBeUndefined();
});

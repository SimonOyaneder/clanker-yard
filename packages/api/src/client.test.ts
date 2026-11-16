/// <reference types="node" />
import { createServer, type IncomingHttpHeaders, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { implement } from "@orpc/server";
import { RPCHandler } from "@orpc/server/node";
import { afterEach, expect, test } from "vitest";
import { type Event, contract, createClient } from "./index";

const ULID = "01J0000000000000000000000A";
const event = (seq: number): Event => ({
  seq,
  ts: 1_700_000_000_000 + seq,
  type: "run.started",
  origin: "core",
  runId: `run_${ULID}`,
  payload: {},
});

const os = implement(contract);
const router = os.router({
  system: {
    health: os.system.health.handler(() => ({
      coreVersion: "0.0.0",
      apiMajor: 1,
      schemaVersion: 1,
      bootId: "boot",
      activeRuns: 0,
      uiKey: false,
    })),
    info: os.system.info.handler(() => ({
      pid: 1,
      startedAt: 0,
      dataDir: "/tmp/clanker",
      platform: "linux" as const,
      linearClientId: "linear-client",
      githubApp: false,
    })),
    lanes: os.system.lanes.handler(() => ({ dev: { active: 0, capacity: 4 }, maintenance: { active: 0, capacity: 2 } })),
    setLanes: os.system.setLanes.handler(() => ({ dev: { active: 0, capacity: 4 }, maintenance: { active: 0, capacity: 2 } })),
    breakers: os.system.breakers.handler(() => []),
    shutdown: os.system.shutdown.handler(() => {}),
  },
  connections: {
    list: os.connections.list.handler(() => []),
    setPat: os.connections.setPat.handler(() => {
      throw new Error("no se usa en este test");
    }),
    githubPatForm: os.connections.githubPatForm.handler(() => ({
      url: "https://github.com/settings/tokens/new",
      scopes: ["repo"],
    })),
    startDeviceFlow: os.connections.startDeviceFlow.handler(() => {
      throw new Error("no se usa en este test");
    }),
    githubInstallations: os.connections.githubInstallations.handler(() => {
      throw new Error("no se usa en este test");
    }),
    linearAuth: os.connections.linearAuth.handler(() => {
      throw new Error("no se usa en este test");
    }),
    testClaude: os.connections.testClaude.handler(() => {
      throw new Error("no se usa en este test");
    }),
    setClaudeApiKey: os.connections.setClaudeApiKey.handler(() => {
      throw new Error("no se usa en este test");
    }),
    disconnect: os.connections.disconnect.handler(() => {}),
  },
  artifacts: {
    get: os.artifacts.get.handler(({ input }) => ({
      hash: input.hash,
      kind: "report" as const,
      mime: "text/plain",
      size: 2,
      content: new Blob(["ok"]),
    })),
  },
  issues: {
    list: os.issues.list.handler(() => []),
    get: os.issues.get.handler(() => {
      throw new Error("no se usa en este test");
    }),
    createLocal: os.issues.createLocal.handler(() => {
      throw new Error("no se usa en este test");
    }),
  },
  trackers: {
    projects: os.trackers.projects.handler(() => {
      throw new Error("no se usa en este test");
    }),
  },
  projects: {
    list: os.projects.list.handler(() => []),
    get: os.projects.get.handler(() => {
      throw new Error("no se usa en este test");
    }),
    create: os.projects.create.handler(() => {
      throw new Error("no se usa en este test");
    }),
    defaults: os.projects.defaults.handler(() => ({ defaultFlowId: null, defaultProfileId: null, parallel: 1, maxCostUsd: null })),
    setDefaults: os.projects.setDefaults.handler(() => {
      throw new Error("no se usa en este test");
    }),
    update: os.projects.update.handler(() => {
      throw new Error("no se usa en este test");
    }),
    exportConfig: os.projects.exportConfig.handler(() => {
      throw new Error("no se usa en este test");
    }),
    importConfig: os.projects.importConfig.handler(() => {
      throw new Error("no se usa en este test");
    }),
    pause: os.projects.pause.handler(() => {
      throw new Error("no se usa en este test");
    }),
    resume: os.projects.resume.handler(() => {
      throw new Error("no se usa en este test");
    }),
    skipIssue: os.projects.skipIssue.handler(() => {
      throw new Error("no se usa en este test");
    }),
    boostIssue: os.projects.boostIssue.handler(() => {
      throw new Error("no se usa en este test");
    }),
    queue: os.projects.queue.handler(() => {
      throw new Error("no se usa en este test");
    }),
    summary: os.projects.summary.handler(() => {
      throw new Error("no se usa en este test");
    }),
  },
  packs: {
    list: os.packs.list.handler(() => []),
    install: os.packs.install.handler(() => {
      throw new Error("no se usa en este test");
    }),
    remove: os.packs.remove.handler(() => {}),
  },
  prs: {
    get: os.prs.get.handler(() => {
      throw new Error("no se usa en este test");
    }),
    list: os.prs.list.handler(() => []),
    refresh: os.prs.refresh.handler(() => {
      throw new Error("no se usa en este test");
    }),
    setHold: os.prs.setHold.handler(() => {
      throw new Error("no se usa en este test");
    }),
    merge: os.prs.merge.handler(() => {
      throw new Error("no se usa en este test");
    }),
    requestReview: os.prs.requestReview.handler(() => {
      throw new Error("no se usa en este test");
    }),
    rebase: os.prs.rebase.handler(() => {
      throw new Error("no se usa en este test");
    }),
    republish: os.prs.republish.handler(() => ({ id: "rep_1", done: true, results: [] })),
    republishProgress: os.prs.republishProgress.handler(() => ({ id: "rep_1", done: true, results: [] })),
  },
  repos: {
    list: os.repos.list.handler(() => []),
    overview: os.repos.overview.handler(() => []),
    add: os.repos.add.handler(() => {
      throw new Error("no se usa en este test");
    }),
    detect: os.repos.detect.handler(() => []),
    testRecipe: os.repos.testRecipe.handler(() => {
      throw new Error("no se usa en este test");
    }),
    syncConfig: os.repos.syncConfig.handler(() => {
      throw new Error("no se usa en este test");
    }),
  },
  runs: {
    list: os.runs.list.handler(() => []),
    get: os.runs.get.handler(() => {
      throw new Error("no se usa en este test");
    }),
    step: os.runs.step.handler(() => {
      throw new Error("no se usa en este test");
    }),
    transcript: os.runs.transcript.handler(() => {
      throw new Error("no se usa en este test");
    }),
    start: os.runs.start.handler(() => {
      throw new Error("no se usa en este test");
    }),
    pause: os.runs.pause.handler(() => {
      throw new Error("no se usa en este test");
    }),
    resume: os.runs.resume.handler(() => {
      throw new Error("no se usa en este test");
    }),
    cancel: os.runs.cancel.handler(() => {
      throw new Error("no se usa en este test");
    }),
    interrupt: os.runs.interrupt.handler(() => {
      throw new Error("no se usa en este test");
    }),
    retryStep: os.runs.retryStep.handler(() => {
      throw new Error("no se usa en este test");
    }),
    steerStep: os.runs.steerStep.handler(() => {
      throw new Error("no se usa en este test");
    }),
    forceOutcome: os.runs.forceOutcome.handler(() => {
      throw new Error("no se usa en este test");
    }),
  },
  metrics: {
    byRole: os.metrics.byRole.handler(() => []),
    byDay: os.metrics.byDay.handler(() => []),
    byModel: os.metrics.byModel.handler(() => []),
    byStep: os.metrics.byStep.handler(() => []),
    byIssue: os.metrics.byIssue.handler(() => []),
  },
  imports: {
    legacy: os.imports.legacy.handler(() => {
      throw new Error("no se usa en este test");
    }),
  },
  defs: {
    list: os.defs.list.handler(() => []),
    get: os.defs.get.handler(() => {
      throw new Error("no se usa en este test");
    }),
    create: os.defs.create.handler(() => {
      throw new Error("no se usa en este test");
    }),
    update: os.defs.update.handler(() => {
      throw new Error("no se usa en este test");
    }),
    archive: os.defs.archive.handler(() => {
      throw new Error("no se usa en este test");
    }),
    restore: os.defs.restore.handler(() => {
      throw new Error("no se usa en este test");
    }),
    agentOptions: os.defs.agentOptions.handler(() => ({ runtimes: [] })),
    exportToRepo: os.defs.exportToRepo.handler(() => {
      throw new Error("no se usa en este test");
    }),

  },
  decisions: {
    list: os.decisions.list.handler(() => []),
    get: os.decisions.get.handler(() => {
      throw new Error("no se usa en este test");
    }),
    resolve: os.decisions.resolve.handler(() => {
      throw new Error("no se usa en este test");
    }),
  },
  learnings: {
    list: os.learnings.list.handler(() => []),
    get: os.learnings.get.handler(() => {
      throw new Error("no se usa en este test");
    }),
    propose: os.learnings.propose.handler(() => {
      throw new Error("no se usa en este test");
    }),
    approve: os.learnings.approve.handler(() => {
      throw new Error("no se usa en este test");
    }),
    reject: os.learnings.reject.handler(() => {
      throw new Error("no se usa en este test");
    }),
    update: os.learnings.update.handler(() => {
      throw new Error("no se usa en este test");
    }),
    screen: os.learnings.screen.handler(() => {
      throw new Error("no se usa en este test");
    }),
    archive: os.learnings.archive.handler(() => {
      throw new Error("no se usa en este test");
    }),
  },
  events: {
    list: os.events.list.handler(({ input }) => [event(input.after + 1), event(input.after + 2)]),
    stream: os.events.stream.handler(async function* ({ input }) {
      yield event((input.after ?? 0) + 1);
      yield event((input.after ?? 0) + 2);
    }),
  },
});

let server: Server;
let seenHeaders: IncomingHttpHeaders = {};

async function serve(): Promise<string> {
  const handler = new RPCHandler(router);
  server = createServer(async (req, res) => {
    seenHeaders = req.headers;
    const { matched } = await handler.handle(req, res, { prefix: "/rpc" });
    if (!matched) res.writeHead(404).end();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}/rpc`;
}

afterEach(() => new Promise((resolve) => server.close(resolve)));

test("el cliente manda el token y el origen en cada request", async () => {
  const client = createClient({ url: await serve(), token: "secreto", origin: "cli" });
  await client.system.health();
  expect(seenHeaders.authorization).toBe("Bearer secreto");
  expect(seenHeaders["x-clanker-origin"]).toBe("cli");
});

test("llama a los procedimientos con sus tipos y defaults", async () => {
  const client = createClient({ url: await serve(), token: "t", origin: "ui" });
  expect((await client.system.info()).platform).toBe("linux");
  expect(await client.system.shutdown({ drain: true })).toBeUndefined();
  const events = await client.events.list({ after: 10 });
  expect(events.map((e) => e.seq)).toEqual([11, 12]);
});

test("events.stream entrega los eventos como un async iterator", async () => {
  const client = createClient({ url: await serve(), token: "t", origin: "mcp" });
  const seqs: number[] = [];
  for await (const e of await client.events.stream({ after: 4 })) seqs.push(e.seq);
  expect(seqs).toEqual([5, 6]);
});

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
    })),
    info: os.system.info.handler(() => ({
      pid: 1,
      startedAt: 0,
      dataDir: "/tmp/clanker",
      platform: "linux" as const,
    })),
    shutdown: os.system.shutdown.handler(() => {}),
  },
  connections: {
    list: os.connections.list.handler(() => []),
    setPat: os.connections.setPat.handler(() => {
      throw new Error("no se usa en este test");
    }),
    githubPatForm: os.connections.githubPatForm.handler(() => ({
      url: "https://github.com/settings/personal-access-tokens/new",
      permissions: [],
    })),
    linearAuth: os.connections.linearAuth.handler(() => {
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
  projects: {
    list: os.projects.list.handler(() => []),
    get: os.projects.get.handler(() => {
      throw new Error("no se usa en este test");
    }),
    create: os.projects.create.handler(() => {
      throw new Error("no se usa en este test");
    }),
    update: os.projects.update.handler(() => {
      throw new Error("no se usa en este test");
    }),
  },
  prs: {
    get: os.prs.get.handler(() => {
      throw new Error("no se usa en este test");
    }),
  },
  repos: {
    list: os.repos.list.handler(() => []),
    add: os.repos.add.handler(() => {
      throw new Error("no se usa en este test");
    }),
    detect: os.repos.detect.handler(() => []),
    testRecipe: os.repos.testRecipe.handler(() => {
      throw new Error("no se usa en este test");
    }),
  },
  runs: {
    list: os.runs.list.handler(() => []),
    get: os.runs.get.handler(() => {
      throw new Error("no se usa en este test");
    }),
    start: os.runs.start.handler(() => {
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

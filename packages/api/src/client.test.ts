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

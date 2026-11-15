import { request } from "node:http";
import { API_MAJOR, type Event, contract, createClient } from "@clanker/api";
import { createORPCClient } from "@orpc/client";
import { RPCLink } from "@orpc/client/fetch";
import type { ContractRouterClient } from "@orpc/contract";
import { createRouterClient, getEventMeta } from "@orpc/server";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { readSchemaVersion } from "../store/migrate";
import { openStore, type Store } from "../store/store";
import { startServer, type CoreServer } from "./server";

let store: Store;
let server: CoreServer | undefined;
const onShutdown = vi.fn();

beforeEach(() => {
  store = openStore({ path: ":memory:" });
});

afterEach(async () => {
  await server?.close();
  server = undefined;
  store.close();
  onShutdown.mockReset();
});

async function start(allowedOrigins?: string[]): Promise<CoreServer> {
  server = await startServer({
    store,
    coreVersion: "1.2.3",
    dataDir: "/tmp/clanker",
    onShutdown,
    allowedOrigins,
  });
  return server;
}

function emit(count: number): void {
  for (let i = 0; i < count; i++) {
    store.tx((tx) => tx.emit({ type: "core.started", origin: "core", payload: { i } }));
  }
}

/** Una request cruda: `fetch` no deja pisar el Host. */
function rawHealth(
  core: CoreServer,
  headers: Record<string, string | undefined>,
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = request(
      core.url.replace("/rpc", "/rpc/system/health"),
      { method: "POST", headers: definedOnly(headers) },
      (res) => {
        let body = "";
        res.on("data", (chunk) => (body += chunk));
        res.on("end", () => resolve({ status: res.statusCode ?? 0, body }));
      },
    );
    req.on("error", reject);
    req.end();
  });
}

function definedOnly(headers: Record<string, string | undefined>): Record<string, string> {
  return Object.fromEntries(
    Object.entries(headers).flatMap(([name, value]) =>
      value === undefined ? [] : [[name, value]],
    ),
  );
}

describe("auth", () => {
  const valid = (core: CoreServer) => ({
    host: `127.0.0.1:${core.port}`,
    authorization: `Bearer ${core.token}`,
    "x-clanker-origin": "cli",
  });

  test("una request sin token o con otro token da 401", async () => {
    const core = await start();
    const noToken = { ...valid(core), authorization: undefined };
    expect((await rawHealth(core, noToken)).status).toBe(401);
    expect((await rawHealth(core, { ...noToken, authorization: "Bearer otro" })).status).toBe(401);
    expect((await rawHealth(core, valid(core))).status).toBe(200);
  });

  test("rechaza un Host que no sea 127.0.0.1:<puerto>, aunque traiga el token", async () => {
    const core = await start();
    const { status } = await rawHealth(core, { ...valid(core), host: `evil.example:${core.port}` });
    expect(status).toBe(403);
  });

  test("rechaza un Origin ajeno y deja pasar el de la app", async () => {
    const core = await start(["app://clanker"]);
    expect((await rawHealth(core, { ...valid(core), origin: "https://evil.example" })).status).toBe(
      403,
    );
    expect((await rawHealth(core, { ...valid(core), origin: "app://clanker" })).status).toBe(200);
  });

  test("exige x-clanker-origin con un cliente válido", async () => {
    const core = await start();
    const headers = valid(core);
    expect((await rawHealth(core, { ...headers, "x-clanker-origin": undefined })).status).toBe(400);
    expect((await rawHealth(core, { ...headers, "x-clanker-origin": "watch" })).status).toBe(400);
  });

  test("el puerto es aleatorio y el token cambia en cada arranque", async () => {
    const first = await start();
    const { token } = first;
    await first.close();
    const second = await start();
    expect(second.token).not.toBe(token);
    expect(Buffer.from(second.token, "base64url")).toHaveLength(32);
    expect(second.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/rpc$/);
  });
});

describe("system", () => {
  test("health informa versión, schema y bootId", async () => {
    const core = await start();
    const client = createClient({ url: core.url, token: core.token, origin: "ui" });
    expect(await client.system.health()).toEqual({
      coreVersion: "1.2.3",
      apiMajor: API_MAJOR,
      schemaVersion: readSchemaVersion(store.db.$client),
      bootId: core.bootId,
      activeRuns: 0,
    });
    expect((await client.system.info()).pid).toBe(process.pid);
  });

  test("shutdown deja un core.stopping con el origen de la llamada y avisa a quien lanzó el core", async () => {
    const core = await start();
    const client = createClient({ url: core.url, token: core.token, origin: "cli" });
    await client.system.shutdown({ drain: true });
    expect(onShutdown).toHaveBeenCalledWith({ drain: true });
    expect(store.events.since(0).map((e) => [e.type, e.origin])).toEqual([
      ["core.stopping", "cli"],
    ]);
  });
});

describe("events", () => {
  test("list filtra por tipo y respeta after y limit", async () => {
    const core = await start();
    emit(3);
    store.tx((tx) =>
      tx.emit({
        type: "run.status",
        origin: "ui",
        subject: { type: "issue", id: "CLA-10" },
        payload: {},
      }),
    );
    const client = createClient({ url: core.url, token: core.token, origin: "ui" });

    const started = await client.events.list({ after: 1, limit: 1 });
    expect(started.map((e) => e.seq)).toEqual([2]);
    const status = await client.events.list({ filter: { types: ["run.status"] } });
    expect(status).toMatchObject([
      { seq: 4, origin: "ui", subject: { type: "issue", id: "CLA-10" } },
    ]);
  });

  /** Un cliente que reconecta manda el `Last-Event-ID` del último mensaje que vio. */
  function clientResumingFrom(core: CoreServer, lastEventId?: string) {
    const link = new RPCLink({
      url: core.url,
      headers: {
        authorization: `Bearer ${core.token}`,
        "x-clanker-origin": "ui",
        ...(lastEventId === undefined ? {} : { "last-event-id": lastEventId }),
      },
    });
    return createORPCClient<ContractRouterClient<typeof contract>>(link);
  }

  async function take(stream: AsyncIterable<Event>, count: number): Promise<Event[]> {
    const taken: Event[] = [];
    for await (const event of stream) {
      taken.push(event);
      if (taken.length === count) break;
    }
    return taken;
  }

  test("un cliente que reconecta con lastEventId recibe justo los eventos que le faltaban", async () => {
    const core = await start();
    emit(3);

    const first = await take(await clientResumingFrom(core).events.stream({}), 3);
    expect(first.map((e) => getEventMeta(e)?.id)).toEqual(["1", "2", "3"]);

    // La UI estaba desconectada mientras se confirmaban el 4 y el 5.
    emit(2);
    const resumed = await clientResumingFrom(core, "3").events.stream({});
    const seen: number[] = [];
    for await (const event of resumed) {
      seen.push(event.seq);
      if (event.seq === 5) emit(2); // en vivo: llegan después del relleno
      if (seen.length === 4) break;
    }
    expect(seen).toEqual([4, 5, 6, 7]);
  });

  test("lastEventId manda sobre after, y after sirve en la primera conexión", async () => {
    const core = await start();
    emit(4);
    expect(
      (await take(await clientResumingFrom(core).events.stream({ after: 2 }), 2)).map((e) => e.seq),
    ).toEqual([3, 4]);
    expect(
      (await take(await clientResumingFrom(core, "3").events.stream({ after: 0 }), 1)).map(
        (e) => e.seq,
      ),
    ).toEqual([4]);
  });

  test("un lastEventId que no es un número de evento es un BAD_REQUEST", async () => {
    const core = await start();
    const stream = await clientResumingFrom(core, "abc").events.stream({});
    await expect(stream.next()).rejects.toMatchObject({
      code: "BAD_REQUEST",
    });
  });

  test("el stream respeta el filtro y no repite eventos entre el relleno y lo en vivo", async () => {
    const core = await start();
    emit(1);
    store.tx((tx) => tx.emit({ type: "run.status", origin: "core", payload: {} }));
    const stream = await clientResumingFrom(core).events.stream({
      filter: { types: ["core.started"] },
    });

    const seen: number[] = [];
    for await (const event of stream) {
      seen.push(event.seq);
      if (seen.length === 1) {
        store.tx((tx) => tx.emit({ type: "run.status", origin: "core", payload: {} }));
        emit(1);
      }
      if (seen.length === 2) break;
    }
    expect(seen).toEqual([1, 4]);
  });
});

describe("en proceso", () => {
  test("createRouterClient usa el mismo router y contexto que HTTP", async () => {
    const core = await start();
    const inProcess = createRouterClient(core.router, { context: { origin: "mcp" } });

    expect((await inProcess.system.health()).bootId).toBe(core.bootId);
    await inProcess.system.shutdown({ drain: false });
    expect(store.events.since(0)).toMatchObject([{ type: "core.stopping", origin: "mcp" }]);
    expect(onShutdown).toHaveBeenCalledWith({ drain: false });

    const seqs: number[] = [];
    for await (const event of await inProcess.events.stream({})) {
      seqs.push(event.seq);
      break;
    }
    expect(seqs).toEqual([1]);
  });
});

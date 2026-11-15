import { createServer, type IncomingHttpHeaders, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, test } from "vitest";
import { createCoreProxy, windowCoreState } from "./core-proxy";

// Un "core" mínimo: guarda lo que le llega y responde lo que le diga cada test.
let server: Server | undefined;
afterEach(() => {
  server?.closeAllConnections();
  server?.close();
  server = undefined;
});

interface Seen {
  method?: string;
  url?: string;
  headers: IncomingHttpHeaders;
  body: string;
}

async function fakeCore(respond: (res: ServerResponse) => void): Promise<{ port: number; seen: Seen[] }> {
  const seen: Seen[] = [];
  server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      seen.push({ method: req.method, url: req.url, headers: req.headers, body: Buffer.concat(chunks).toString() });
      respond(res);
    });
  });
  await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", resolve));
  return { port: (server.address() as AddressInfo).port, seen };
}

const request = (path: string, init: RequestInit = {}) => new Request(`clanker-core://core${path}`, init);

describe("createCoreProxy", () => {
  test("agrega el token, el origin de la UI y la ruta, y descarta el Origin del navegador", async () => {
    const { port, seen } = await fakeCore((res) => res.writeHead(200, { "content-type": "application/json" }).end('{"ok":true}'));
    const proxy = createCoreProxy({ endpoint: () => ({ port, token: "tok" }) });

    const res = await proxy(
      request("/rpc/runs/get?x=1", {
        method: "POST",
        headers: { "content-type": "application/json", "x-clanker-origin": "ui", authorization: "Bearer falso", origin: "http://localhost:8890" },
        body: '{"json":{"id":"run_1"}}',
      }),
    );

    expect(await res.json()).toEqual({ ok: true });
    expect(res.headers.get("access-control-allow-origin")).toBe("*");
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({ method: "POST", url: "/rpc/runs/get?x=1", body: '{"json":{"id":"run_1"}}' });
    expect(seen[0]!.headers).toMatchObject({ authorization: "Bearer tok", "x-clanker-origin": "ui", "content-type": "application/json" });
    expect(seen[0]!.headers.origin).toBeUndefined();
  });

  test("contesta el preflight sin tocar el core", async () => {
    const { port, seen } = await fakeCore((res) => res.end());
    const proxy = createCoreProxy({ endpoint: () => ({ port, token: "tok" }) });

    const res = await proxy(request("/rpc/projects/list", { method: "OPTIONS", headers: { "access-control-request-headers": "authorization, x-clanker-origin" } }));

    expect(res.status).toBe(204);
    expect(res.headers.get("access-control-allow-headers")).toBe("authorization, x-clanker-origin");
    expect(seen).toEqual([]);
  });

  test("con el core caído responde 503 con un mensaje, y 502 si el puerto ya no escucha", async () => {
    const down = await createCoreProxy({ endpoint: () => undefined })(request("/rpc/projects/list", { method: "POST" }));
    expect(down.status).toBe(503);
    expect(await down.text()).toMatch(/core no está disponible/);

    const { port } = await fakeCore((res) => res.end());
    server!.close();
    const gone = await createCoreProxy({ endpoint: () => ({ port, token: "tok" }) })(request("/rpc/projects/list", { method: "POST" }));
    expect(gone.status).toBe(502);
  });

  test("un stream llega por partes y abortar la llamada cierra la conexión con el core", async () => {
    let closed!: () => void;
    const upstreamClosed = new Promise<void>((resolve) => (closed = resolve));
    const { port } = await fakeCore((res) => {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write("data: uno\n\n");
      res.on("close", closed);
    });
    const proxy = createCoreProxy({ endpoint: () => ({ port, token: "tok" }) });
    const abort = new AbortController();

    const res = await proxy(request("/rpc/events/stream", { method: "POST", signal: abort.signal }));
    const reader = res.body!.getReader();
    const first = await reader.read();

    // El core todavía no cerró: el primer evento llegó sin esperar al final de la respuesta.
    expect(new TextDecoder().decode(first.value)).toBe("data: uno\n\n");
    abort.abort();
    await reader.cancel().catch(() => {});
    await upstreamClosed;
  });
});

describe("windowCoreState", () => {
  test("al core vivo le saca el token, el puerto y el bootId: la ventana solo sabe que está vivo", () => {
    const live = { status: "live", version: "1.2.3", port: 4321, token: "secreto", bootId: "boot_1" } as const;
    expect(windowCoreState(live)).toStrictEqual({ status: "live", version: "1.2.3" });
    expect(windowCoreState({ status: "down", reason: "salió" })).toStrictEqual({ status: "down", reason: "salió" });
  });
});

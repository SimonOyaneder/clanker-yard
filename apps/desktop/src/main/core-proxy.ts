import type { CoreState as WindowCoreState } from "@clanker/ui";
import type { CoreState } from "./core-supervisor";

/** Esquema por el que la ventana habla con el core: `clanker-core://core/rpc` es el `url` de `createClient`. */
export const CORE_SCHEME = "clanker-core";

/** Lo que la ventana sabe del core: si está vivo y su versión. El token y el puerto solo los usa este proxy. */
export function windowCoreState(state: CoreState): WindowCoreState {
  return state.status === "live" ? { status: "live", version: state.version } : state;
}

export interface CoreEndpoint {
  port: number;
  token: string;
}

// Lo único que la ventana puede mandarle al core. El resto (Origin, Referer, Host...) lo pone este proxy
// o se descarta: el core rechaza cualquier Origin de navegador.
const FORWARDED = ["content-type", "accept", "x-clanker-origin", "last-event-id"];

const cors = (request: Request): Record<string, string> => ({
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET, POST, OPTIONS",
  "access-control-allow-headers": request.headers.get("access-control-request-headers") ?? "content-type, x-clanker-origin, last-event-id",
});

const text = (request: Request, status: number, message: string) =>
  new Response(message, { status, headers: { "content-type": "text/plain; charset=utf-8", ...cors(request) } });

/**
 * Lleva las llamadas de la ventana al core local. La ventana no habla con `127.0.0.1:<puerto>` directo:
 * el core no sirve CORS y cada arranque tiene otro puerto y otro token, así que el token se queda en el
 * main (el renderer nunca lo ve) y el puerto se lee del estado del core en cada llamada. Los streams de
 * eventos pasan tal cual y abortar la llamada cierra la conexión con el core.
 */
export function createCoreProxy(opts: { endpoint(): CoreEndpoint | undefined; fetch?: typeof fetch }): (request: Request) => Promise<Response> {
  const send = opts.fetch ?? fetch;

  return async (request) => {
    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: { ...cors(request), "access-control-max-age": "600" } });

    const endpoint = opts.endpoint();
    if (!endpoint) return text(request, 503, "El core no está disponible: la app lo está levantando o cayó.");

    const incoming = new URL(request.url);
    const headers = new Headers({ authorization: `Bearer ${endpoint.token}` });
    for (const name of FORWARDED) {
      const value = request.headers.get(name);
      if (value !== null) headers.set(name, value);
    }
    const hasBody = request.method !== "GET" && request.method !== "HEAD";
    try {
      const upstream = await send(`http://127.0.0.1:${endpoint.port}${incoming.pathname}${incoming.search}`, {
        method: request.method,
        headers,
        body: hasBody ? await request.arrayBuffer() : undefined,
        signal: request.signal,
      });
      const reply = new Headers(cors(request));
      for (const name of ["content-type", "cache-control"]) {
        const value = upstream.headers.get(name);
        if (value !== null) reply.set(name, value);
      }
      return new Response(upstream.body, { status: upstream.status, headers: reply });
    } catch (error) {
      if (request.signal.aborted) throw error;
      return text(request, 502, `No pude hablar con el core: ${error instanceof Error ? error.message : String(error)}`);
    }
  };
}

/**
 * Lo que el runtime usa de la API de opencode 2 (`/api/...`, `docs/openapi.json` de opencode.ai): crear una sesión,
 * mandarle un mensaje, interrumpirla, leerla, listar modelos y seguir sus eventos. Los tipos son el subconjunto que el
 * adapter lee, copiados de esa spec (2.3.0) y comprobados contra el servidor real (`opencode-live.test.ts`).
 */

export interface TokenUsage {
  input: number;
  output: number;
  reasoning: number;
  cache: { read: number; write: number };
}

/** El error de un paso, una ejecución o un reintento. `status` es el HTTP del proveedor cuando lo hay. */
export interface OpencodeError {
  type: string;
  message: string;
  status?: number;
  retryAfterMs?: number;
}

export interface ModelRef {
  providerID: string;
  id: string;
  variant?: string;
}

/** Los eventos de `/api/event` que el adapter usa; los demás llegan con su `type` y se ignoran. */
export type OpencodeEvent =
  | { type: "session.execution.started" | "session.execution.succeeded"; data: { sessionID: string } }
  | { type: "session.execution.failed"; data: { sessionID: string; error: OpencodeError } }
  | { type: "session.execution.interrupted"; data: { sessionID: string; reason: "user" | "shutdown" | "superseded" | "inactivity" } }
  | { type: "session.step.started"; data: { sessionID: string; assistantMessageID: string; model: ModelRef } }
  | { type: "session.step.first-token"; data: { sessionID: string } }
  | { type: "session.step.ended"; data: { sessionID: string; assistantMessageID: string; finish: string; cost: number; tokens: TokenUsage } }
  | { type: "session.step.failed"; data: { sessionID: string; assistantMessageID: string; error: OpencodeError; cost?: number; tokens?: TokenUsage } }
  | { type: "session.tool.input.started"; data: { sessionID: string; id: string; name: string } }
  | { type: "session.tool.called"; data: { sessionID: string; id: string; input: Record<string, unknown> } }
  | { type: "session.tool.success" | "session.tool.failed"; data: { sessionID: string; id: string; content?: ToolContent[]; error?: OpencodeError } }
  | { type: "session.text.ended" | "session.reasoning.ended"; data: { sessionID: string; text: string } }
  | { type: "session.compaction.ended"; data: { sessionID: string; reason: string; model: ModelRef; cost: number; tokens: TokenUsage } }
  | { type: "session.retry.scheduled"; data: { sessionID: string; attempt: number; at: number; error: OpencodeError } }
  | { type: "permission.asked"; data: { sessionID: string; action: string; resources: string[] } }
  | { type: "form.created"; data: { form: { sessionID: string; title: string } } }
  | { type: "other"; data: Record<string, unknown> };

export type ToolContent = { type: "text"; text: string } | { type: string; [key: string]: unknown };

export interface SessionInfo {
  id: string;
  outcome?: "succeeded" | "failed" | "interrupted";
  cost: number;
  tokens: TokenUsage;
  time: { created: number; updated: number; busy?: number; idle?: number };
}

export interface ModelInfo {
  id: string;
  modelID?: string;
  providerID: string;
  variants?: { id: string }[];
}

export interface OpencodeApi {
  createSession(input: { directory: string; agent: string; model: ModelRef; title: string }): Promise<{ id: string }>;
  /** Encola el mensaje y vuelve: el agente corre después y su fin llega por eventos (`session.execution.*`). */
  prompt(input: { sessionID: string; text: string }): Promise<void>;
  interrupt(sessionID: string): Promise<void>;
  session(sessionID: string): Promise<SessionInfo>;
  models(directory: string): Promise<ModelInfo[]>;
  /** Los eventos del servidor hasta que `signal` se aborte. Solo en vivo: sin repetición ni reconexión. */
  events(signal: AbortSignal): AsyncIterable<OpencodeEvent>;
}

/** Una llamada que el servidor rechazó, con su estado y su `_tag`/mensaje. */
export class OpencodeApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

/** El cliente HTTP de un `opencode serve` con contraseña (`OPENCODE_PASSWORD`; el usuario siempre es `opencode`). */
export function createOpencodeApi({ url, password }: { url: string; password: string }): OpencodeApi {
  const headers = { authorization: `Basic ${Buffer.from(`opencode:${password}`).toString("base64")}` };

  async function call<T>(what: string, method: string, path: string, body?: unknown): Promise<T> {
    const response = await fetch(new URL(path, url), {
      method,
      headers: body === undefined ? headers : { ...headers, "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await response.text();
    if (!response.ok) throw new OpencodeApiError(`opencode serve rechazó ${what} (${response.status}): ${text.slice(0, 500)}`, response.status);
    return (text === "" ? undefined : JSON.parse(text)) as T;
  }

  return {
    async createSession({ directory, agent, model, title }) {
      const { data } = await call<{ data: { id: string } }>("crear la sesión", "POST", "/api/session", { location: { directory }, agent, model, title });
      return { id: data.id };
    },
    async prompt({ sessionID, text }) {
      await call("el mensaje", "POST", `/api/session/${encodeURIComponent(sessionID)}/prompt`, { text });
    },
    async interrupt(sessionID) {
      await call("la interrupción", "POST", `/api/session/${encodeURIComponent(sessionID)}/interrupt`, {});
    },
    async session(sessionID) {
      return (await call<{ data: SessionInfo }>("leer la sesión", "GET", `/api/session/${encodeURIComponent(sessionID)}`)).data;
    },
    async models(directory) {
      const query = new URLSearchParams({ "location.directory": directory });
      return (await call<{ data: ModelInfo[] }>("listar los modelos", "GET", `/api/model?${query.toString()}`)).data;
    },
    async *events(signal) {
      const response = await fetch(new URL("/api/event", url), { headers, signal });
      if (!response.ok || !response.body) throw new OpencodeApiError(`opencode serve rechazó los eventos (${response.status})`, response.status);
      yield* parseSse(response.body, signal);
    },
  };
}

/** Un stream SSE de opencode: cada bloque trae una línea `data:` con `{ type, data }`. Lo que no se lee se salta. */
export async function* parseSse(body: AsyncIterable<Uint8Array>, signal?: AbortSignal): AsyncGenerator<OpencodeEvent> {
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    for await (const chunk of body) {
      buffer += decoder.decode(chunk, { stream: true });
      for (let end = buffer.indexOf("\n\n"); end !== -1; end = buffer.indexOf("\n\n")) {
        const block = buffer.slice(0, end);
        buffer = buffer.slice(end + 2);
        const data = block
          .split("\n")
          .filter((line) => line.startsWith("data:"))
          .map((line) => line.slice(5).trimStart())
          .join("\n");
        if (data === "") continue;
        let event: unknown;
        try {
          event = JSON.parse(data);
        } catch {
          continue;
        }
        if (typeof event === "object" && event !== null && typeof (event as { type?: unknown }).type === "string") yield event as OpencodeEvent;
      }
    }
  } catch (error) {
    // Abortar el `signal` corta el stream: es el fin normal, no un error.
    if (signal?.aborted) return;
    throw error;
  }
}

import { createEventQueue } from "../event-queue";
import type { ModelInfo, ModelRef, OpencodeApi, OpencodeError, OpencodeEvent, SessionInfo, TokenUsage } from "./api";
import { REPORT_TOOL } from "./config";
import type { LaunchInput, LaunchServer } from "./server";

// Un opencode 2 falso para los tests del runtime: responde con la secuencia de eventos vista en sesiones reales de
// opencode 2.3 (`execution.started`, por paso `step.started`, `first-token`, herramientas `input.started` → `called` →
// `success`, `text.ended`, `step.ended` con costo y tokens, y `execution.succeeded`) y falla como él (el error en
// `execution.failed`; un reintento es `retry.scheduled`; interrumpir da `execution.interrupted` con `user`).

const NO_TOKENS: TokenUsage = { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } };

export const ev = {
  started: (sessionID: string): OpencodeEvent => ({ type: "session.execution.started", data: { sessionID } }),
  succeeded: (sessionID: string): OpencodeEvent => ({ type: "session.execution.succeeded", data: { sessionID } }),
  failed: (sessionID: string, error: OpencodeError): OpencodeEvent => ({ type: "session.execution.failed", data: { sessionID, error } }),
  interrupted: (sessionID: string, reason: "user" | "shutdown" = "user"): OpencodeEvent => ({ type: "session.execution.interrupted", data: { sessionID, reason } }),
  stepStarted: (sessionID: string, message: string, model: ModelRef = { providerID: "openai", id: "gpt-6.1-terra", variant: "default" }): OpencodeEvent => ({
    type: "session.step.started",
    data: { sessionID, assistantMessageID: message, model },
  }),
  firstToken: (sessionID: string): OpencodeEvent => ({ type: "session.step.first-token", data: { sessionID } }),
  stepEnded: (sessionID: string, message: string, finish: string, cost = 0, tokens: TokenUsage = NO_TOKENS): OpencodeEvent => ({
    type: "session.step.ended",
    data: { sessionID, assistantMessageID: message, finish, cost, tokens },
  }),
  tool: (sessionID: string, id: string, name: string, input: Record<string, unknown>, output = "salida"): OpencodeEvent[] => [
    { type: "session.tool.input.started", data: { sessionID, id, name } },
    { type: "session.tool.called", data: { sessionID, id, input } },
    { type: "session.tool.success", data: { sessionID, id, content: [{ type: "text", text: output }] } },
  ],
  text: (sessionID: string, text: string): OpencodeEvent => ({ type: "session.text.ended", data: { sessionID, text } }),
  retry: (sessionID: string, attempt: number, error: OpencodeError): OpencodeEvent => ({ type: "session.retry.scheduled", data: { sessionID, attempt, at: 0, error } }),
};

/** Lo que el agente falso hace con un mensaje: emite eventos y puede morir. */
export interface FakeServer {
  sessionID: string;
  emit(...events: OpencodeEvent[]): void;
  /** El proceso muere solo. */
  crash(reason: string): void;
}

export interface FakeOpencode {
  launch: LaunchServer;
  api: () => OpencodeApi;
  launches: LaunchInput[];
  created: { directory: string; agent: string; model: ModelRef; title: string }[];
  prompts: { sessionID: string; text: string }[];
  interrupted: string[];
  closed: () => number;
}

/** `onPrompt` es el agente: recibe el mensaje y el servidor. `models` es lo que lista `/api/model`. */
export function createFakeOpencode(onPrompt: (text: string, server: FakeServer) => void | Promise<void>, models: ModelInfo[] = []): FakeOpencode {
  const launches: LaunchInput[] = [];
  const created: FakeOpencode["created"] = [];
  const prompts: FakeOpencode["prompts"] = [];
  const interrupted: string[] = [];
  let closed = 0;
  let sessions = 0;
  let current: { events: ReturnType<typeof createEventQueue<OpencodeEvent>>; crash: (reason: string) => void } | undefined;

  const launch: LaunchServer = async (input) => {
    launches.push(input);
    let crash!: (reason: string) => void;
    const exited = new Promise<string>((resolve) => (crash = resolve));
    current = { events: createEventQueue<OpencodeEvent>(), crash };
    return {
      url: "http://127.0.0.1:52601",
      output: () => "",
      exited,
      close: () => {
        closed += 1;
        current?.events.close();
      },
    };
  };

  const api = (): OpencodeApi => {
    const server = current!;
    const fake = (sessionID: string): FakeServer => ({
      sessionID,
      emit: (...events) => events.forEach((e) => server.events.push(e)),
      crash: (reason) => server.crash(reason),
    });
    return {
      async createSession(input) {
        created.push(input);
        return { id: `ses_${++sessions}` };
      },
      async prompt({ sessionID, text }) {
        prompts.push({ sessionID, text });
        // Como opencode: encola el mensaje y el agente corre después.
        setImmediate(() => void onPrompt(text, fake(sessionID)));
      },
      async interrupt(sessionID) {
        interrupted.push(sessionID);
        server.events.push(ev.interrupted(sessionID));
      },
      async session(sessionID): Promise<SessionInfo> {
        return { id: sessionID, cost: 0, tokens: NO_TOKENS, time: { created: 0, updated: 0 } };
      },
      async models() {
        return models;
      },
      async *events(signal) {
        // Como `fetch`: abortar el `signal` corta el stream.
        signal.addEventListener("abort", () => server.events.close(), { once: true });
        yield* server.events;
      },
    };
  };

  return { launch, api, launches, created, prompts, interrupted, closed: () => closed };
}

/** La respuesta típica de un paso: lee un archivo, entrega el reporte con `clanker_report`, y la ejecución termina bien. */
export function answer(server: FakeServer, report: unknown, cost = 0.01): void {
  const s = server.sessionID;
  server.emit(
    ev.started(s),
    ev.stepStarted(s, "msg_1"),
    ev.firstToken(s),
    ...ev.tool(s, "call_1", "read", { path: "a.ts" }),
    ...ev.tool(s, "call_2", REPORT_TOOL, report as Record<string, unknown>, "Reporte recibido."),
    ev.stepEnded(s, "msg_1", "tool-calls", cost, { input: 100, output: 40, reasoning: 10, cache: { read: 1000, write: 0 } }),
    ev.stepStarted(s, "msg_2"),
    ev.text(s, "Listo."),
    ev.stepEnded(s, "msg_2", "stop"),
    ev.succeeded(s),
  );
}

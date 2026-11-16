import { expect, test } from "vitest";
import { parseSse, type OpencodeEvent } from "./api";

async function collect(chunks: string[]): Promise<OpencodeEvent[]> {
  const encoder = new TextEncoder();
  async function* body() {
    for (const chunk of chunks) yield encoder.encode(chunk);
  }
  const out: OpencodeEvent[] = [];
  for await (const event of parseSse(body())) out.push(event);
  return out;
}

test("lee cada bloque data: aunque llegue partido entre chunks, y salta lo que no es un evento", async () => {
  const succeeded = JSON.stringify({ type: "session.execution.succeeded", data: { sessionID: "ses_1" } });
  const events = await collect([
    'event: server.connected\nid: 1\ndata: {"type":"server.con',
    'nected","data":{}}\n\n',
    ": comentario de keep-alive\n\n",
    "data: {roto\n\n",
    'data: {"sin":"type"}\n\n',
    `event: session.execution.succeeded\ndata: ${succeeded}\n\n`,
  ]);
  expect(events.map((e) => e.type)).toEqual(["server.connected", "session.execution.succeeded"]);
});

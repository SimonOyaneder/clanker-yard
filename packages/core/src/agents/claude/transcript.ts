import { open } from "node:fs/promises";
import { join } from "node:path";
import { TRANSCRIPT_TEXT_MAX_CHARS, TranscriptEntry, type TranscriptPage } from "@clanker/api";

/**
 * Dónde queda el transcript de una sesión: un mensaje del SDK de Claude por línea, tal como llegó, o una entrada ya
 * normalizada (`{ type: "clanker", subtype: "entry", entry }`) de otro runtime.
 */
export function transcriptFile(home: string, sessionRef: string): string {
  return join(home, "transcripts", `${sessionRef}.jsonl`);
}

const READ_CHUNK_BYTES = 256 * 1024;

/**
 * Hasta `limit` líneas completas de `path` desde el byte `cursor`, normalizadas. Una línea a medio escribir
 * (la sesión sigue viva) no se consume: `next` queda antes de ella y la próxima llamada la lee entera.
 * Un archivo que no existe es una página vacía, no un error: la sesión pudo no escribir todavía.
 */
export async function readTranscript(path: string, cursor: number, limit: number): Promise<TranscriptPage> {
  let file;
  try {
    file = await open(path, "r");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { entries: [], next: cursor, hasMore: false };
    throw error;
  }
  try {
    const { size } = await file.stat();
    const entries: TranscriptEntry[] = [];
    let next = cursor;
    let pending = Buffer.alloc(0);
    let position = cursor;
    const chunk = Buffer.alloc(READ_CHUNK_BYTES);
    let lines = 0;
    while (lines < limit && position < size) {
      const { bytesRead } = await file.read(chunk, 0, chunk.length, position);
      if (bytesRead === 0) break;
      position += bytesRead;
      pending = Buffer.concat([pending, chunk.subarray(0, bytesRead)]);
      for (let end = pending.indexOf(10); end !== -1 && lines < limit; end = pending.indexOf(10)) {
        entries.push(...entriesOf(pending.toString("utf8", 0, end)));
        next += end + 1;
        pending = pending.subarray(end + 1);
        lines++;
      }
    }
    return { entries, next, hasMore: lines === limit && next < size };
  } finally {
    await file.close();
  }
}

function clip(text: string): { text: string; truncated: boolean } {
  return text.length <= TRANSCRIPT_TEXT_MAX_CHARS
    ? { text, truncated: false }
    : { text: text.slice(0, TRANSCRIPT_TEXT_MAX_CHARS), truncated: true };
}

/** Lo más útil de lo que recibió una herramienta. */
function detailOf(input: unknown): string | null {
  if (typeof input !== "object" || input === null) return null;
  for (const key of ["file_path", "path", "command", "pattern", "url"]) {
    const value = (input as Record<string, unknown>)[key];
    if (typeof value === "string") return value;
  }
  return null;
}

function textOf(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return blocksOf(content).flatMap((block) => (block.type === "text" && typeof block.text === "string" ? [block.text] : [])).join("\n");
}

type Json = Record<string, unknown>;

const isJson = (value: unknown): value is Json => typeof value === "object" && value !== null && !Array.isArray(value);
const blocksOf = (content: unknown): Json[] => (Array.isArray(content) ? content.filter(isJson) : []);

/** Un mensaje del SDK como los eventos que la UI muestra. Lo que no aporta a leer la conversación (init, progreso) se omite. */
export function entriesOf(line: string): TranscriptEntry[] {
  let record: unknown;
  try {
    record = JSON.parse(line);
  } catch {
    return [];
  }
  if (!isJson(record)) return [];
  const message = isJson(record.message) ? record.message : {};
  switch (record.type) {
    case "assistant":
      return blocksOf(message.content).flatMap((block): TranscriptEntry[] => {
        if (block.type === "text" && typeof block.text === "string") return [{ kind: "text", ...clip(block.text) }];
        if (block.type === "thinking" && typeof block.thinking === "string") return [{ kind: "thinking", ...clip(block.thinking) }];
        if (block.type === "tool_use") {
          const { text, truncated } = clip(JSON.stringify(block.input ?? {}, null, 2));
          return [{ kind: "tool_call", id: String(block.id), tool: String(block.name), detail: detailOf(block.input), input: text, truncated }];
        }
        return [];
      });
    case "user":
      if (typeof message.content === "string") return [{ kind: "prompt", ...clip(message.content) }];
      return blocksOf(message.content).flatMap((block): TranscriptEntry[] => {
        if (block.type === "text" && typeof block.text === "string") return [{ kind: "prompt", ...clip(block.text) }];
        if (block.type === "tool_result") {
          return [{ kind: "tool_result", id: String(block.tool_use_id), isError: block.is_error === true, ...clip(textOf(block.content)) }];
        }
        return [];
      });
    case "result":
      return [
        {
          kind: "result",
          subtype: String(record.subtype),
          isError: record.is_error === true,
          turns: typeof record.num_turns === "number" ? record.num_turns : null,
          costUsd: typeof record.total_cost_usd === "number" ? record.total_cost_usd : null,
          text: typeof record.result === "string" ? record.result : null,
        },
      ];
    case "clanker": {
      if (record.subtype === "pre_compact") return [{ kind: "compaction", trigger: String(record.trigger) }];
      // Un runtime que no es Claude (opencode) escribe sus entradas ya normalizadas.
      const entry = record.subtype === "entry" ? TranscriptEntry.safeParse(record.entry) : undefined;
      return entry?.success ? [entry.data] : [];
    }
    default:
      return [];
  }
}

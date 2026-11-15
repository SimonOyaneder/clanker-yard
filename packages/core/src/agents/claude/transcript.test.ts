import { appendFileSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TRANSCRIPT_TEXT_MAX_CHARS } from "@clanker/api";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { entriesOf, readTranscript, transcriptFile } from "./transcript";

let home: string;
let path: string;
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "transcript-"));
  path = join(home, "t.jsonl");
});
afterEach(() => rmSync(home, { recursive: true, force: true }));

const assistantText = (text: string) => JSON.stringify({ type: "assistant", message: { id: text, content: [{ type: "text", text }] } });
const lines = (...records: string[]) => records.map((r) => `${r}\n`).join("");

describe("readTranscript", () => {
  test("pagina por offset: cada página sigue donde terminó la anterior y la última no tiene más", async () => {
    writeFileSync(path, lines(...["uno", "dos", "tres", "cuatro", "cinco"].map(assistantText)));

    const first = await readTranscript(path, 0, 2);
    expect(first.entries.map((e) => e.kind === "text" && e.text)).toEqual(["uno", "dos"]);
    expect(first.hasMore).toBe(true);

    const second = await readTranscript(path, first.next, 2);
    expect(second.entries.map((e) => e.kind === "text" && e.text)).toEqual(["tres", "cuatro"]);

    const last = await readTranscript(path, second.next, 2);
    expect(last.entries.map((e) => e.kind === "text" && e.text)).toEqual(["cinco"]);
    expect(last.hasMore).toBe(false);
  });

  test("una línea a medio escribir no se consume: la próxima llamada la lee entera", async () => {
    const whole = assistantText("completa");
    const partial = assistantText("a medias");
    writeFileSync(path, `${whole}\n${partial.slice(0, 20)}`);

    const first = await readTranscript(path, 0, 10);
    expect(first.entries).toHaveLength(1);
    expect(first.hasMore).toBe(false);

    appendFileSync(path, `${partial.slice(20)}\n`);
    const second = await readTranscript(path, first.next, 10);
    expect(second.entries.map((e) => e.kind === "text" && e.text)).toEqual(["a medias"]);
  });

  test("una línea más grande que un chunk de lectura llega entera", async () => {
    const big = "x".repeat(600 * 1024);
    writeFileSync(path, lines(assistantText(big), assistantText("después")));

    const page = await readTranscript(path, 0, 10);
    expect(page.entries).toHaveLength(2);
    expect(page.entries[0]).toMatchObject({ kind: "text", truncated: true });
    expect((page.entries[0] as { text: string }).text).toHaveLength(TRANSCRIPT_TEXT_MAX_CHARS);
  });

  test("sin archivo es una página vacía que conserva el cursor", async () => {
    expect(await readTranscript(join(home, "no-existe.jsonl"), 42, 10)).toEqual({ entries: [], next: 42, hasMore: false });
  });

  test("el archivo está donde el runtime lo deja", () => {
    expect(transcriptFile("/home", "abc")).toBe(join("/home", "transcripts", "abc.jsonl"));
  });
});

describe("entriesOf", () => {
  test("texto, thinking y tool calls del asistente, y el resultado de la herramienta del usuario", () => {
    const assistant = JSON.stringify({
      type: "assistant",
      message: {
        content: [
          { type: "thinking", thinking: "pienso" },
          { type: "text", text: "leo" },
          { type: "tool_use", id: "t1", name: "Read", input: { file_path: "a.rb" } },
        ],
      },
    });
    const user = JSON.stringify({
      type: "user",
      message: { content: [{ type: "tool_result", tool_use_id: "t1", is_error: true, content: [{ type: "text", text: "no existe" }] }] },
    });

    expect(entriesOf(assistant)).toEqual([
      { kind: "thinking", text: "pienso", truncated: false },
      { kind: "text", text: "leo", truncated: false },
      { kind: "tool_call", id: "t1", tool: "Read", detail: "a.rb", input: '{\n  "file_path": "a.rb"\n}', truncated: false },
    ]);
    expect(entriesOf(user)).toEqual([{ kind: "tool_result", id: "t1", text: "no existe", isError: true, truncated: false }]);
  });

  test("el result, la compactación y el prompt; init y lo que no sea JSON se omiten", () => {
    expect(entriesOf(JSON.stringify({ type: "result", subtype: "success", is_error: false, num_turns: 3, total_cost_usd: 0.12, result: "listo" }))).toEqual([
      { kind: "result", subtype: "success", isError: false, turns: 3, costUsd: 0.12, text: "listo" },
    ]);
    expect(entriesOf(JSON.stringify({ type: "clanker", subtype: "pre_compact", trigger: "auto" }))).toEqual([{ kind: "compaction", trigger: "auto" }]);
    expect(entriesOf(JSON.stringify({ type: "user", message: { content: "haz esto" } }))).toEqual([{ kind: "prompt", text: "haz esto", truncated: false }]);
    expect(entriesOf(JSON.stringify({ type: "system", subtype: "init" }))).toEqual([]);
    expect(entriesOf("{no es json")).toEqual([]);
  });
});

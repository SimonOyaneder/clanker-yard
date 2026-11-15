import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { artifactRefs, artifacts as artifactsTable } from "../store/schema";
import { openStore, type Store } from "../store/store";
import {
  createArtifacts,
  GC_MAX_AGE_MS,
  INLINE_MAX_BYTES,
  type Artifacts,
} from "./artifacts";

const DAY = 24 * 60 * 60 * 1000;

let store: Store;
let dir: string;
let clock: number;
let artifacts: Artifacts;

beforeEach(() => {
  store = openStore({ path: ":memory:" });
  dir = mkdtempSync(join(tmpdir(), "clanker-artifacts-"));
  clock = 1_000_000;
  artifacts = createArtifacts({ store, dir: join(dir, "artifacts"), now: () => clock });
});

afterEach(() => {
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

const sha256 = (text: string) => createHash("sha256").update(text).digest("hex");
const rows = () => store.db.select().from(artifactsTable).all();
const big = (char: string) => char.repeat(INLINE_MAX_BYTES + 1);
const owner = { type: "step_run", id: "stp_1", role: "output" };

describe("put y get", () => {
  test("el mismo contenido se guarda una sola vez", () => {
    const first = artifacts.put("hola", "report");
    const second = artifacts.put("hola", "brief");

    expect(second).toBe(first);
    expect(first).toBe(sha256("hola"));
    expect(rows()).toHaveLength(1);
    expect(artifacts.get(first)).toMatchObject({ kind: "report", size: 4 });
  });

  test("contenido distinto da hashes y filas distintas", () => {
    expect(artifacts.put("a", "report")).not.toBe(artifacts.put("b", "report"));
    expect(rows()).toHaveLength(2);
  });

  test("un string vuelve idéntico y con mime de texto; los bytes se conservan tal cual", () => {
    const text = artifacts.put("ñandú ✓", "pr_body");
    const bytes = artifacts.put(new Uint8Array([0, 255, 1]), "snapshot", { mime: "image/png" });

    expect(artifacts.get(text)).toMatchObject({ mime: "text/plain; charset=utf-8", size: 11 });
    expect(new TextDecoder().decode(artifacts.get(text)?.content)).toBe("ñandú ✓");
    expect(artifacts.get(bytes)).toMatchObject({ mime: "image/png", size: 3 });
    expect([...(artifacts.get(bytes)?.content ?? [])]).toEqual([0, 255, 1]);
  });

  test("hasta 64 KB va en la base y más va a disco, y ambos se leen igual", () => {
    const exact = "x".repeat(INLINE_MAX_BYTES);
    const over = big("y");
    const inlineHash = artifacts.put(exact, "log_excerpt");
    const diskHash = artifacts.put(over, "log_excerpt");

    const stored = Object.fromEntries(rows().map((r) => [r.hash, r.body]));
    expect(stored[inlineHash]).not.toBeNull();
    expect(stored[diskHash]).toBeNull();
    expect(existsSync(join(dir, "artifacts", diskHash.slice(0, 2), diskHash.slice(2)))).toBe(true);
    expect(existsSync(join(dir, "artifacts", inlineHash.slice(0, 2)))).toBe(false);

    expect(Buffer.from(artifacts.get(inlineHash)!.content).toString()).toBe(exact);
    expect(Buffer.from(artifacts.get(diskHash)!.content).toString()).toBe(over);
    expect(artifacts.get(diskHash)?.size).toBe(INLINE_MAX_BYTES + 1);
  });

  test("get de un hash que no existe devuelve undefined", () => {
    expect(artifacts.get(sha256("nada"))).toBeUndefined();
  });

  test("si el archivo de un artefacto grande desapareció, get falla diciendo cuál", () => {
    const hash = artifacts.put(big("z"), "log_excerpt");
    rmSync(join(dir, "artifacts"), { recursive: true });

    expect(() => artifacts.get(hash)).toThrow(new RegExp(hash));
  });

  test("un put repetido repara un archivo que desapareció", () => {
    const hash = artifacts.put(big("z"), "log_excerpt");
    rmSync(join(dir, "artifacts"), { recursive: true });

    artifacts.put(big("z"), "log_excerpt");

    expect(artifacts.get(hash)?.size).toBe(INLINE_MAX_BYTES + 1);
  });
});

describe("ref", () => {
  test("es idempotente y distingue dueño y rol", () => {
    const hash = artifacts.put("hola", "report");

    artifacts.ref(hash, owner);
    artifacts.ref(hash, owner);
    artifacts.ref(hash, { ...owner, role: "input" });
    artifacts.ref(hash, { ...owner, id: "stp_2" });

    expect(store.db.select().from(artifactRefs).all()).toHaveLength(3);
  });

  test("referenciar un hash que no existe falla con un mensaje accionable", () => {
    expect(() => artifacts.ref(sha256("nada"), owner)).toThrow(/put/);
  });
});

describe("gc", () => {
  test("borra lo que no tiene refs y pasó los 30 días, y conserva lo demás", () => {
    const orphan = artifacts.put("huérfano", "log_excerpt");
    const bigOrphan = artifacts.put(big("o"), "log_excerpt");
    const referenced = artifacts.put("con ref", "report");
    artifacts.ref(referenced, owner);

    clock += GC_MAX_AGE_MS;
    expect(artifacts.gc()).toBe(0);
    expect(rows()).toHaveLength(3);

    clock += 1;
    expect(artifacts.gc()).toBe(2);
    expect(rows().map((r) => r.hash)).toEqual([referenced]);
    expect(artifacts.get(orphan)).toBeUndefined();
    expect(artifacts.get(bigOrphan)).toBeUndefined();
    const files = readdirSync(join(dir, "artifacts"), { recursive: true, withFileTypes: true });
    expect(files.filter((entry) => entry.isFile())).toEqual([]);
  });

  test("un artefacto que recibe una ref antes de cumplir el plazo sobrevive al GC", () => {
    const hash = artifacts.put("tarde", "report");
    clock += 40 * DAY;
    artifacts.ref(hash, owner);

    expect(artifacts.gc()).toBe(0);
    expect(artifacts.get(hash)).toBeDefined();
  });

  test("un put repetido reinicia el plazo", () => {
    const hash = artifacts.put("otra vez", "report");
    clock += 29 * DAY;
    artifacts.put("otra vez", "report");
    clock += 29 * DAY;

    expect(artifacts.gc()).toBe(0);
    expect(artifacts.get(hash)).toBeDefined();

    clock += 2 * DAY;
    expect(artifacts.gc()).toBe(1);
  });
});

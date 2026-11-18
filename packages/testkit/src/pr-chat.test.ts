import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createClient, type AgentRuntimeId, type Client } from "@clanker/api";
import { createConnections, createFileSecrets, createRepos, openStore, type AgentRuntime, type Store } from "@clanker/core";
import { seedPr } from "@clanker/core/testing";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type { FakeRuntimeOptions } from "./fake-runtime";
import { labeledFake, type ReceivedPrompt } from "./labeled-fake";
import { tempGitRepo, type TempGitRepo } from "./git";
import { startCore } from "./start-core";

let dir: string;
let fixtures: string;
let store: Store;
let repo: TempGitRepo;
let prId: string;
let core: Awaited<ReturnType<typeof startCore>> | undefined;
let client: Client;
/** Lo que cada runtime recibió: el prompt de un `start` o el mensaje de un `resume`. */
let prompts: ReceivedPrompt[];

const scriptOf = (round: number, body: string) => writeFileSync(join(fixtures, `chat.r${round}.yaml`), `match: { mode: turn }\n${body}`);
const reply = (text: string, proposal: string | null) =>
  `result:\n  status: success\n  structured:\n    outcome: ok\n    summary: "${text}"\n    payload:\n      reply: "${text}"\n      proposal: ${proposal ?? "null"}\n`;
const writes = (files: Record<string, string>) =>
  `effects:\n${Object.entries(files).map(([path, content]) => `  - write:\n      path: ${path}\n      content: "${content.replace(/\n/g, "\\n")}"\n`).join("")}`;
const described = (summary: string, path: string) => JSON.stringify({ summary, items: [{ id: "c1", change: summary, path }] });

/** Un fake con el id de un runtime real, que anota lo que recibe. */
const fakeAs = (id: AgentRuntimeId, options: Partial<FakeRuntimeOptions> = {}) => labeledFake(id, { fixtures, speed: Infinity, ...options }, prompts);

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "clanker-pr-chat-"));
  fixtures = join(dir, "fixtures");
  mkdirSync(fixtures);
  prompts = [];
  store = openStore({ path: join(dir, "clanker.db") });
  repo = tempGitRepo({
    remote: true,
    commits: [{ message: "chore: base", files: { "hello.txt": "hola\n", "a.txt": "a\n" } }],
    branches: { feat: [{ message: "feat: cambio", files: { "feat.txt": "feat\n" } }] },
  });
  const repoId = createRepos({ store }).add({ name: "demo", path: repo.dir });
  prId = seedPr(store, { repoId, number: null, nodeId: null, headRef: "feat", baseRef: "main", headSha: repo.git("rev-parse", "feat"), state: "local", isDraft: true, title: "Feat", body: "Un cambio" });
});

afterEach(async () => {
  await core?.close();
  core = undefined;
  store.close();
  repo.cleanup();
  rmSync(dir, { recursive: true, force: true });
});

async function boot(runtimes: AgentRuntime[] = [fakeAs("claude-sdk"), fakeAs("opencode")]): Promise<Client> {
  const connections = createConnections({ store, secrets: createFileSecrets({ dir: join(dir, "secrets") }) });
  core = await startCore({ store, dataDir: dir, connections, runtimes, scheduler: false, coreVersion: "0.0.0", onShutdown: () => {} });
  client = createClient({ url: core.server.url, token: core.server.token, origin: "cli" });
  return client;
}

/** Espera a que el turno en curso termine y devuelve el chat como quedó. */
async function settled() {
  let snapshot!: Awaited<ReturnType<Client["chats"]["get"]>>;
  await vi.waitFor(async () => {
    snapshot = await client.chats.get({ prId });
    expect(snapshot.chat.busy).toBe(false);
  }, { timeout: 15_000, interval: 20 });
  return snapshot;
}

/** El árbol que da aplicar `patch` sobre `base`, sin tocar ningún worktree. */
function treeOf(base: string, patch: string): string {
  const index = join(dir, `index-${Math.random()}`);
  const env = { ...process.env, GIT_INDEX_FILE: index };
  const run = (...args: string[]) => execFileSync("git", ["-C", repo.dir, ...args], { env, encoding: "utf8", input: patch }).trim();
  run("read-tree", base);
  run("apply", "--cached", "-");
  return run("write-tree");
}

describe("chat de un PR", () => {
  test("dos turnos encadenados retoman la misma sesión; un turno que escribe deja una propuesta y otro que solo responde no", async () => {
    scriptOf(1, writes({ "hello.txt": "Hola mundo\n" }) + reply("Actualicé el saludo.", described("Ajusta el saludo", "hello.txt")));
    scriptOf(2, reply("El saludo dice Hola mundo.", null));
    scriptOf(3, writes({ "bye.txt": "chao\n" }) + reply("Agregué la despedida.", described("Agrega la despedida", "bye.txt")));
    await boot();
    const { chat } = await client.chats.get({ prId });
    expect(chat).toMatchObject({ prId, status: "active", runtime: "claude-sdk", model: "sonnet", busy: false, canApply: true });

    await client.chats.send({ chatId: chat.id, text: "cambia el saludo" });
    const first = await settled();
    expect(first.messages.map((m) => [m.role, m.proposalRev])).toEqual([["user", undefined], ["assistant", 1]]);
    expect(first.proposal).toMatchObject({ rev: 1, status: "draft", summary: "Ajusta el saludo", files: [{ path: "hello.txt", additions: 1, deletions: 1 }] });
    const rev1 = await client.chats.proposal({ chatId: chat.id, rev: 1 });
    expect(rev1.patch).toContain("+Hola mundo");

    await client.chats.send({ chatId: chat.id, text: "¿qué dice ahora?" });
    const second = await settled();
    expect(second.messages.at(-1)).toMatchObject({ role: "assistant", text: "El saludo dice Hola mundo." });
    expect(second.messages.at(-1)!.proposalRev).toBeUndefined();
    expect(second.proposal?.rev).toBe(1);
    const resumed = store.db.$client.prepare("SELECT resumed_from FROM agent_sessions WHERE id = ?").get(second.messages[3]!.sessionId!) as { resumed_from: string | null } | undefined;
    expect([second.messages[3]!.sessionId, resumed?.resumed_from]).toContain(first.messages[1]!.sessionId);
    expect(prompts.map((p) => p.kind)).toEqual(["start", "resume"]);

    await client.chats.send({ chatId: chat.id, text: "y agrega una despedida" });
    const third = await settled();
    expect(third.proposal).toMatchObject({ rev: 2, status: "draft" });
    expect(third.proposal!.files.map((f) => f.path).sort()).toEqual(["bye.txt", "hello.txt"]);
    const rev2 = await client.chats.proposal({ chatId: chat.id, rev: 2 });
    const row = store.db.$client.prepare("SELECT base_sha, snapshot_ref FROM pr_chat_proposals WHERE rev = 2").get() as { base_sha: string; snapshot_ref: string };
    expect(treeOf(row.base_sha, rev2.patch)).toBe(repo.git("rev-parse", `${row.snapshot_ref}^{tree}`));
    expect(third.chat.costMicros).toBeGreaterThanOrEqual(0);
    expect(store.events.since(0, { types: ["chat.proposal"] })).toHaveLength(2);
  });

  test("el brief trae el PR, su diff y las citas", async () => {
    scriptOf(1, reply("Visto.", null));
    await boot();
    const { chat } = await client.chats.get({ prId });
    await client.chats.send({ chatId: chat.id, text: "mira esto", refs: [{ kind: "lines", path: "feat.txt", start: 1, end: 1, text: "feat" }, { kind: "thread", id: "123", path: "a.txt", line: 1, author: "ana", text: "esto está raro" }] });
    const done = await settled();
    expect(done.messages[0]!.refs).toHaveLength(2);
    const scratch = join(dir, "chats", chat.id, ".clanker-run");
    expect(readFileSync(join(scratch, "pr.md"), "utf8")).toContain("# Feat");
    expect(readFileSync(join(scratch, "diff.patch"), "utf8")).toContain("+feat");
    expect(readFileSync(join(scratch, "refs.md"), "utf8")).toContain("esto está raro");
    expect(prompts[0]!.text).toContain("refs.md");
  });

  test("discard deja el borrador en la punta y la propuesta descartada", async () => {
    scriptOf(1, writes({ "hello.txt": "Hola mundo\n" }) + reply("Listo.", described("Ajusta el saludo", "hello.txt")));
    await boot();
    const { chat } = await client.chats.get({ prId });
    await client.chats.send({ chatId: chat.id, text: "cambia el saludo" });
    await settled();

    await client.chats.discard({ chatId: chat.id });

    const after = await client.chats.get({ prId });
    expect(after.proposal?.status).toBe("discarded");
    expect(after.messages.at(-1)).toMatchObject({ role: "system", proposalRev: 1 });
    expect(readFileSync(join(dir, "chats", chat.id, "hello.txt"), "utf8")).toBe("hola\n");
  });

  test("la propuesta queda stale cuando el PR avanza y el turno siguiente avisa el conflicto del sync", async () => {
    scriptOf(1, writes({ "hello.txt": "Hola mundo\n" }) + reply("Listo.", described("Ajusta el saludo", "hello.txt")));
    scriptOf(2, reply("Visto el conflicto.", null));
    await boot();
    const { chat } = await client.chats.get({ prId });
    await client.chats.send({ chatId: chat.id, text: "cambia el saludo" });
    await settled();
    const work = join(dir, "work");
    repo.git("worktree", "add", "--quiet", work, "feat");
    writeFileSync(join(work, "hello.txt"), "buenas\n");
    repo.git("-C", work, "commit", "--quiet", "-am", "feat: otro saludo");
    const head = repo.git("rev-parse", "feat");
    store.db.$client.prepare("UPDATE pull_requests SET head_sha = ? WHERE id = ?").run(head, prId);

    expect((await client.chats.get({ prId })).proposal?.status).toBe("stale");

    await client.chats.send({ chatId: chat.id, text: "¿y ahora?" });
    await settled();
    expect(prompts.at(-1)!.text).toContain("chocaron con la punta nueva (hello.txt)");
  });

  test("un turno a la vez, e interrupt lo corta", async () => {
    writeFileSync(join(fixtures, "chat.r1.yaml"), `match: { mode: turn }\nevents:\n  - { at: 1000, text: "pensando" }\n${reply("No debería llegar.", null)}`);
    const holding = (ms: number, signal: AbortSignal) => new Promise<void>((resolve) => {
      void ms;
      signal.addEventListener("abort", () => resolve(), { once: true });
    });
    await boot([fakeAs("claude-sdk", { speed: 1, sleep: holding })]);
    const { chat } = await client.chats.get({ prId });
    await client.chats.send({ chatId: chat.id, text: "algo largo" });
    await vi.waitFor(async () => expect((await client.chats.get({ prId })).chat.turnSessionId).toBeDefined(), { timeout: 10_000 });

    await expect(client.chats.send({ chatId: chat.id, text: "otra cosa" })).rejects.toMatchObject({ code: "BAD_REQUEST", message: expect.stringContaining("turno en curso") });
    await client.chats.interrupt({ chatId: chat.id });

    const done = await settled();
    expect(done.messages.at(-1)).toMatchObject({ role: "system", text: expect.stringContaining("Interrumpiste el turno") });
  });

  test("cambiar de runtime a mitad del chat abre una sesión nueva con handoff", async () => {
    scriptOf(1, writes({ "hello.txt": "Hola mundo\n" }) + reply("Listo.", described("Ajusta el saludo", "hello.txt")));
    scriptOf(2, reply("Sigo desde opencode.", null));
    await boot();
    const { chat } = await client.chats.get({ prId });
    await client.chats.send({ chatId: chat.id, text: "cambia el saludo" });
    const first = await settled();

    await client.chats.send({ chatId: chat.id, text: "sigue", runtime: "opencode", model: "opencode/gpt-5-nano" });
    const second = await settled();

    expect(second.chat).toMatchObject({ runtime: "opencode", model: "opencode/gpt-5-nano" });
    expect(second.messages.at(-1)!.sessionId).not.toBe(first.messages[1]!.sessionId);
    expect(prompts.map((p) => [p.runtime, p.kind])).toEqual([["claude-sdk", "start"], ["opencode", "start"]]);
    expect(prompts[1]!.text).toContain("cambió de runtime");
    expect(prompts[1]!.text).toContain("cambia el saludo");
    expect(prompts[1]!.text).toContain("hello.txt");
  });

  test("aplicar solo lo pide una persona desde la app, y reiniciar archiva el chat", async () => {
    scriptOf(1, writes({ "hello.txt": "Hola mundo\n" }) + reply("Listo.", described("Ajusta el saludo", "hello.txt")));
    await boot();
    const { chat } = await client.chats.get({ prId });
    await client.chats.send({ chatId: chat.id, text: "cambia el saludo" });
    await settled();

    await expect(client.chats.apply({ chatId: chat.id, rev: 1 })).rejects.toMatchObject({ code: "FORBIDDEN" });
    const mcp = createClient({ url: core!.server.url, token: core!.server.token, origin: "mcp" });
    await expect(mcp.chats.apply({ chatId: chat.id, rev: 1 })).rejects.toMatchObject({ code: "FORBIDDEN" });

    const fresh = await client.chats.reset({ chatId: chat.id });
    expect(fresh.id).not.toBe(chat.id);
    expect(fresh).toMatchObject({ status: "active", runtime: "claude-sdk" });
    expect((await client.chats.get({ prId })).messages).toEqual([]);
  });

  test("un turno cortado por un reinicio queda como mensaje del sistema", async () => {
    await boot();
    const { chat } = await client.chats.get({ prId });
    await core!.close();
    core = undefined;
    store.db.$client.prepare("UPDATE pr_chats SET turn_started_at = 1 WHERE id = ?").run(chat.id);

    await boot();

    const after = await client.chats.get({ prId });
    expect(after.chat.busy).toBe(false);
    expect(after.messages.at(-1)).toMatchObject({ role: "system", text: expect.stringContaining("se reinició") });
  });
});

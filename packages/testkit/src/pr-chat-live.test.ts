import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createClient, type AgentRuntimeId, type Client } from "@clanker/api";
import { createClaudeRuntime, createConnections, createFileSecrets, createOpencodeRuntime, createRepos, openStore, subscriptionCredentials, type AgentRuntime, type Store } from "@clanker/core";
import { seedPr } from "@clanker/core/testing";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { tempGitRepo, type TempGitRepo } from "./git";
import { startCore } from "./start-core";

// Smoke test en vivo del chat de un PR con cada runtime (gasta cuota, fuera de la CI): un turno sobre un PR local de un
// repo temporal tiene que entregar un reporte que valide y dejar en la propuesta el cambio pedido.
//   CLANKER_LIVE_CLAUDE=1 npx vitest run packages/testkit/src/pr-chat-live.test.ts     (haiku, con la suscripción)
//   CLANKER_LIVE_OPENCODE=1 npx vitest run packages/testkit/src/pr-chat-live.test.ts   (modelo gratis de opencode Zen)

const live = { claude: process.env.CLANKER_LIVE_CLAUDE === "1", opencode: process.env.CLANKER_LIVE_OPENCODE === "1" };
const OPENCODE_MODEL = process.env.CLANKER_LIVE_OPENCODE_MODEL ?? "opencode/big-pickle";

let dir: string;
let store: Store;
let repo: TempGitRepo;
let prId: string;
let core: Awaited<ReturnType<typeof startCore>> | undefined;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "clanker-chat-live-"));
  store = openStore({ path: join(dir, "clanker.db") });
  repo = tempGitRepo({
    commits: [{ message: "chore: base", files: { "hello.txt": "hola\n", "AGENTS.md": "Repo de prueba: un saludo en hello.txt.\n" } }],
    branches: { feat: [{ message: "feat: despedida", files: { "bye.txt": "chao\n" } }] },
  });
  const repoId = createRepos({ store }).add({ name: "live", path: repo.dir });
  prId = seedPr(store, { repoId, number: null, nodeId: null, headRef: "feat", baseRef: "main", headSha: repo.git("rev-parse", "feat"), state: "local", isDraft: true, title: "Despedida", body: "Agrega bye.txt" });
});

afterEach(async () => {
  await core?.close();
  core = undefined;
  store.close();
  repo.cleanup();
  rmSync(dir, { recursive: true, force: true });
});

async function turn(runtime: AgentRuntime, choice: { runtime: AgentRuntimeId; model: string }): Promise<Awaited<ReturnType<Client["chats"]["get"]>> & { patch: string }> {
  const connections = createConnections({ store, secrets: createFileSecrets({ dir: join(dir, "secrets") }) });
  core = await startCore({ store, dataDir: dir, connections, runtimes: [runtime], scheduler: false, coreVersion: "0.0.0", onShutdown: () => {} });
  const client = createClient({ url: core.server.url, token: core.server.token, origin: "cli" });
  const { chat } = await client.chats.get({ prId });
  await client.chats.send({ chatId: chat.id, text: "Cambia el contenido de hello.txt para que diga exactamente `hola mundo` (una línea). No toques otros archivos.", ...choice });
  let snapshot!: Awaited<ReturnType<Client["chats"]["get"]>>;
  await vi.waitFor(async () => {
    snapshot = await client.chats.get({ prId });
    expect(snapshot.chat.busy).toBe(false);
  }, { timeout: 280_000, interval: 1000 });
  console.log(JSON.stringify({ runtime: choice.runtime, model: choice.model, messages: snapshot.messages.map((m) => ({ role: m.role, text: m.text })), proposal: snapshot.proposal, costMicros: snapshot.chat.costMicros }, null, 2));
  const patch = snapshot.proposal ? (await client.chats.proposal({ chatId: chat.id, rev: snapshot.proposal.rev })).patch : "";
  return { ...snapshot, patch };
}

describe("chat de un PR en vivo", () => {
  test.skipIf(!live.claude)("claude-sdk (haiku): el turno valida y la propuesta tiene el cambio pedido", { timeout: 300_000 }, async () => {
    const credentials = subscriptionCredentials();
    const result = await turn(createClaudeRuntime({ credentials: async () => credentials, home: join(dir, "claude-home") }), { runtime: "claude-sdk", model: "haiku" });

    expect(result.messages.at(-1)?.role).toBe("assistant");
    expect(result.proposal).toMatchObject({ rev: 1, status: "draft" });
    expect(result.patch).toContain("+hola mundo");
  });

  test.skipIf(!live.opencode)("opencode (Zen gratis): el turno valida y la propuesta tiene el cambio pedido", { timeout: 300_000 }, async () => {
    const result = await turn(createOpencodeRuntime({ home: join(dir, "opencode-home") }), { runtime: "opencode", model: OPENCODE_MODEL });

    expect(result.messages.at(-1)?.role).toBe("assistant");
    expect(result.proposal).toMatchObject({ rev: 1, status: "draft" });
    expect(result.patch).toContain("+hola mundo");
  });
});

import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { compileJsonSchema, type JsonSchema } from "@clanker/api";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { createConnections } from "../../connections/connections";
import { git } from "../../git/git";
import { createFileSecrets } from "../../secrets/encrypted-file";
import { openStore, type Store } from "../../store/store";
import type { AgentEvent, AgentRun } from "../runtime";
import { readTranscript } from "../transcripts";
import { createCodexRuntime } from "./codex-runtime";
import { probeCodex } from "./probe";

describe.skipIf(process.env.CLANKER_LIVE_CODEX !== "1")("codex en vivo", () => {
  let home: string;
  let store: Store;
  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), "codex-live-"));
    store = openStore({ path: ":memory:" });
  });
  afterEach(async () => {
    store.close();
    await rm(home, { recursive: true, force: true });
  });

  const outputSchema: JsonSchema = {
    type: "object",
    properties: {
      outcome: { type: "string", enum: ["ok"] },
      summary: { type: "string" },
      decisions: { type: "array", items: { type: "string" } },
      payload: {
        type: "object",
        properties: { secret: { type: "string" } },
        required: ["secret"],
        additionalProperties: false,
      },
    },
    required: ["outcome", "summary", "payload"],
    additionalProperties: false,
  };
  const validate = compileJsonSchema(outputSchema);

  async function finish(run: AgentRun) {
    const events: AgentEvent[] = [];
    const draining = (async () => { for await (const event of run.events) events.push(event); })();
    try {
      return { result: await run.result, events };
    } finally {
      await run.interrupt();
      await draining;
    }
  }

  test("edita y commitea en un worktree con la identidad del usuario, reporta y retoma el hilo", { timeout: 300_000 }, async () => {
    const runtime = createCodexRuntime({ home, store });
    const options = await runtime.describe!();
    expect(options.available, options.message).toBe(true);
    const model = process.env.CLANKER_LIVE_CODEX_MODEL ?? options.models[0]!.id;
    expect(options.models.map((item) => item.id)).toContain(model);
    const identity = {
      name: await git(process.cwd(), ["config", "user.name"]),
      email: await git(process.cwd(), ["config", "user.email"]),
    };
    const cwd = join(home, "worktree");
    const secret = randomUUID();
    await git(home, ["init", "--initial-branch=main"]);
    await git(home, ["config", "user.name", `${identity.name} (repo config)`]);
    await git(home, ["config", "user.email", `repo-config-${identity.email}`]);
    await writeFile(join(home, "secret.txt"), `${secret}\n`);
    await git(home, ["add", "secret.txt"]);
    await git(home, ["-c", `user.name=${identity.name}`, "-c", `user.email=${identity.email}`, "-c", "core.hooksPath=/dev/null", "commit", "-m", "test: initial secret"]);
    await git(home, ["worktree", "add", "-b", "smoke", cwd]);
    expect((await readFile(join(cwd, ".git"), "utf8")).startsWith("gitdir:")).toBe(true);

    const run = await runtime.start({
      role: "live-smoke", cwd, model, effort: "low",
      systemPrompt: "Eres un agente de prueba. Trabaja solo en el cwd, usa herramientas locales y entrega el JSON pedido. No publiques nada.",
      prompt: 'Lee secret.txt y recuerda su contenido original. Reemplázalo por "edited\\n" y haz exactamente un commit local con mensaje "test: edit secret". Reporta el secreto original en payload.secret, outcome "ok" y sin decisiones.',
      references: [], tools: "all", hooks: false, outputSchema, gitIdentity: identity,
    });
    const { events, result } = await finish(run);
    expect(result.status, result.message).toBe("success");
    expect(validate.safeParse(result.structured).success).toBe(true);
    expect(result.structured).toMatchObject({ outcome: "ok", payload: { secret } });
    expect(await readFile(join(cwd, "secret.txt"), "utf8")).toBe("edited\n");
    expect(await git(cwd, ["log", "-1", "--format=%s"])).toBe("test: edit secret");
    expect(await git(cwd, ["log", "-1", "--format=%an <%ae>|%cn <%ce>"])).toBe(`${identity.name} <${identity.email}>|${identity.name} <${identity.email}>`);
    expect(await git(cwd, ["rev-list", "--count", "main..HEAD"])).toBe("1");
    expect(await git(cwd, ["status", "--porcelain"])).toBe("");
    expect(events.some((event) => event.type === "first_token")).toBe(true);
    expect(events.some((event) => event.type === "tool_start")).toBe(true);
    expect(result.usage.turns).toBeGreaterThan(0);
    expect(result.usage.tokensOut).toBeGreaterThan(0);
    expect(result.usage.costSource).toBe("estimate");
    const transcript = await readTranscript(join(home, "transcripts", `${run.ref.sessionId}.jsonl`), 0, 1000);
    expect(transcript.entries.map((entry) => entry.kind)).toEqual(expect.arrayContaining(["prompt", "tool_call", "tool_result", "result"]));

    const again = await runtime.resume(run.ref, 'Sin leer archivos ni hacer commits, reporta el secreto ORIGINAL seguido de "-resumed" en payload.secret.', { outputSchema, references: [] });
    const { result: second } = await finish(again);
    expect(second.status, second.message).toBe("success");
    expect(validate.safeParse(second.structured).success).toBe(true);
    expect(second.structured).toMatchObject({ payload: { secret: `${secret}-resumed` } });
    expect(again.ref).toEqual(run.ref);
    expect(second.usage.turns).toBeGreaterThan(0);
    expect(await git(cwd, ["rev-list", "--count", "main..HEAD"])).toBe("1");
  });

  test("testCodex y otro app-server leen el plan concurrentemente sin inferencia ni refresh forzado", { timeout: 90_000 }, async () => {
    const connections = createConnections({
      store, secrets: createFileSecrets({ dir: join(home, "secrets") }), codex: { cwd: home },
    });
    const [status, other] = await Promise.all([connections.testCodex("cli"), probeCodex({ cwd: home })]);
    for (const observed of [status, other.status]) {
      expect(observed.state, observed.message).toBe("ready");
      expect(observed.plan).toBeDefined();
      expect(observed.usage!.windows.length).toBeGreaterThan(0);
    }
    expect(connections.list()).toMatchObject([{ provider: "codex", account: "subscription", status: "active" }]);
    expect(store.db.$client.prepare("SELECT secret_ref FROM connections").get()).toEqual({ secret_ref: "" });
  });
});

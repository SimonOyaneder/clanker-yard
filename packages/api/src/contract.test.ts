import { type ContractRouterClient, isContractProcedure } from "@orpc/contract";
import { describe, expect, expectTypeOf, test } from "vitest";
import { API_MAJOR, ChatId, ChatMessage, ChatProposal, type Contract, type Event, EventType, type PayloadOf, PrChat, type RunId, contract } from "./index";

describe("contrato", () => {
  test("el detalle de PR exige reemplazar los cores de API 2 o anterior", () => {
    expect(API_MAJOR).toBeGreaterThan(2);
  });

  test("exporta los routers system, events, connections, artifacts, issues, trackers, projects, packs, prs, chats, repos, runs, decisions, learnings, defs, metrics e imports con sus procedimientos", () => {
    expect(Object.keys(contract).sort()).toEqual([
      "artifacts",
      "chats",
      "connections",
      "decisions",
      "defs",
      "events",
      "imports",
      "issues",
      "learnings",
      "metrics",
      "packs",
      "projects",
      "prs",
      "repos",
      "runs",
      "system",
      "trackers",
    ]);
    expect(Object.keys(contract.connections)).toEqual(["list", "setPat", "githubPatForm", "startDeviceFlow", "githubInstallations", "linearAuth", "testClaude", "testCodex", "codexStatus", "setClaudeApiKey", "disconnect"]);
    expect(Object.keys(contract.system).sort()).toEqual(["breakers", "health", "info", "lanes", "retryBreaker", "setLanes", "shutdown"]);
    expect(Object.keys(contract.events).sort()).toEqual(["latest", "list", "stream"]);
    expect(Object.keys(contract.artifacts)).toEqual(["get"]);
    expect(Object.keys(contract.issues).sort()).toEqual(["createLocal", "get", "list"]);
    expect(Object.keys(contract.trackers)).toEqual(["projects"]);
    expect(Object.keys(contract.projects).sort()).toEqual(["archive", "boostIssue", "create", "defaults", "exportConfig", "get", "importConfig", "list", "pause", "queue", "resume", "setDefaults", "skipIssue", "summary", "update"]);
    expect(Object.keys(contract.packs)).toEqual(["list", "install", "remove"]);
    expect(Object.keys(contract.prs)).toEqual(["get", "list", "refresh", "setHold", "merge", "requestReview", "rebase", "publishLocal", "detail", "commitDiff", "localDetail", "localCommitDiff", "updateLocal", "applyLocalPatch", "requestLocalPublish", "republish", "republishProgress"]);
    expect(Object.keys(contract.chats)).toEqual(["get", "send", "interrupt", "reset", "proposal", "discard", "apply"]);
    expect(Object.keys(contract.repos).sort()).toEqual(["add", "detect", "list", "overview", "syncConfig", "testRecipe"]);
    expect(Object.keys(contract.runs).sort()).toEqual(["cancel", "forceOutcome", "get", "interrupt", "list", "pause", "resume", "retryStep", "start", "steerStep", "step", "transcript"]);
    expect(Object.keys(contract.decisions).sort()).toEqual(["get", "list", "resolve"]);
    expect(Object.keys(contract.learnings).sort()).toEqual(["approve", "archive", "get", "list", "propose", "reject", "screen", "update"]);
    expect(Object.keys(contract.defs).sort()).toEqual(["agentOptions", "archive", "create", "exportToRepo", "get", "list", "restore", "update"]);
    expect(Object.keys(contract.metrics).sort()).toEqual(["byDay", "byIssue", "byModel", "byRole", "byStep"]);
    expect(Object.keys(contract.imports)).toEqual(["legacy"]);
    for (const procedure of [
      ...Object.values(contract.system),
      ...Object.values(contract.events),
      ...Object.values(contract.artifacts),
      ...Object.values(contract.issues),
      ...Object.values(contract.trackers),
      ...Object.values(contract.projects),
      ...Object.values(contract.packs),
      ...Object.values(contract.prs),
      ...Object.values(contract.chats),
      ...Object.values(contract.repos),
      ...Object.values(contract.runs),
      ...Object.values(contract.decisions),
      ...Object.values(contract.learnings),
      ...Object.values(contract.defs),
      ...Object.values(contract.metrics),
      ...Object.values(contract.imports),
    ]) {
      expect(isContractProcedure(procedure)).toBe(true);
    }
  });

  test("events.list aplica los defaults y valida los límites", async () => {
    const schema = contract.events.list["~orpc"].inputSchema!["~standard"];
    expect(await schema.validate({})).toMatchObject({ value: { after: 0, limit: 100, filter: {} } });
    expect(await schema.validate({ limit: 501 })).toHaveProperty("issues");
  });

  test("prs.commitDiff exige los dos extremos del detalle y un SHA de commit válido", async () => {
    const schema = contract.prs.commitDiff["~orpc"].inputSchema!["~standard"];
    const input = { id: "pr_test", sha: "a".repeat(40), head: "b".repeat(40), base: "c".repeat(40) };
    expect(await schema.validate(input)).toEqual({ value: input });
    expect(await schema.validate({ id: input.id, sha: input.sha })).toHaveProperty("issues");
    expect(await schema.validate({ ...input, sha: "--all" })).toHaveProperty("issues");
  });

  test("projects.create: un proyecto local no lleva trackerRef y uno de otro tracker lo necesita", async () => {
    const schema = contract.projects.create["~orpc"].inputSchema!["~standard"];
    const base = { slug: "demo", name: "Demo" };

    expect(await schema.validate({ ...base, tracker: "local" })).toMatchObject({
      value: { stackOn: "ci_green", flowParams: {}, repos: [], queueFilter: {}, conventions: {} },
    });
    expect(await schema.validate({ ...base, tracker: "local", maxCostUsd: 0 })).toHaveProperty("issues");
    expect(await schema.validate({ ...base, tracker: "local", trackerRef: "x" })).toHaveProperty("issues");
    expect(await schema.validate({ ...base, tracker: "linear" })).toHaveProperty("issues");
    expect(await schema.validate({ ...base, tracker: "linear", trackerRef: "BA" })).not.toHaveProperty("issues");
    expect(await schema.validate({ ...base, slug: "Mi Proyecto", tracker: "local" })).toHaveProperty("issues");
  });

  test("los tipos del cliente salen del contrato", () => {
    type Client = ContractRouterClient<Contract>;
    expectTypeOf<Awaited<ReturnType<Client["system"]["health"]>>["apiMajor"]>().toBeNumber();
    expectTypeOf<Awaited<ReturnType<Client["events"]["list"]>>>().toEqualTypeOf<Event[]>();
    expectTypeOf<Parameters<Client["system"]["shutdown"]>[0]>().toEqualTypeOf<{ drain: boolean }>();
    expectTypeOf<Awaited<ReturnType<Client["chats"]["get"]>>>().toEqualTypeOf<{
      chat: PrChat; messages: ChatMessage[]; proposal: ChatProposal | null;
    }>();
    expectTypeOf<Awaited<ReturnType<Client["chats"]["send"]>>>().toEqualTypeOf<PrChat>();
    expectTypeOf<Awaited<ReturnType<Client["chats"]["apply"]>>>().toEqualTypeOf<{ runId: RunId }>();
  });
});

describe("chats", () => {
  const ulid = "01J0000000000000000000000A";
  const chat: PrChat = {
    id: `chat_${ulid}`, prId: "pr-1", status: "active", runtime: "claude-sdk", model: "sonnet",
    busy: false, costMicros: 0, canApply: true,
  };
  const message: ChatMessage = { id: "message-1", role: "user", text: "Revisa el PR", at: 1_700_000_000_000 };
  const proposal: ChatProposal = {
    rev: 1, baseSha: "a".repeat(40), summary: "Corrige el contrato", status: "draft",
    items: [{ id: "item-1", change: "Ajustar el contrato", path: "src/contract.ts" }],
    files: [{ path: "src/contract.ts", additions: 3, deletions: 1 }, { path: "image.png", additions: null, deletions: null }],
  };

  test("ChatId usa el prefijo chat y un ULID", () => {
    expect(ChatId.parse(chat.id)).toBe(chat.id);
    for (const id of [`run_${ulid}`, "chat_123", ulid, `chat_${"I".repeat(26)}`]) {
      expect(ChatId.safeParse(id).success).toBe(false);
    }
  });

  test("PrChat acepta configuración, actividad, costo y razón del bloqueo", () => {
    expect(PrChat.parse(chat)).toEqual(chat);
    const blocked: PrChat = {
      ...chat, status: "archived", runtime: "opencode", model: "openai/gpt-6.1-terra",
      effort: "high", busy: true, costMicros: 25_000, canApply: false, applyReason: "El chat está archivado",
    };
    expect(PrChat.parse(blocked)).toEqual(blocked);
    for (const invalid of [
      { ...chat, id: "chat_123" }, { ...chat, prId: "" }, { ...chat, runtime: "unknown" },
      { ...chat, effort: "unknown" }, { ...chat, status: "done" }, { ...chat, costMicros: -1 },
      { ...chat, costMicros: 0.5 },
    ]) {
      expect(PrChat.safeParse(invalid).success).toBe(false);
    }
  });

  test("ChatMessage conserva el rol y las referencias opcionales a sesión y propuesta", () => {
    expect(ChatMessage.parse(message)).toEqual(message);
    const assistant: ChatMessage = { ...message, role: "assistant", sessionId: `ses_${ulid}`, proposalRev: 1 };
    expect(ChatMessage.parse(assistant)).toEqual(assistant);
    expect(ChatMessage.parse({ ...message, role: "system" }).role).toBe("system");
    for (const invalid of [
      { ...message, id: "" }, { ...message, role: "tool" }, { ...assistant, sessionId: `run_${ulid}` },
      { ...assistant, proposalRev: 0 }, { ...message, at: -1 },
    ]) {
      expect(ChatMessage.safeParse(invalid).success).toBe(false);
    }
  });

  test("ChatProposal conserva archivos binarios y el resultado de cada estado del restack", () => {
    expect(ChatProposal.parse(proposal)).toEqual(proposal);
    const applied: ChatProposal = {
      ...proposal, status: "applied", runId: `run_${ulid}`,
      result: {
        sha: "b".repeat(40),
        children: [
          { prId: "child-1", status: "restacked", head: "c".repeat(40) },
          { prId: "child-2", status: "uptodate" },
          { prId: "child-3", status: "conflict", files: ["src/contract.ts"], failures: "Conflicto al aplicar" },
          { prId: "child-4", status: "skipped", reason: "Tiene threads de council" },
        ],
      },
    };
    expect(ChatProposal.parse(applied)).toEqual(applied);
    for (const status of ["draft", "applying", "applied", "discarded", "stale", "failed"] as const) {
      expect(ChatProposal.parse({ ...proposal, status }).status).toBe(status);
    }
    for (const invalid of [
      { ...proposal, rev: 0 }, { ...proposal, runId: `ses_${ulid}` }, { ...proposal, status: "unknown" },
    ]) {
      expect(ChatProposal.safeParse(invalid).success).toBe(false);
    }
    for (const status of ["restacked", "conflict", "skipped", "unknown"]) {
      expect(ChatProposal.safeParse({
        ...applied, result: { sha: applied.result!.sha, children: [{ prId: "child-1", status }] },
      }).success).toBe(false);
    }
  });

  test("valida las entradas de los siete procedimientos sin exponerlos por MCP", async () => {
    for (const [procedure, input] of [
      [contract.chats.get, { prId: chat.prId }],
      [contract.chats.send, { chatId: chat.id, text: message.text }],
      [contract.chats.send, { chatId: chat.id, text: message.text, runtime: "opencode", model: "openai/gpt-6.1-terra", effort: "high" }],
      [contract.chats.interrupt, { chatId: chat.id }],
      [contract.chats.reset, { chatId: chat.id }],
      [contract.chats.proposal, { chatId: chat.id, rev: 1 }],
      [contract.chats.discard, { chatId: chat.id }],
      [contract.chats.apply, { chatId: chat.id, rev: 1 }],
    ] as const) {
      expect(await procedure["~orpc"].inputSchema!["~standard"].validate(input)).toEqual({ value: input });
      expect(procedure["~orpc"].meta.mcp).toBeUndefined();
    }
    for (const procedure of Object.values(contract.chats)) {
      expect(await procedure["~orpc"].inputSchema!["~standard"].validate({})).toHaveProperty("issues");
      expect(await procedure["~orpc"].inputSchema!["~standard"].validate({ chatId: "chat_123", prId: "", text: "x", rev: 1 })).toHaveProperty("issues");
    }
    const send = contract.chats.send["~orpc"].inputSchema!["~standard"];
    for (const patch of [{ text: "" }, { runtime: "unknown" }, { model: "" }, { effort: "unknown" }]) {
      expect(await send.validate({ chatId: chat.id, text: message.text, ...patch })).toHaveProperty("issues");
    }
    for (const procedure of [contract.chats.proposal, contract.chats.apply]) {
      for (const rev of [0, 0.5]) {
        expect(await procedure["~orpc"].inputSchema!["~standard"].validate({ chatId: chat.id, rev })).toHaveProperty("issues");
      }
    }
  });

  test("las salidas incluyen el chat, la propuesta opcional, el patch o la corrida", async () => {
    const get = contract.chats.get["~orpc"].outputSchema!["~standard"];
    for (const latest of [null, proposal]) {
      const snapshot = { chat, messages: [message], proposal: latest };
      expect(await get.validate(snapshot)).toEqual({ value: snapshot });
    }
    for (const procedure of [contract.chats.send, contract.chats.interrupt, contract.chats.reset, contract.chats.discard]) {
      expect(await procedure["~orpc"].outputSchema!["~standard"].validate(chat)).toEqual({ value: chat });
    }
    const diff = { patch: "diff --git a/src/contract.ts b/src/contract.ts", files: proposal.files };
    expect(await contract.chats.proposal["~orpc"].outputSchema!["~standard"].validate(diff)).toEqual({ value: diff });
    const apply = contract.chats.apply["~orpc"].outputSchema!["~standard"];
    expect(await apply.validate({ runId: `run_${ulid}` })).toEqual({ value: { runId: `run_${ulid}` } });
    expect(await apply.validate({ runId: "run_123" })).toHaveProperty("issues");
  });

  test("los seis eventos de chat comparten chatId y prId tipados", () => {
    for (const type of ["chat.message", "chat.turn_started", "chat.turn_finished", "chat.proposal", "chat.apply_started", "chat.apply_finished"] as const) {
      expect(EventType.parse(type)).toBe(type);
      expectTypeOf<PayloadOf<typeof type>>().toEqualTypeOf<{ chatId: ChatId; prId: string }>();
    }
  });
});

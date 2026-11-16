import { type ContractRouterClient, isContractProcedure } from "@orpc/contract";
import { describe, expect, expectTypeOf, test } from "vitest";
import { type Contract, type Event, contract } from "./index";

describe("contrato", () => {
  test("exporta los routers system, events, connections, artifacts, issues, trackers, projects, packs, prs, repos, runs, decisions, learnings, defs, metrics e imports con sus procedimientos", () => {
    expect(Object.keys(contract).sort()).toEqual([
      "artifacts",
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
    expect(Object.keys(contract.connections)).toEqual(["list", "setPat", "githubPatForm", "startDeviceFlow", "githubInstallations", "linearAuth", "testClaude", "setClaudeApiKey", "disconnect"]);
    expect(Object.keys(contract.system).sort()).toEqual(["breakers", "health", "info", "lanes", "setLanes", "shutdown"]);
    expect(Object.keys(contract.events).sort()).toEqual(["list", "stream"]);
    expect(Object.keys(contract.artifacts)).toEqual(["get"]);
    expect(Object.keys(contract.issues).sort()).toEqual(["createLocal", "get", "list"]);
    expect(Object.keys(contract.trackers)).toEqual(["projects"]);
    expect(Object.keys(contract.projects).sort()).toEqual(["boostIssue", "create", "defaults", "exportConfig", "get", "importConfig", "list", "pause", "queue", "resume", "setDefaults", "setParallel", "skipIssue", "summary", "update"]);
    expect(Object.keys(contract.packs)).toEqual(["list", "install", "remove"]);
    expect(Object.keys(contract.prs)).toEqual(["get", "list", "refresh", "setHold", "merge", "requestReview", "rebase"]);
    expect(Object.keys(contract.repos).sort()).toEqual(["add", "detect", "list", "syncConfig", "testRecipe"]);
    expect(Object.keys(contract.runs).sort()).toEqual(["cancel", "forceOutcome", "get", "interrupt", "list", "pause", "resume", "retryStep", "start", "steerStep", "step", "transcript"]);
    expect(Object.keys(contract.decisions).sort()).toEqual(["get", "list", "resolve"]);
    expect(Object.keys(contract.learnings).sort()).toEqual(["approve", "get", "list", "propose", "reject", "update"]);
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
  });
});

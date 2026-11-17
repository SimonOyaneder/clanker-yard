import { execFile, spawn, type ChildProcess } from "node:child_process";
import { cpSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { connectToCore, isPidAlive, readCoreJson } from "@clanker/api/node";
import { Client as McpClient } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { afterAll, afterEach, beforeAll, describe, expect, test, vi } from "vitest";
import type { CliContext } from "./command";
import { runCli } from "./cli";
import { buildCli } from "../scripts/build";

// Contra cores de verdad sobre un CLANKER_HOME temporal: el real (para `status` y el arranque) y el de
// demo del testkit con el runtime fake (para los comandos que lanzan corridas). El testkit se lanza como
// proceso, no se importa: la CLI solo depende de la API.
const repo = fileURLToPath(new URL("../../../", import.meta.url));
const run = promisify(execFile);

let buildDir: string;
let cliBundle: string;
let coreEntry: string;
let homes: string[] = [];
let children: ChildProcess[] = [];

beforeAll(async () => {
  buildDir = mkdtempSync(join(tmpdir(), "clanker-cli-build-"));
  cliBundle = await buildCli(join(buildDir, "cli", "clanker.js"));
  // El core busca sus migraciones en `../migrations` del bundle.
  coreEntry = join(buildDir, "core", "dist", "main.js");
  cpSync(join(repo, "packages/core/migrations"), join(buildDir, "core", "migrations"), { recursive: true });
  await run(process.execPath, ["scripts/build.ts", coreEntry], { cwd: join(repo, "packages/core") });
}, 60_000);

afterAll(() => rmSync(buildDir, { recursive: true, force: true }));

afterEach(async () => {
  for (const home of homes) {
    const info = readCoreJson(home);
    if (info && isPidAlive(info.pid)) {
      process.kill(info.pid, "SIGTERM");
      await vi.waitFor(() => expect(isPidAlive(info.pid)).toBe(false), { timeout: 10_000 });
    }
    rmSync(home, { recursive: true, force: true });
  }
  homes = [];
  for (const child of children) child.kill("SIGTERM");
  children = [];
});

function tempHome(): string {
  const home = mkdtempSync(join(tmpdir(), "clanker-cli-home-"));
  homes.push(home);
  return home;
}

describe("el binario clanker", () => {
  test("status sin core corriendo lo levanta y lo reutiliza la vez siguiente", async () => {
    const home = tempHome();
    const env = { ...process.env, CLANKER_HOME: home, CLANKER_CORE_ENTRY: coreEntry };
    expect(readCoreJson(home)).toBeUndefined();

    const first = await run(process.execPath, [cliBundle, "status", "--json"], { env });

    const info = readCoreJson(home)!;
    expect(isPidAlive(info.pid)).toBe(true);
    expect(JSON.parse(first.stdout)).toMatchObject({ pid: info.pid, dataDir: home, activeRuns: 0 });

    const second = await run(process.execPath, [cliBundle, "status"], { env });

    expect(second.stdout).toContain(`pid ${info.pid}`);
    expect(readCoreJson(home)!.bootId).toBe(info.bootId);
  }, 30_000);

  test("mcp es un puente stdio al core: lista las tools, las ejecuta y levanta el core si no corre", async () => {
    const home = tempHome();
    const env = Object.fromEntries(
      Object.entries({ ...process.env, CLANKER_HOME: home, CLANKER_CORE_ENTRY: coreEntry }).filter((e): e is [string, string] => e[1] !== undefined),
    );
    expect(readCoreJson(home)).toBeUndefined();
    const client = new McpClient({ name: "test", version: "0.0.0" });
    await client.connect(new StdioClientTransport({ command: process.execPath, args: [cliBundle, "mcp"], env }));

    const { tools } = await client.listTools();
    const result = await client.callTool({ name: "list", arguments: { kind: "flow" } });
    const { resources } = await client.listResources();
    await client.close();

    expect(tools.map((t) => t.name)).toEqual(expect.arrayContaining(["list", "get", "create", "update", "delete", "run_issue", "resolve_decision"]));
    expect(tools.filter((t) => t.annotations?.readOnlyHint).map((t) => t.name)).toEqual(["list", "get", "project_queue"]);
    expect(JSON.parse((result.content as { text: string }[])[0]!.text)).toEqual(expect.arrayContaining([expect.objectContaining({ kind: "flow", slug: "techlead-clasico" })]));
    expect(resources.map((r) => r.uri)).toContain("clanker://schema/run");
    expect(isPidAlive(readCoreJson(home)!.pid)).toBe(true);
  }, 30_000);

  test("sin core y sin el bundle del core explica cómo construirlo y sale con 1", async () => {
    const env = { ...process.env, CLANKER_HOME: tempHome(), CLANKER_CORE_ENTRY: join(buildDir, "no-existe.js") };

    const failure = await run(process.execPath, [cliBundle, "status"], { env }).catch((e: { code: number; stderr: string }) => e);

    expect(failure).toMatchObject({ code: 1 });
    expect((failure as { stderr: string }).stderr).toMatch(/no existe .*no-existe\.js\. Corre npm run build -w @clanker\/core/);
  });
});

describe("los comandos contra un core con runtime fake", () => {
  async function demoCore() {
    const home = tempHome();
    const demo = join(repo, "packages/testkit/scripts/demo-core.ts");
    children.push(spawn(join(repo, "node_modules/.bin/tsx"), [demo], { env: { ...process.env, CLANKER_HOME: home }, stdio: "ignore" }));
    const core = await vi.waitFor(async () => (await connectToCore(home, "cli")) ?? Promise.reject(new Error("el core de demo no responde")), {
      timeout: 30_000,
      interval: 100,
    });
    const out: string[] = [];
    const ctx: CliContext = {
      client: () => Promise.resolve(core.client),
      mcpEndpoint: () => Promise.resolve({ url: `http://127.0.0.1:${core.info.port}/mcp`, token: core.info.token }),
      write: (line) => out.push(line),
      readFile: () => "",
      sleep: () => Promise.resolve(),
      signal: new AbortController().signal,
    };
    const cli = async (...argv: string[]) => {
      out.length = 0;
      await runCli(argv, ctx);
      return out.join("\n");
    };
    return { client: core.client, cli };
  }

  test("projects list, runs start, runs get y events tail de una corrida", async () => {
    const { client, cli } = await demoCore();

    expect(await cli("projects", "list")).toMatch(/^Slug +Nombre +Tracker +Estado +Flujo +Cupo\ndemo +Demo +local +active +juguete +2$/);

    const [project] = await client.projects.list();
    const [issue] = await client.issues.list({ projectId: project!.id });
    const started = JSON.parse(await cli("runs", "start", "demo", issue!.ref.key, "--json")) as { id: string };
    expect(started.id).toMatch(/^run_/);

    const detail = await cli("runs", "get", started.id);
    expect(detail).toContain(`Corrida:  ${started.id}`);
    expect(detail).toContain("Flujo:    juguete@1");
    expect(detail).toContain(`Sujeto:   issue ${issue!.id}`);

    const events = await cli("events", "tail", "--run", started.id, "--type", "run.started");
    expect(events).toMatch(new RegExp(`run\\.started +cli +${started.id}`));
  }, 60_000);
});

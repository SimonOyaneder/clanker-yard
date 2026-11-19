import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test, vi } from "vitest";
import { launchCodexAppServer } from "./app-server";
import { CODEX_ARGS } from "./config";

const hasCodex = (() => {
  try {
    execFileSync("sh", ["-c", "command -v codex"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
})();

test.skipIf(!hasCodex)("initialize y account/read con sh y el home habitual, sin inferencia ni refresh", { timeout: 45_000 }, async () => {
  const server = await launchCodexAppServer({
    executable: "sh", args: ["-c", 'exec codex "$@"', "codex", ...CODEX_ARGS], cwd: process.cwd(),
  });
  try {
    const account = await server.request("account/read", { refreshToken: false });
    expect(typeof account.requiresOpenaiAuth).toBe("boolean");
  } finally {
    await server.close();
  }
});

test.skipIf(!hasCodex)("usa herramientas MCP de usuario y proyecto y respeta los servidores deshabilitados", { timeout: 60_000 }, async () => {
  const dir = await mkdtemp(join(tmpdir(), "codex-isolation-"));
  const home = join(dir, "home");
  const codexHome = join(home, ".codex");
  const cwd = join(dir, "project");
  const fixture = fileURLToPath(new URL("./mcp-server.fixture.ts", import.meta.url));
  const command = `command = ${JSON.stringify(process.execPath)}
args = [${JSON.stringify(fixture)}]`;
  const userConfig = `notify = ["sh", "-c", "exit 99"]
project_doc_max_bytes = 0
[features]
plugins = true
apps = true
codex_hooks = true
[projects.${JSON.stringify(cwd)}]
trust_level = "trusted"
[mcp_servers.user_sentinel]
${command}
[mcp_servers.disabled_sentinel]
enabled = false
${command}
`;
  const projectConfig = `[mcp_servers.project_sentinel]
${command}
`;
  try {
    await mkdir(codexHome, { recursive: true });
    await mkdir(join(cwd, ".codex"), { recursive: true });
    await writeFile(join(codexHome, "config.toml"), userConfig);
    await writeFile(join(cwd, ".codex", "config.toml"), projectConfig);
    await writeFile(join(cwd, "AGENTS.md"), "Usa el reporte solicitado por Clanker Yard.");
    const server = await launchCodexAppServer({ cwd, baseEnv: { PATH: process.env.PATH, HOME: home, CODEX_HOME: codexHome, USER: process.env.USER } });
    try {
      const effective = await server.request("config/read", { cwd });
      expect(effective.config).toMatchObject({
        notify: [],
        features: { plugins: false, apps: false, codex_hooks: false },
      });
      const { thread, instructionSources } = await server.request("thread/start", { cwd, sandbox: "read-only" });
      expect(instructionSources).toContain(join(cwd, "AGENTS.md"));
      await vi.waitFor(async () => {
        const inventory = await server.request("mcpServerStatus/list", { threadId: thread.id });
        expect(Object.fromEntries(inventory.data.map((entry) => [entry.name, entry.runtimeStatus]))).toMatchObject({
          project_sentinel: "connected", user_sentinel: "connected", disabled_sentinel: "disabled",
        });
      }, { timeout: 15_000 });
      for (const name of ["user_sentinel", "project_sentinel"]) {
        const result = await server.request("mcpServer/tool/call", { threadId: thread.id, server: name, tool: "ping", arguments: {} });
        expect(result.content).toEqual([{ type: "text", text: "pong" }]);
      }
      expect(existsSync(join(codexHome, "auth.json"))).toBe(false);
      expect(await readFile(join(codexHome, "config.toml"), "utf8")).toBe(userConfig);
      expect(await readFile(join(cwd, ".codex", "config.toml"), "utf8")).toBe(projectConfig);
    } finally {
      await server.close();
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

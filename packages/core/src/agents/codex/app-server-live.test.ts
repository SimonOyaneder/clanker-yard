import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
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

test.skipIf(!hasCodex)("aísla MCP de usuario y proyecto, notify, hooks y plugins en un home sin credenciales", { timeout: 60_000 }, async () => {
  const dir = await mkdtemp(join(tmpdir(), "codex-isolation-"));
  const home = join(dir, "home");
  const codexHome = join(home, ".codex");
  const cwd = join(dir, "project");
  const marker = join(dir, "mcp-started");
  const userConfig = `notify = ["sh", "-c", "exit 99"]
[features]
plugins = true
apps = true
codex_hooks = true
[projects.${JSON.stringify(cwd)}]
trust_level = "trusted"
[mcp_servers.user_sentinel]
command = "sh"
args = ["-c", ${JSON.stringify(`touch '${marker}'; exit 1`)}]
`;
  const projectConfig = `[mcp_servers.project_sentinel]
command = "sh"
args = ["-c", ${JSON.stringify(`touch '${marker}'; exit 1`)}]
`;
  try {
    await mkdir(codexHome, { recursive: true });
    await mkdir(join(cwd, ".codex"), { recursive: true });
    await writeFile(join(codexHome, "config.toml"), userConfig);
    await writeFile(join(cwd, ".codex", "config.toml"), projectConfig);
    const server = await launchCodexAppServer({ cwd, baseEnv: { PATH: process.env.PATH, HOME: home, CODEX_HOME: codexHome, USER: process.env.USER } });
    try {
      const effective = await server.request("config/read", { cwd });
      expect(effective.config).toMatchObject({
        notify: [],
        features: { plugins: false, apps: false, codex_hooks: false },
        mcp_servers: { user_sentinel: { command: "sh" }, project_sentinel: { command: "sh" } },
      });
      const { thread } = await server.request("thread/start", { cwd, sandbox: "read-only" });
      const inventory = await server.request("mcpServerStatus/list", { threadId: thread.id });
      expect(inventory.data.map(({ name, runtimeStatus }) => ({ name, runtimeStatus }))).toEqual([
        { name: "project_sentinel", runtimeStatus: "disabled" },
        { name: "user_sentinel", runtimeStatus: "disabled" },
      ]);
      expect(existsSync(marker)).toBe(false);
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

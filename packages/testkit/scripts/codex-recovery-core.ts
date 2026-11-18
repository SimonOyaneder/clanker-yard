import { spawn } from "node:child_process";
import { join } from "node:path";
import { createCodexRuntime, createConnections, createFileSecrets, createProcs, newId, openStore } from "@clanker/core";
import { startCore } from "../src/start-core";

const [mode, home, executable, ...args] = process.argv.slice(2);
if (!home || !executable) throw new Error("Faltan home y executable");

if (mode === "server") {
  const child = spawn(executable, args, { stdio: ["pipe", "pipe", "pipe"] });
  process.stdin.pipe(child.stdin, { end: false });
  child.stdout.pipe(process.stdout);
  child.stderr.pipe(process.stderr);
  child.once("error", () => process.exit(1));
  child.once("exit", (code) => process.exit(code ?? 1));
} else {
  const store = openStore({ path: join(home, "clanker.db") });
  const procs = createProcs({ store, bootId: newId("boot") });
  const runtime = createCodexRuntime({
    home, store, procs, executable: process.execPath,
    args: ["--import", import.meta.resolve("tsx"), process.argv[1]!, "server", home, executable, ...args],
    baseEnv: { PATH: process.env.PATH, HOME: home },
  });
  const core = await startCore({
    store, procs, dataDir: home, runtimes: [runtime], env: {}, scheduler: false,
    connections: createConnections({ store, secrets: createFileSecrets({ dir: join(home, "secrets") }) }),
    coreVersion: "0.0.0", onShutdown: () => {},
  });
  process.on("message", () => {
    void core.close().then(() => {
      store.close();
      process.exit(0);
    }).catch((error: unknown) => {
      console.error(error);
      process.exit(1);
    });
  });
  process.send!({ url: core.server.url, token: core.server.token });
}

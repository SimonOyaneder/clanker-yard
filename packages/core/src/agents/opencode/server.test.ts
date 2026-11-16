import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { launchOpencodeServer } from "./server";

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "opencode-serve-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

/** Un `opencode` de mentira: un sh real que imprime lo que imprime `opencode serve` y lanza un hijo (como un comando del agente). */
async function fakeOpencode(body: string): Promise<string> {
  const file = join(dir, "opencode");
  await writeFile(file, `#!/bin/sh\n${body}\n`);
  await chmod(file, 0o755);
  return file;
}

const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

test("espera a que escuche, lee la URL y al cerrar baja el grupo entero", async () => {
  const pidFile = join(dir, "child.pid");
  const executable = await fakeOpencode(
    `echo "Warning: OPENCODE_SERVER_PASSWORD is not set"\nsleep 300 &\necho $! > "${pidFile}"\necho "opencode server listening on http://127.0.0.1:59454"\nwait`,
  );

  const server = await launchOpencodeServer({ executable, args: ["serve"], env: { PATH: process.env.PATH ?? "" }, cwd: dir, killAfterMs: 1000 });
  expect(server.url).toBe("http://127.0.0.1:59454");
  const child = Number((await import("node:fs/promises").then((fs) => fs.readFile(pidFile, "utf8"))).trim());
  expect(alive(child)).toBe(true);

  server.close();
  await server.exited;
  await vi.waitFor(() => expect(alive(child)).toBe(false), { timeout: 5000 });
});

test("si muere antes de escuchar, rechaza con lo que escribió", async () => {
  const executable = await fakeOpencode(`echo "Error: config inválida en opencode.jsonc" >&2\nexit 1`);

  await expect(launchOpencodeServer({ executable, args: ["serve"], env: {}, cwd: dir })).rejects.toThrow(/código 1.*config inválida/s);
});

test("sin el binario dice cómo instalarlo", async () => {
  await expect(launchOpencodeServer({ executable: join(dir, "no-existe"), args: ["serve"], env: {}, cwd: dir })).rejects.toThrow(/instala opencode/);
});

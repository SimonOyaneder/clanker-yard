import assert from "node:assert/strict";
import fs from "node:fs";
import fsPromises from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { join } from "node:path";
import { mock } from "node:test";
import { launchCodexAppServer } from "./app-server";

const [cwd, codexHome, executable, script, accountEmail] = process.argv.slice(2) as [string, string, string, string, string];
const reads = [
  mock.method(fsPromises, "readFile"),
  mock.method(fs, "readFile"),
  mock.method(fs, "readFileSync"),
];
syncBuiltinESMExports();

const server = await launchCodexAppServer({
  cwd,
  executable,
  args: [script],
  baseEnv: { HOME: cwd, CODEX_HOME: codexHome, PATH: process.env.PATH },
});
try {
  const account = await server.request("account/read", { refreshToken: false });
  assert.equal(account.account?.type, "chatgpt");
  assert.ok(account.account && "email" in account.account);
  assert.equal(account.account.email, accountEmail);
} finally {
  await server.close();
}
assert.ok(!reads.flatMap((read) => read.mock.calls.map((call) => String(call.arguments[0]))).includes(join(codexHome, "auth.json")));

import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { afterEach, expect, test } from "vitest";
import { apiKeyCredentials, findClaude, subscriptionCredentials } from "./credentials";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tmp(): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "claude-cred-")));
  dirs.push(dir);
  return dir;
}

test("findClaude resuelve el symlink del primer claude ejecutable del PATH", () => {
  const root = tmp();
  mkdirSync(join(root, "versions"));
  mkdirSync(join(root, "bin"));
  const real = join(root, "versions", "2.1.325");
  writeFileSync(real, "#!/bin/sh\n");
  chmodSync(real, 0o755);
  symlinkSync(real, join(root, "bin", "claude"));

  expect(findClaude({ PATH: [join(root, "nada"), join(root, "bin")].join(delimiter) })).toBe(real);
});

test("findClaude no inventa uno: sin claude en el PATH devuelve undefined", () => {
  expect(findClaude({ PATH: tmp() })).toBeUndefined();
  expect(findClaude({})).toBeUndefined();
});

test("la suscripción no aporta variables de credencial; la API key sí", () => {
  const subscription = subscriptionCredentials({ executable: "/bin/claude" });
  expect(subscription).toMatchObject({ mode: "subscription", executable: "/bin/claude" });
  expect(subscription.env()).toEqual({});
  expect(apiKeyCredentials("sk-x", { executable: "/bin/claude" }).env()).toEqual({ ANTHROPIC_API_KEY: "sk-x" });
});

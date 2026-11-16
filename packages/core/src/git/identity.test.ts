import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { createConnections } from "../connections/connections";
import { healthyGitHub, startFakeGitHub, type FakeGitHub } from "../github/fake-github";
import { createFileSecrets } from "../secrets/encrypted-file";
import { openStore, type Store } from "../store/store";
import type { RepoConfig } from "../workspaces/workspaces";
import { createGitIdentityOf } from "./identity";

let dir: string;
let home: string;
let store: Store;
let github: FakeGitHub | undefined;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "clanker-identity-"));
  // La config global del git de quien corre el test no cuenta: HOME es una carpeta vacía propia.
  home = join(dir, "home");
  mkdirSync(home);
  vi.stubEnv("HOME", home);
  vi.stubEnv("XDG_CONFIG_HOME", join(home, ".config"));
  store = openStore({ path: ":memory:" });
});

afterEach(async () => {
  vi.unstubAllEnvs();
  await github?.close();
  github = undefined;
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

function checkout(config: Record<string, string> = {}): string {
  const path = join(dir, "repo");
  mkdirSync(path);
  execFileSync("git", ["init", "--quiet", path], { env: { PATH: process.env.PATH, HOME: home } });
  for (const [key, value] of Object.entries(config)) {
    execFileSync("git", ["-C", path, "config", "--local", key, value], { env: { PATH: process.env.PATH, HOME: home } });
  }
  return path;
}

async function identities(path: string, remote?: RepoConfig["remote"]) {
  github = await startFakeGitHub(healthyGitHub());
  const connections = createConnections(store, createFileSecrets({ dir }), { github: { baseUrl: github.baseUrl } });
  await connections.setPat("github_pat_UNIQUE-0123456789", "ui");
  const repos = vi.fn((): RepoConfig => ({ path, defaultBranch: "main", remote }));
  return { identityOf: createGitIdentityOf({ repos, connections }), repos };
}

const REMOTE = { url: "https://github.com/octocat/demo.git", repo: "octocat/demo", account: "octocat" };

describe("createGitIdentityOf", () => {
  test("sale de git config del checkout, sin tocar GitHub", async () => {
    const { identityOf } = await identities(checkout({ "user.name": "Ana Pérez", "user.email": "ana@example.com" }), REMOTE);
    const before = github!.requests.length;

    expect(await identityOf("r1")).toEqual({ name: "Ana Pérez", email: "ana@example.com" });
    expect(github!.requests).toHaveLength(before);
  });

  test("respeta la config global igual que si el usuario commiteara", async () => {
    writeFileSync(join(home, ".gitconfig"), "[user]\n\tname = Beto Soto\n\temail = beto@example.com\n");
    const { identityOf } = await identities(checkout(), REMOTE);

    expect(await identityOf("r1")).toEqual({ name: "Beto Soto", email: "beto@example.com" });
  });

  test("sin email usa el noreply de la cuenta de GitHub conectada y el nombre configurado", async () => {
    const { identityOf } = await identities(checkout({ "user.name": "Ana Pérez" }), REMOTE);

    expect(await identityOf("r1")).toEqual({ name: "Ana Pérez", email: "583231+octocat@users.noreply.github.com" });
  });

  test("sin nada configurado usa el nombre del perfil de GitHub", async () => {
    const { identityOf } = await identities(checkout(), REMOTE);

    expect(await identityOf("r1")).toEqual({ name: "The Octocat", email: "583231+octocat@users.noreply.github.com" });
  });

  test("sin email ni cuenta de GitHub falla diciendo qué configurar, no inventa una identidad", async () => {
    const { identityOf } = await identities(checkout());

    await expect(identityOf("r1")).rejects.toThrow(/configura user\.name y user\.email/);
  });

  test("se resuelve una vez por repo", async () => {
    const { identityOf, repos } = await identities(checkout({ "user.name": "Ana Pérez", "user.email": "ana@example.com" }));

    await identityOf("r1");
    await identityOf("r1");

    expect(repos).toHaveBeenCalledTimes(1);
  });
});

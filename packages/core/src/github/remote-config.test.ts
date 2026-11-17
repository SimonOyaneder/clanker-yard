import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, test } from "vitest";
import { createConnections, type Connections } from "../connections/connections";
import { createFileSecrets } from "../secrets/encrypted-file";
import { openStore, type Store } from "../store/store";
import { createRepos } from "../repos/repos";
import { githubRemote, githubUrl } from "./remote-config";

let dir: string;
let store: Store;
let connections: Connections;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "clanker-remote-config-"));
  store = openStore({ path: ":memory:" });
  connections = createConnections({ store, secrets: createFileSecrets({ dir: join(dir, "secrets") }) });
});

afterEach(() => {
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

const connect = (account: string) => connections.connect({ provider: "github", account, scopes: [], token: `ghp_${account}` }, "core");

test("el remoto es la URL explícita del repo y la cuenta de GitHub conectada", async () => {
  await connect("simon");

  expect(githubRemote(connections)("acme/web")).toEqual({ url: "https://github.com/acme/web.git", repo: "acme/web", account: "simon" });
  expect(githubUrl("acme/web")).toBe("https://github.com/acme/web.git");
});

test("con varias cuentas gana la de la org del repo y, si ninguna calza, una conectada", async () => {
  await connect("simon");
  await connect("acme");

  expect(githubRemote(connections)("acme/web")?.account).toBe("acme");
  expect(["simon", "acme"]).toContain(githubRemote(connections)("otra/web")?.account);
});

test("sin una cuenta de GitHub conectada el repo no tiene remoto", () => {
  expect(githubRemote(connections)("acme/web")).toBeUndefined();
});

test("repos.config llena remote desde la columna repos.remote y lo deja vacío sin ella", async () => {
  await connect("simon");
  const repos = createRepos({ store, remote: githubRemote(connections, (repo) => `file:///bares/${repo}`) });
  const withRemote = repos.add({ name: "web", path: "/a", remote: "acme/web" });
  const without = repos.add({ name: "solo", path: "/b" });

  expect(repos.config(withRemote).remote).toEqual({ url: "file:///bares/acme/web", repo: "acme/web", account: "simon" });
  expect(repos.config(without).remote).toBeUndefined();
});

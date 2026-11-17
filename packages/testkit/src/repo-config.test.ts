import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { join } from "node:path";
import { createClient, type Client, type DefRecord, type RepoId } from "@clanker/api";
import { createConnections, createFileSecrets, createRepos, openStore, type Core, type Store } from "@clanker/core";
import { ORPCError } from "@orpc/server";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { createFakeRuntime } from "./fake-runtime";
import { tempGitRepo, type TempGitRepo } from "./git";
import { startGitHubSim, type GitHubSim } from "./github-sim";
import { seedDb, type TestHome } from "./home";
import { startCore } from "./start-core";

// `.clanker/` viaja con el repo: se exporta desde una máquina (PR en draft contra el GitHub simulado y un bare local)
// y aparece en otra al registrar el mismo repo. Nunca GitHub ni tokens reales.

vi.setConfig({ testTimeout: 30_000 });

const TOKEN = "github_pat_UNIQUE-0123456789";
const ACCOUNT = "octocat";
const REPO = "octocat/secret-project";

interface Machine {
  home: TestHome;
  store: Store;
  core: Core;
  client: Client;
  repoId: RepoId;
}

let repo: TempGitRepo;
let github: GitHubSim;
const machines: Machine[] = [];

beforeEach(async () => {
  repo = tempGitRepo({ remote: true, commits: [{ message: "chore: base", files: { "README.md": "hola\n" } }] });
  github = await startGitHubSim({ origin: repo, repo: REPO, token: TOKEN });
});

afterEach(async () => {
  for (const { core, store, home } of machines.splice(0)) {
    await core.close();
    store.close();
    home.cleanup();
  }
  await github.close();
  repo.cleanup();
});

/** Una máquina con su propio core y base, que registra `checkout` como el repo `REPO`. */
async function boot(checkout: TempGitRepo): Promise<Machine> {
  const home = seedDb("empty");
  const store = openStore({ path: home.dbPath });
  const connections = createConnections({ store, secrets: createFileSecrets({ dir: join(home.path, "secrets") }), github: { baseUrl: github.baseUrl } });
  await connections.connect({ provider: "github", account: ACCOUNT, scopes: [], token: TOKEN }, "core");
  const repoId = createRepos({ store }).add({ name: "secret-project", path: checkout.dir, remote: REPO });
  const core = await startCore({
    store,
    dataDir: home.path,
    connections,
    runtimes: [createFakeRuntime({ fixtures: home.path, speed: Infinity })],
    env: { CORE_RUNTIME: "fake" },
    scheduler: false,
    gitUrl: () => `file://${repo.remoteDir}`,
    coreVersion: "0.0.0",
    onShutdown: () => {},
  });
  const machine = { home, store, core, repoId, client: createClient({ url: core.server.url, token: core.server.token, origin: "cli" }) };
  machines.push(machine);
  return machine;
}

const badRequest = (message: RegExp) => (e: unknown) => e instanceof ORPCError && e.code === "BAD_REQUEST" && message.test(e.message);

/** Una copia propia de la primera def del kind que no es de nadie más (las de la plantilla `juguete`). */
async function ownCopyOf(client: Client, kind: "flow" | "role", slug: string): Promise<DefRecord> {
  const original = (await client.defs.list({ kind, includeArchived: false }))[0]!;
  const body = kind === "flow" ? { ...(original.body as object), id: slug } : original.body;
  const { def } = await client.defs.create({ kind, slug, body, dryRun: false });
  return def!;
}

/** Lo que GitHub hace al mergear: la branch del PR pasa a ser `main` del remoto, y el checkout la trae. */
function mergePr(branch: string) {
  repo.git("fetch", "origin", branch);
  repo.git("merge", "--ff-only", "FETCH_HEAD");
  repo.git("push", "origin", "main");
}

describe("exportar al repo y recibirlo en otra máquina", () => {
  test("un flujo, un rol y un perfil propios salen en PRs en draft y llegan al registrar el mismo repo", async () => {
    const a = await boot(repo);
    const flow = await ownCopyOf(a.client, "flow", "mi-flujo");
    const role = await ownCopyOf(a.client, "role", "mi-rol");
    const profile = (await a.client.defs.create({ kind: "profile", slug: "mi-perfil", body: { roles: { dev: { model: "sonnet" } } }, dryRun: false })).def!;

    const exported = [];
    for (const def of [flow, role, profile]) {
      exported.push(await a.client.defs.exportToRepo({ kind: def.kind as "flow", id: def.id, repoId: a.repoId }));
      mergePr(exported.at(-1)!.branch);
    }

    expect(exported.map((e) => e.path)).toEqual([".clanker/flows/mi-flujo.json", ".clanker/roles/mi-rol.md", ".clanker/profiles/mi-perfil.json"]);
    expect(github.pulls()).toHaveLength(3);
    expect(github.pulls()[0]).toMatchObject({ draft: true, base: { ref: "main" }, head: { ref: exported[0]!.branch }, title: "feat: agregar el flujo mi-flujo en .clanker" });
    expect(github.pulls()[0]!.body).toContain("la configuración que viaja con el repo");
    // El checkout del usuario no quedó con branches ni worktrees del export.
    expect(repo.git("worktree", "list").split("\n")).toHaveLength(1);
    expect(repo.git("branch", "--list", "clanker/*")).toBe("");

    // Otra máquina registra el mismo repo y recibe lo exportado.
    const b = await boot(repo);
    const synced = await b.client.repos.syncConfig({ repoId: b.repoId });
    // El core también lo carga solo al arrancar: aquí no importa quién llegó primero, sino que no queden errores.
    expect(synced).toMatchObject({ archived: 0, errors: [] });
    const flows = (await b.client.defs.list({ kind: "flow", includeArchived: false })).filter((d) => d.scope === "repo");
    expect(flows).toMatchObject([{ slug: "mi-flujo", repoId: b.repoId, source: expect.stringMatching(/^repo:\.clanker\/flows\/mi-flujo\.json@[0-9a-f]{12}$/), body: { id: "mi-flujo" } }]);
    expect((await b.client.defs.list({ kind: "role", includeArchived: false })).find((d) => d.slug === "mi-rol")).toMatchObject({ scope: "repo", body: role.body });
    expect((await b.client.defs.list({ kind: "profile", includeArchived: false })).find((d) => d.slug === "mi-perfil")).toMatchObject({ scope: "repo", body: profile.body });

    // Sin cambios no hay nada nuevo; si el archivo se va, la def se archiva.
    expect(await b.client.repos.syncConfig({ repoId: b.repoId })).toMatchObject({ loaded: 0, archived: 0 });
    repo.git("rm", "-q", ".clanker/profiles/mi-perfil.json");
    repo.git("commit", "-q", "-m", "chore: quitar perfil");
    repo.git("push", "-q", "origin", "main");
    expect(await b.client.repos.syncConfig({ repoId: b.repoId })).toMatchObject({ loaded: 0, archived: 1 });
    expect((await b.client.defs.list({ kind: "profile", includeArchived: false })).find((d) => d.slug === "mi-perfil")).toBeUndefined();
  });

  test("un archivo inválido sale con su ruta y no frena a los demás ni toca lo que ya estaba", async () => {
    const files = { ".clanker/profiles/roto.json": "{ no es json", ".clanker/profiles/bueno.json": JSON.stringify({ roles: { dev: { model: "sonnet" } } }), ".clanker/roles/sin-prompt.md": "texto suelto" };
    for (const [path, content] of Object.entries(files)) {
      mkdirSync(dirname(join(repo.dir, path)), { recursive: true });
      writeFileSync(join(repo.dir, path), content);
    }
    repo.git("add", "--all");
    repo.git("commit", "-q", "-m", "chore: config");
    repo.git("push", "-q", "origin", "main");
    const b = await boot(repo);

    const synced = await b.client.repos.syncConfig({ repoId: b.repoId });

    expect(synced.errors.map((e) => e.file).sort()).toEqual([".clanker/profiles/roto.json", ".clanker/roles/sin-prompt.md"]);
    expect(synced.errors.find((e) => e.file.endsWith("roto.json"))!.message).toMatch(/no es JSON/);
    expect((await b.client.defs.list({ kind: "profile", includeArchived: false })).map((d) => d.slug)).toContain("bueno");
  });

  test("exportar lo que no es propio, o lo que ya está igual en el repo, es un error que dice qué hacer", async () => {
    const a = await boot(repo);
    await expect(a.client.defs.exportToRepo({ kind: "flow", id: (await a.client.defs.list({ kind: "flow", includeArchived: false }))[0]!.id, repoId: a.repoId })).rejects.toSatisfy(badRequest(/solo se exporta lo tuyo/));

    const mine = (await a.client.defs.create({ kind: "profile", slug: "mi-perfil", body: { roles: { dev: { model: "sonnet" } } }, dryRun: false })).def!;
    const first = await a.client.defs.exportToRepo({ kind: "profile", id: mine.id, repoId: a.repoId });
    mergePr(first.branch);
    await expect(a.client.defs.exportToRepo({ kind: "profile", id: mine.id, repoId: a.repoId })).rejects.toSatisfy(badRequest(/ya está igual/));

    // Un cambio posterior sale como actualización del mismo archivo.
    await a.client.defs.update({ kind: "profile", id: mine.id, body: { roles: { dev: { model: "opus" } } }, dryRun: false });
    const second = await a.client.defs.exportToRepo({ kind: "profile", id: mine.id, repoId: a.repoId });
    expect(github.pulls().at(-1)).toMatchObject({ title: "feat: actualizar el perfil mi-perfil en .clanker" });
    expect(second.path).toBe(first.path);
  });
});

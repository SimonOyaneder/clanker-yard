import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createWorkspaces, newId, openStore, preparePush, type Store, type WorkspaceLease, type Workspaces } from "@clanker/core";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { tempGitRepo, type TempGitRepo } from "./git";

// Se prueba aquí y no en el core: necesita repos git reales (tempGitRepo).

let dataDir: string;
let store: Store;
let repo: TempGitRepo;
let workspaces: Workspaces;
let lease: WorkspaceLease;

beforeEach(async () => {
  dataDir = mkdtempSync(join(tmpdir(), "clanker-prepare-push-"));
  store = openStore({ path: ":memory:" });
  repo = tempGitRepo({ commits: [{ message: "chore: base", files: { "a.txt": "a\n", "b.txt": "b\n" } }] });
  workspaces = createWorkspaces({
    store,
    dataDir,
    repoConfig: () => ({ path: repo.dir, defaultBranch: "main" }),
    identityOf: async () => ({ name: "Ana Pérez", email: "ana@example.com" }),
  });
  lease = await workspaces.acquire({ repo: "repo_r1", branch: "cla-47", base: "main", runId: newId("run") });
});

afterEach(() => {
  workspaces.release(lease);
  repo.cleanup();
  store.close();
  rmSync(dataDir, { recursive: true, force: true });
});

const git = (...args: string[]) => repo.git("-C", lease.path, ...args);
const head = () => git("rev-parse", "HEAD");
const subjects = () => git("log", "--format=%s", `${lease.baseSha}..HEAD`).split("\n").filter(Boolean).reverse();

function write(path: string, content: string) {
  const full = join(lease.path, path);
  mkdirSync(dirname(full), { recursive: true });
  writeFileSync(full, content);
}

/** Un commit como lo haría el agente: escribe `path` y commitea. */
function commit(message: string, path: string, content: string): string {
  write(path, content);
  git("add", "--all");
  git("commit", "--message", message);
  return head();
}

function prepare(knownSha: string, { council = false } = {}) {
  return preparePush(workspaces, lease, { knownSha, base: lease.baseSha, council });
}

describe("squash", () => {
  test("un fixup! que es el HEAD se funde en su commit (bug de SIGPIPE)", async () => {
    commit("feat: uno", "x.txt", "1\n");
    commit("feat: dos", "y.txt", "2\n");
    const known = head();
    commit("fixup! feat: uno", "x.txt", "1 corregido\n");
    const tree = git("rev-parse", "HEAD^{tree}");

    const result = await prepare(known);

    expect(result).toEqual({ outcome: "ok", head: head(), squashed: true });
    expect(subjects()).toEqual(["feat: uno", "feat: dos"]);
    expect(git("rev-parse", "HEAD^{tree}")).toBe(tree);
    expect(git("show", "HEAD~1:x.txt")).toBe("1 corregido");
  });

  test("con fixups en medio los funde y el árbol queda igual", async () => {
    commit("feat: uno", "x.txt", "1\n");
    commit("feat: dos", "y.txt", "2\n");
    const known = head();
    commit("fixup! feat: uno", "x.txt", "1 corregido\n");
    commit("fixup! feat: dos", "y.txt", "2 corregido\n");

    const result = await prepare(known);

    expect(result).toMatchObject({ outcome: "ok", squashed: true });
    expect(subjects()).toEqual(["feat: uno", "feat: dos"]);
  });

  test("sin fixups no reescribe nada", async () => {
    commit("feat: uno", "x.txt", "1\n");
    const before = head();

    expect(await prepare(before)).toEqual({ outcome: "ok", head: before, squashed: false });
    expect(head()).toBe(before);
  });

  test("un conflicto vuelve al sha anterior", async () => {
    commit("feat: uno", "x.txt", "1\n");
    commit("feat: dos", "x.txt", "1\ndos\n");
    const known = head();
    // El fixup! de `uno` toca la línea que `dos` agregó después: al moverlo choca.
    commit("fixup! feat: uno", "x.txt", "1\ndos editado\n");
    const before = head();

    const result = await prepare(known);

    expect(result).toMatchObject({ outcome: "squash-failed", failures: expect.stringContaining("autosquash falló") });
    expect(head()).toBe(before);
    expect(git("status", "--porcelain")).toBe("");
    expect(() => git("rev-parse", "--verify", "REBASE_HEAD")).toThrow();
  });

  test("un árbol distinto después del autosquash vuelve al sha anterior", async () => {
    // Un merge driver del repo que se queda con "ours": el rebase termina sin conflicto pero pierde cambios.
    git("config", "merge.keep.driver", "true");
    write(".gitattributes", "x.txt merge=keep\n");
    commit("chore: attrs", "x.txt", "1\n2\n3\n4\n5\n6\n7\n8\n9\n");
    commit("feat: uno", "x.txt", "A\n2\n3\n4\n5\n6\n7\n8\n9\n");
    commit("feat: dos", "x.txt", "A\n2\n3\n4\n5\n6\n7\n8\nB\n");
    const known = head();
    commit("fixup! feat: uno", "x.txt", "A\n2\n3\n4\n5\nF\n7\n8\nB\n");
    const before = head();

    const result = await prepare(known);

    expect(result).toMatchObject({ outcome: "squash-failed", failures: expect.stringContaining("cambió el árbol") });
    expect(head()).toBe(before);
    expect(git("status", "--porcelain")).toBe("");
  });

  test("con cambios sin commitear no hay squash, aunque el git del usuario tenga rebase.autoStash", async () => {
    // El git del core lee el ~/.gitconfig del usuario: con autoStash el rebase guardaría los cambios y
    // el `reset --hard` de un squash fallido (aquí, árbol distinto) los borraría.
    git("config", "rebase.autoStash", "true");
    git("config", "merge.keep.driver", "true");
    write(".gitattributes", "x.txt merge=keep\n");
    commit("chore: attrs", "x.txt", "1\n2\n3\n4\n5\n6\n7\n8\n9\n");
    commit("feat: uno", "x.txt", "A\n2\n3\n4\n5\n6\n7\n8\n9\n");
    commit("feat: dos", "x.txt", "A\n2\n3\n4\n5\n6\n7\n8\nB\n");
    const known = commit("fixup! feat: uno", "x.txt", "A\n2\n3\n4\n5\nF\n7\n8\nB\n");
    write("a.txt", "sin commitear\n");

    const result = await prepare(known);

    expect(result).toMatchObject({ outcome: "squash-failed", failures: expect.stringContaining("autosquash falló") });
    expect(head()).toBe(known);
    expect(git("status", "--porcelain")).toBe(" M a.txt");
    expect(git("stash", "list")).toBe("");
  });

  test("un fixup! sin commit destino no se deja pasar", async () => {
    commit("feat: uno", "x.txt", "1\n");
    const known = head();
    commit("fixup! feat: otro", "x.txt", "2\n");
    const before = head();

    const result = await prepare(known);

    expect(result).toMatchObject({ outcome: "squash-failed", failures: expect.stringContaining("fixup! feat: otro") });
    expect(head()).toBe(before);
  });

  test("con council no hay squash: los fixup! quedan", async () => {
    commit("feat: uno", "x.txt", "1\n");
    const known = head();
    commit("fixup! feat: uno", "x.txt", "1 corregido\n");
    const before = head();

    expect(await prepare(known, { council: true })).toEqual({ outcome: "ok", head: before, squashed: false });
    expect(subjects()).toEqual(["feat: uno", "fixup! feat: uno"]);
  });
});

describe("commits del agente", () => {
  test("se aceptan si descienden del último sha conocido y su árbol es el del worktree", async () => {
    const known = commit("feat: uno", "x.txt", "1\n");
    commit("feat: dos", "y.txt", "2\n");
    const agentHead = head();

    expect(await prepare(known)).toEqual({ outcome: "ok", head: agentHead, squashed: false });
    expect(head()).toBe(agentHead);
  });

  test("se rechazan si el worktree tiene cambios que no commitearon", async () => {
    const known = commit("feat: uno", "x.txt", "1\n");
    commit("feat: dos", "y.txt", "2\n");
    write("z.txt", "sin commitear\n");

    const result = await prepare(known);

    expect(result).toMatchObject({ outcome: "replan", failures: expect.stringContaining("cambios sin commitear") });
    // La branch vuelve al sha conocido y el trabajo del agente queda en el worktree para el committer.
    expect(head()).toBe(known);
    expect(git("status", "--porcelain").split("\n").sort()).toEqual(["?? y.txt", "?? z.txt"]);
  });

  test("se rechazan si no descienden del último sha conocido", async () => {
    commit("feat: uno", "x.txt", "1\n");
    const known = commit("feat: dos", "y.txt", "2\n");
    // El agente reescribió la historia: `dos` ahora es otro commit sobre la base.
    git("reset", "--hard", lease.baseSha);
    commit("feat: dos otra vez", "y.txt", "2\n");

    const result = await prepare(known);

    expect(result).toMatchObject({ outcome: "replan", failures: expect.stringContaining("no desciende") });
    expect(head()).toBe(known);
    // El worktree sigue como lo dejó el agente: sin `x.txt`.
    expect(git("status", "--porcelain")).toBe(" D x.txt");
  });

  test("se rechazan si un mensaje no es Conventional Commits o lo firma una IA; un fixup! se lee sin su prefijo", async () => {
    const known = commit("feat: uno", "x.txt", "1\n");
    commit("fixup! feat: uno", "x.txt", "1 corregido\n");
    commit("arreglos varios", "y.txt", "2\n");
    commit("feat: tres\n\nCo-Authored-By: Claude <noreply@anthropic.com>", "z.txt", "3\n");

    const result = await prepare(known);

    expect(result).toMatchObject({ outcome: "replan" });
    const failures = result.outcome === "replan" ? result.failures : "";
    expect(failures).toMatch(/"arreglos varios": el mensaje no cumple/);
    expect(failures).toMatch(/"feat: tres": el mensaje firma el commit como hecho por una IA/);
    expect(failures).not.toMatch(/fixup!/);
    expect(head()).toBe(known);
    expect(git("status", "--porcelain").split("\n").sort()).toEqual([" M x.txt", "?? y.txt", "?? z.txt"]);
  });

  test("con el patrón del pack, se acepta un mensaje que lo cumple", async () => {
    const known = commit("feat: uno", "x.txt", "1\n");
    commit("CLA-1 dos", "y.txt", "2\n");

    const result = await preparePush(workspaces, lease, { knownSha: known, base: lease.baseSha, council: false, messagePattern: "^CLA-\\d+ " });

    expect(result).toEqual({ outcome: "ok", head: head(), squashed: false });
  });
});

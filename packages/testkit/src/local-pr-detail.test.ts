import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { createLocalPrDetails, openStore, type Store } from "@clanker/core";
import { afterEach, beforeEach, expect, test } from "vitest";
import { tempGitRepo, type TempGitRepo } from "./git";

// `prs.localDetail` sobre un repo git real: un PR local con dos commits propios que cuelga de un padre publicado
// (`origin/cla-1`).

let store: Store;
let repo: TempGitRepo;

beforeEach(() => {
  store = openStore({ path: ":memory:" });
  repo = tempGitRepo({
    remote: true,
    commits: [{ message: "chore: base", files: { "a.txt": "a1\na2\n" } }],
    branches: { "cla-1": [{ message: "feat: padre", files: { "a.txt": "a1\npadre\n" } }] },
  });
  repo.git("checkout", "--quiet", "-b", "cla-2", "origin/cla-1");
  for (const [message, file, content] of [
    ["feat(b): agregar b\n\nPorque hace falta.", "b.txt", "b1\nb2\n"],
    ["test(b): cubrir b", "b.test.txt", "ok\n"],
  ] as const) {
    writeFileSync(join(repo.dir, file), content);
    repo.git("add", "--all");
    repo.git("commit", "--quiet", "-m", message);
  }
  repo.git("checkout", "--quiet", "main");
});

afterEach(() => {
  repo.cleanup();
  store.close();
});

const details = () =>
  createLocalPrDetails({
    store,
    repoConfig: () => ({ path: repo.dir, defaultBranch: "main", remote: { url: "", repo: "octocat/secret", account: "octocat" } }) as never,
  });

function insert(state: "local" | "open") {
  store.db.$client
    .prepare(
      "INSERT INTO pull_requests (id, repo_id, number, node_id, head_ref, base_ref, head_sha, state, is_draft, owned, title, body) VALUES ('pr_b', 'repo_r1', ?, ?, 'cla-2', 'cla-1', 'x', ?, 1, 1, '[CLA-2] Agregar b', ?)",
    )
    .run(state === "local" ? null : 7, state === "local" ? null : "PR_n", state, "## Qué cambia\n\n- Agrega b");
}

test("trae la descripción guardada, los commits sobre la base y el diff contra ella", async () => {
  insert("local");

  const detail = await details().get("pr_b");

  expect(detail).toMatchObject({ id: "pr_b", repo: "octocat/secret", branch: "cla-2", base: "cla-1", title: "[CLA-2] Agregar b", body: "## Qué cambia\n\n- Agrega b", truncated: false });
  expect(detail.head).toBe(repo.git("rev-parse", "cla-2"));
  expect(detail.commits.map((c) => [c.subject, c.body, c.author])).toEqual([
    ["feat(b): agregar b", "Porque hace falta.", "Clanker Test"],
    ["test(b): cubrir b", "", "Clanker Test"],
  ]);
  expect(detail.files).toEqual([
    { path: "b.test.txt", additions: 1, deletions: 0 },
    { path: "b.txt", additions: 2, deletions: 0 },
  ]);
  expect(detail.patch).toContain("diff --git a/b.txt b/b.txt");
  expect(detail.patch).toContain("+b2");
  // El cambio del padre no es de este PR.
  expect(detail.patch).not.toContain("padre");
});

test("un PR que no existe o que ya está en GitHub se rechaza diciendo por qué", async () => {
  await expect(details().get("pr_nada")).rejects.toThrow("No existe el PR pr_nada");
  insert("open");
  await expect(details().get("pr_b")).rejects.toThrow("ya no es un PR local");
});

test("el diff de un commit trae solo lo que cambió ese commit, y uno que no es del PR se rechaza", async () => {
  insert("local");
  const [first, second] = (await details().get("pr_b")).commits;

  const diff = await details().commit("pr_b", second!.sha.slice(0, 9));

  expect(diff.sha).toBe(second!.sha);
  expect(diff.files).toEqual([{ path: "b.test.txt", additions: 1, deletions: 0 }]);
  expect(diff.patch).not.toContain("b.txt b/b.txt");
  expect((await details().commit("pr_b", first!.sha)).files.map((f) => f.path)).toEqual(["b.txt"]);
  await expect(details().commit("pr_b", repo.git("rev-parse", "main"))).rejects.toThrow("no es de cla-2");
});

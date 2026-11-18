import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import { copyGitTemplate, tempGitRepo, type TempGitRepo } from "./git";

const repos: TempGitRepo[] = [];
afterEach(() => {
  for (const repo of repos.splice(0)) repo.cleanup();
});

function repo(opts?: Parameters<typeof tempGitRepo>[0]): TempGitRepo {
  const created = tempGitRepo(opts);
  repos.push(created);
  return created;
}

test("crea los commits en main con sus archivos", () => {
  const r = repo({
    commits: [
      { message: "feat: a", files: { "a.txt": "a" } },
      { message: "feat: b", files: { "src/b.txt": "b" } },
    ],
  });

  expect(r.git("log", "--format=%s")).toBe("feat: b\nfeat: a");
  expect(r.git("branch", "--show-current")).toBe("main");
  expect(readFileSync(join(r.dir, "src/b.txt"), "utf8")).toBe("b");
  expect(r.remoteDir).toBeUndefined();
});

test("sin opciones deja un commit inicial", () => {
  expect(repo().git("rev-list", "--count", "HEAD")).toBe("1");
});

test("las ramas salen del último commit de main y no lo mueven", () => {
  const r = repo({
    commits: [{ message: "feat: base", files: { "base.txt": "x" } }],
    branches: { "feature/x": [{ message: "feat: x", files: { "x.txt": "x" } }] },
  });

  expect(r.git("rev-list", "--count", "main..feature/x")).toBe("1");
  expect(r.git("rev-list", "--count", "feature/x..main")).toBe("0");
  expect(r.git("branch", "--show-current")).toBe("main");
  expect(existsSync(join(r.dir, "x.txt"))).toBe(false);
});

test("con remote, origin es un bare local con main y las ramas ya publicadas", () => {
  const r = repo({ branches: { "feature/x": [{ message: "feat: x" }] }, remote: true });

  expect(r.git("-C", r.remoteDir!, "rev-parse", "--is-bare-repository")).toBe("true");
  expect(r.git("ls-remote", "--heads", "origin").split("\n")).toHaveLength(2);
  expect(r.git("rev-parse", "origin/feature/x")).toBe(r.git("rev-parse", "feature/x"));
});

test("el remoto permite push y fetch locales entre dos clones", () => {
  const r = repo({ remote: true });
  const other = repo();
  other.git("remote", "add", "origin", r.remoteDir!);
  other.git("fetch", "origin");
  other.git("checkout", "-B", "main", "origin/main");

  r.git("commit", "--allow-empty", "--message", "feat: nuevo");
  r.git("push", "origin", "main");
  other.git("fetch", "origin");

  expect(other.git("log", "--format=%s", "origin/main", "-1")).toBe("feat: nuevo");
  expect(other.git("rev-parse", "origin/main")).toBe(r.git("rev-parse", "HEAD"));
});

test("git falla con un mensaje que dice qué comando y dónde", () => {
  const r = repo();
  expect(() => r.git("checkout", "no-existe")).toThrow(/git checkout no-existe falló en .*work/);
});

test("cleanup borra el repo y su remoto", () => {
  const r = tempGitRepo({ remote: true });
  r.cleanup();
  expect(existsSync(r.dir)).toBe(false);
  expect(existsSync(r.remoteDir!)).toBe(false);
});

test("cada copia puede hacer push sin cambiar el remoto de la plantilla ni el de otra copia", () => {
  const template = repo({ remote: true });
  const first = copyGitTemplate(template);
  repos.push(first);
  const second = copyGitTemplate(template);
  repos.push(second);
  const initial = template.git("rev-parse", "HEAD");
  first.git("commit", "--allow-empty", "-m", "solo en la primera copia");
  first.git("push");
  for (const pristine of [template, second]) {
    expect(pristine.git("--git-dir", pristine.remoteDir!, "rev-parse", "main")).toBe(initial);
  }
  expect(first.git("--git-dir", first.remoteDir!, "rev-parse", "main")).toBe(first.git("rev-parse", "HEAD"));
});

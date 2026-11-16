import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { RunId } from "@clanker/api";
import {
  commitsApplyAction,
  createArtifacts,
  createBriefs,
  createDefs,
  createRecipes,
  createSlots,
  createWorkspaces,
  newId,
  openStore,
  PermanentActionError,
  type ActionCtx,
  type Briefs,
  type Store,
  type WorkspaceLease,
  type Workspaces,
} from "@clanker/core";
import { afterEach, describe, expect, test, vi } from "vitest";
import { tempGitRepo, type TempGitRepo } from "./git";

// Se prueba aquí y no en el core: necesita repos git reales (tempGitRepo).

const runId = newId("run");
const stepId = newId("stp");

const lines = (n: number) => Array.from({ length: n }, (_, i) => `linea ${i + 1}`).join("\n") + "\n";

let dataDir: string;
let store: Store;
let repo: TempGitRepo;
let workspaces: Workspaces;
let briefs: Briefs;
let lease: WorkspaceLease;
let base: string;
let apply: ReturnType<typeof commitsApplyAction>;

/** Un repo con `files` en su commit base (la receta, si la hay, en `.clanker/recipe.json`) y un worktree tomado. */
async function setup(files: Record<string, string> = {}, recipe?: unknown) {
  dataDir = mkdtempSync(join(tmpdir(), "clanker-commits-"));
  store = openStore({ path: ":memory:" });
  repo = tempGitRepo({
    commits: [
      {
        message: "base",
        files: {
          "a.txt": lines(30),
          "b.txt": "b\n",
          ...files,
          ...(recipe ? { ".clanker/recipe.json": JSON.stringify(recipe) } : {}),
        },
      },
    ],
  });
  workspaces = createWorkspaces({
    store,
    dataDir,
    repoConfig: () => ({ path: repo.dir, defaultBranch: "main" }),
    identityOf: async () => ({ name: "Ana Pérez", email: "ana@example.com" }),
  });
  const artifacts = createArtifacts({ store, dir: join(dataDir, "artifacts") });
  briefs = createBriefs({ workspaces, artifacts });
  const recipes = createRecipes({ store, defs: createDefs(store), workspaces, artifacts, slots: createSlots({ store }) });
  apply = commitsApplyAction({ workspaces, recipes });
  lease = await workspaces.acquire({ repo: "repo_r1", branch: "cla-43", base: "main", runId });
  base = lease.baseSha;
}

afterEach(() => {
  vi.unstubAllEnvs();
  workspaces.release(lease);
  repo.cleanup();
  store.close();
  rmSync(dataDir, { recursive: true, force: true });
});

function write(path: string, content: string | Buffer) {
  const full = join(lease.path, path);
  mkdirSync(dirname(full), { recursive: true });
  writeFileSync(full, content);
}

const git = (...args: string[]) => repo.git("-C", lease.path, ...args);

function ctx(): ActionCtx {
  return { runId, stepId, key: `${runId}:commits:1`, signal: new AbortController().signal, once: (_stage, fn) => fn() };
}

/** Los hunks que el committer ve en `hunks.json`: `h1`... con su archivo. */
async function hunkIds(): Promise<Record<string, string>> {
  await briefs.prepare({
    lease,
    run: { id: runId, subject: { type: "issue", id: "CLA-43" }, round: 1, attempt: 1 },
    mode: "plan",
  });
  const hunks = JSON.parse(readFileSync(join(lease.path, ".clanker-run", "hunks.json"), "utf8")) as {
    id: string;
    path: string;
    header: string;
  }[];
  return Object.fromEntries(hunks.map((h) => [`${h.path} ${h.header}`, h.id]));
}

type PlanCommit = { message: string; hunks: string[]; tests?: string[] };

function run(commits: PlanCommit[], extra: { messagePattern?: string } = {}) {
  const { workspaceId, path, branch, baseSha, fencingToken } = lease;
  return apply.run(
    {
      ws: { workspaceId, path, branch, baseSha, fencingToken },
      plan: { commits: commits.map((c) => ({ tests: [], ...c })) },
      ...extra,
    },
    ctx(),
  );
}

const subjects = () => git("log", "--format=%s", `${base}..HEAD`).split("\n").filter(Boolean).reverse();
const verifyWorktrees = () => git("worktree", "list").split("\n").filter((l) => l.includes("clanker-verify"));

/** Un cambio en dos archivos, con dos hunks lejanos en `a.txt`. */
function changeThreeThings() {
  write("a.txt", lines(30).replace("linea 2\n", "linea 2 editada\n").replace("linea 28\n", "linea 28 editada\n"));
  write("c.txt", "nuevo\n");
}

describe("args", () => {
  const ws = { workspaceId: "w", path: "/w", branch: "b", baseSha: "abc", fencingToken: 1 };

  test("acepta el reporte del committer tal cual, con lo que la acción no usa", async () => {
    await setup();
    const report = {
      commits: [{ message: "feat: x", hunks: ["h1"], tests: ["a_spec.rb"], whyAtomic: "es una sola razón" }],
      pr: { title: "feat: x", body: "Qué cambia" },
      notes: ["para quien dirige"],
    };

    expect(apply.args.parse({ ws, plan: report }).plan.commits).toEqual([{ message: "feat: x", hunks: ["h1"], tests: ["a_spec.rb"] }]);
  });

  test("rechaza un plan sin tests por commit y un messagePattern que no es regex", async () => {
    await setup();
    expect(apply.args.safeParse({ ws, plan: { commits: [{ message: "feat: x", hunks: ["h1"] }] } }).success).toBe(false);
    expect(apply.args.safeParse({ ws, plan: { commits: [] }, messagePattern: "(" }).success).toBe(false);
  });
});

describe("un plan válido", () => {
  test("en 2 commits deja el mismo árbol, parte un archivo entre commits y no deja el worktree de verify", async () => {
    await setup();
    changeThreeThings();
    const before = git("status", "--porcelain", "--untracked-files=all");
    const ids = await hunkIds();
    const [first, second] = [ids["a.txt @@ -1,5 +1,5 @@"]!, ids["a.txt @@ -25,6 +25,6 @@"]!];

    const result = await run([
      { message: "feat(a): edita la linea 2", hunks: [first] },
      { message: "feat(a): edita la linea 28 y agrega c.txt", hunks: [second, ids["c.txt @@ -0,0 +1 @@"]!] },
    ]);

    expect(result.outcome).toBe("ok");
    expect(subjects()).toEqual(["feat(a): edita la linea 2", "feat(a): edita la linea 28 y agrega c.txt"]);
    // El primer commit trae solo su hunk.
    expect(git("show", "--format=", "--name-only", "HEAD~1")).toBe("a.txt");
    expect(git("show", "HEAD~1:a.txt")).toContain("linea 2 editada");
    expect(git("show", "HEAD~1:a.txt")).not.toContain("linea 28 editada");
    // El árbol de HEAD es el que había, el working tree no cambió y el index quedó limpio.
    expect(result.output).toMatchObject({ tree: git("rev-parse", "HEAD^{tree}") });
    expect(git("status", "--porcelain", "--untracked-files=all")).toBe("");
    expect(git("diff", "HEAD")).toBe("");
    expect(before).toBe(" M a.txt\n?? c.txt");
    expect(git("symbolic-ref", "--short", "HEAD")).toBe("cla-43");
    expect(verifyWorktrees()).toEqual([]);
    expect(git("worktree", "list").split("\n")).toHaveLength(2);
    // Autor y committer son la identidad de Workspaces.
    expect(git("log", "-1", "--format=%an <%ae>")).toBe("Ana Pérez <ana@example.com>");
  });

  test("un archivo binario, uno vacío y un cambio de modo van en commits como cualquier hunk", async () => {
    await setup({ "run.sh": "echo\n" });
    write("img.bin", Buffer.from([0, 1, 2, 255, 0, 7]));
    write("empty.txt", "");
    chmodSync(join(lease.path, "run.sh"), 0o755);
    const ids = await hunkIds();
    expect(Object.keys(ids).sort()).toEqual(["empty.txt (archivo vacío nuevo)", "img.bin (binario)", "run.sh (cambio de modo)"]);

    const result = await run([
      { message: "chore: assets", hunks: [ids["img.bin (binario)"]!, ids["empty.txt (archivo vacío nuevo)"]!] },
      { message: "chore: run.sh ejecutable", hunks: [ids["run.sh (cambio de modo)"]!] },
    ]);

    expect(result.outcome).toBe("ok");
    expect(git("status", "--porcelain", "--untracked-files=all")).toBe("");
    expect(git("ls-tree", "HEAD", "run.sh")).toMatch(/^100755 /);
    expect(subjects()).toHaveLength(2);
  });

  test("el mensaje pierde las líneas que lo firman como hecho por una IA", async () => {
    await setup();
    write("b.txt", "b2\n");
    const [id] = Object.values(await hunkIds());

    const result = await run([
      {
        message: "fix(b): cambia b\n\nPorque sí.\n\nCo-Authored-By: Claude <noreply@anthropic.com>\nClaude-Session: https://claude.ai/code/session_1\n🤖 Generated with Claude Code\nhttps://claude.ai/code/session_2",
        hunks: [id!],
      },
    ]);

    expect(result.outcome).toBe("ok");
    expect(git("log", "-1", "--format=%B")).toBe("fix(b): cambia b\n\nPorque sí.");
  });
});

describe("un plan que no se puede aplicar da replan", () => {
  test("un hunk sin asignar, y nada cambia", async () => {
    await setup();
    changeThreeThings();
    const ids = await hunkIds();
    const before = git("status", "--porcelain", "--untracked-files=all");

    const result = await run([{ message: "feat(a): solo la linea 2", hunks: [ids["a.txt @@ -1,5 +1,5 @@"]!] }]);

    expect(result.outcome).toBe("replan");
    expect(result.output).toEqual({
      failures: expect.stringMatching(/Hunks sin asignar a ningún commit: h2 a\.txt @@ -25,6 \+25,6 @@; h3 c\.txt @@ -0,0 \+1 @@/),
    });
    expect(git("rev-parse", "HEAD")).toBe(base);
    expect(git("status", "--porcelain", "--untracked-files=all")).toBe(before);
    expect(verifyWorktrees()).toEqual([]);
  });

  test("un hunk que no existe, uno repetido, un commit sin hunks y un mensaje fuera de formato", async () => {
    await setup();
    write("b.txt", "b2\n");
    const [id] = Object.values(await hunkIds());

    const result = await run([
      { message: "feat: uno", hunks: [id!, "h99"] },
      { message: "feat: dos", hunks: [id!] },
      { message: "feat: tres", hunks: [] },
      { message: "arreglé cosas", hunks: [] },
    ]);

    expect(result.outcome).toBe("replan");
    const { failures } = result.output as { failures: string };
    expect(failures).toContain('[commit 1 "feat: uno"] usa el hunk h99, que no existe en hunks.json');
    expect(failures).toContain('[commit 2 "feat: dos"] usa el hunk h1, que ya es del commit 1');
    expect(failures).toContain('[commit 3 "feat: tres"] no tiene hunks');
    expect(failures).toMatch(/\[commit 4 "arreglé cosas"\] el mensaje no cumple/);
    expect(git("rev-parse", "HEAD")).toBe(base);
  });

  test("un move partido (borrar en un commit y crear en otro) se rechaza y pide un solo commit", async () => {
    const generator = lines(10);
    await setup({ "old/generator.txt": generator });
    git("rm", "--quiet", "--cached", "old/generator.txt");
    rmSync(join(lease.path, "old", "generator.txt"));
    write("new/generator.txt", generator.replace("linea 3\n", "linea 3 editada\n"));
    const ids = await hunkIds();
    const removed = ids["old/generator.txt @@ -1,10 +0,0 @@"]!;
    const created = ids["new/generator.txt @@ -0,0 +1,10 @@"]!;

    const result = await run([
      { message: "feat: crea el generador nuevo", hunks: [created] },
      { message: "refactor: borra el generador viejo", hunks: [removed] },
    ]);

    expect(result.outcome).toBe("replan");
    expect((result.output as { failures: string }).failures).toContain(
      "El move de old/generator.txt a new/generator.txt va en un solo commit",
    );
    expect(git("rev-parse", "HEAD")).toBe(base);
  });

  test("un move entero en un commit pasa", async () => {
    const generator = lines(10);
    await setup({ "old/generator.txt": generator });
    git("rm", "--quiet", "--cached", "old/generator.txt");
    rmSync(join(lease.path, "old", "generator.txt"));
    write("new/generator.txt", generator);
    write("c.txt", "otra cosa\n");
    const ids = await hunkIds();

    const result = await run([
      {
        message: "refactor: mueve el generador",
        hunks: [ids["old/generator.txt @@ -1,10 +0,0 @@"]!, ids["new/generator.txt @@ -0,0 +1,10 @@"]!],
      },
      { message: "feat: c", hunks: [ids["c.txt @@ -0,0 +1 @@"]!] },
    ]);

    expect(result.outcome).toBe("ok");
    expect(git("diff", "--name-status", "-M", `${base}~0`, "HEAD~1")).toContain("R100");
  });

  test("un pack puede pedir otro formato de mensaje", async () => {
    await setup();
    write("b.txt", "b2\n");
    const [id] = Object.values(await hunkIds());

    expect((await run([{ message: "feat: uno", hunks: [id!] }], { messagePattern: "^\\[CLA-\\d+\\] " })).outcome).toBe("replan");
    expect((await run([{ message: "[CLA-43] uno", hunks: [id!] }], { messagePattern: "^\\[CLA-\\d+\\] " })).outcome).toBe("ok");
  });

  test("hunks que ya no se aplican sobre los commits anteriores dicen cuál commit y por qué", async () => {
    await setup();
    write("a.txt", lines(30).replace("linea 2\n", "dos\n"));
    write("b.txt", "b2\n");
    const ids = await hunkIds();
    // El hook del primer commit reescribe b.txt: el hunk del segundo ya no tiene su contexto.
    const hook = join(repo.dir, ".git", "hooks", "pre-commit");
    mkdirSync(dirname(hook), { recursive: true });
    writeFileSync(hook, "#!/bin/sh\necho otro > b.txt\ngit add b.txt\n");
    chmodSync(hook, 0o755);

    const result = await run([
      { message: "feat: a", hunks: [ids["a.txt @@ -1,5 +1,5 @@"]!] },
      { message: "feat: b", hunks: [ids["b.txt @@ -1 +1 @@"]!] },
    ]);

    expect(result.outcome).toBe("replan");
    expect(result.output).toEqual({
      failures: expect.stringMatching(/^\[commit 2 "feat: b"\] sus hunks no se aplican sobre los commits anteriores\n.*b\.txt/),
    });
    expect(git("rev-parse", "HEAD")).toBe(base);
  });

  test("con una base distinta de la de HEAD lanza: hunks.json es el diff contra la base", async () => {
    await setup();
    write("b.txt", "b2\n");
    const [id] = Object.values(await hunkIds());
    git("add", "b.txt");
    git("commit", "-m", "feat: ya commiteado");

    await expect(run([{ message: "feat: uno", hunks: [id!] }])).rejects.toThrow(PermanentActionError);
    await expect(run([{ message: "feat: uno", hunks: [id!] }])).rejects.toThrow(/ya está en/);
  });

  test("un reintento con los commits del plan ya hechos (el corte llegó antes de guardar la etapa) devuelve esos commits", async () => {
    await setup();
    write("b.txt", "b2\n");
    const [id] = Object.values(await hunkIds());
    const first = await run([{ message: "feat: uno", hunks: [id!] }]);

    const retry = await run([{ message: "feat: uno", hunks: [id!] }]);

    expect(first.outcome).toBe("ok");
    expect(retry).toEqual(first);
    expect(subjects()).toEqual(["feat: uno"]);
  });

  test("con una receta inválida lanza sin reintentos y no toca nada", async () => {
    await setup({}, { version: 1, commands: { test: "sh {{nope}}" }, checks: [] });
    write("b.txt", "b2\n");
    const [id] = Object.values(await hunkIds());

    await expect(run([{ message: "feat: b", hunks: [id!] }])).rejects.toThrow(PermanentActionError);
    expect(git("rev-parse", "HEAD")).toBe(base);
    expect(verifyWorktrees()).toEqual([]);
  });
});

describe("tests por commit", () => {
  const recipe = { version: 1, commands: { test: "sh check.sh {{files}}" }, checks: [] };
  const check = 'for f in "$@"; do grep -q ok "$f" || { echo "falló $f"; exit 1; }; done\n';

  test("un test rojo resetea al estado anterior y trae el extracto", async () => {
    await setup({ "check.sh": check, "ok1.txt": "ok\n", "ok2.txt": "ok\n" }, recipe);
    write("ok1.txt", "ok uno\n");
    write("ok2.txt", "roto\n");
    write("c.txt", "nuevo\n");
    const before = git("status", "--porcelain", "--untracked-files=all");
    const ids = await hunkIds();

    const result = await run([
      { message: "feat: uno", hunks: [ids["ok1.txt @@ -1 +1 @@"]!], tests: ["ok1.txt"] },
      { message: "feat: dos", hunks: [ids["ok2.txt @@ -1 +1 @@"]!, ids["c.txt @@ -0,0 +1 @@"]!], tests: ["ok2.txt"] },
    ]);

    expect(result.outcome).toBe("replan");
    expect(result.output).toEqual({ failures: '[commit 2 "feat: dos"] test exit 1\nfalló ok2.txt' });
    expect(git("rev-parse", "HEAD")).toBe(base);
    expect(git("symbolic-ref", "--short", "HEAD")).toBe("cla-43");
    expect(git("status", "--porcelain", "--untracked-files=all")).toBe(before);
    expect(readFileSync(join(lease.path, "ok2.txt"), "utf8")).toBe("roto\n");
    expect(verifyWorktrees()).toEqual([]);
  });

  test("los tests de un commit corren sin lo que no es suyo", async () => {
    await setup({ "later.sh": "", "check.sh": check }, { ...recipe, commands: { test: "sh -c 'test ! -e later.txt' x {{files}}" } });
    write("b.txt", "b2\n");
    write("later.txt", "después\n");
    const ids = await hunkIds();

    const result = await run([
      { message: "feat: b", hunks: [ids["b.txt @@ -1 +1 @@"]!], tests: ["b.txt"] },
      { message: "feat: later", hunks: [ids["later.txt @@ -0,0 +1 @@"]!] },
    ]);

    expect(result.outcome).toBe("ok");
    expect(existsSync(join(lease.path, "later.txt"))).toBe(true);
  });

  test("corre setup.worktree en el worktree de verify antes de los tests", async () => {
    await setup(
      { "check.sh": 'test -f installed.flag || { echo "sin instalar"; exit 1; }\n' },
      { ...recipe, setup: { worktree: ["touch installed.flag"] } },
    );
    write("b.txt", "b2\n");
    const [id] = Object.values(await hunkIds());

    const result = await run([{ message: "feat: b", hunks: [id!], tests: ["x"] }]);

    expect(result.outcome).toBe("ok");
    expect(existsSync(join(lease.path, "installed.flag"))).toBe(false);
  });
});

describe("hooks del repo", () => {
  test("un hook que falla devuelve el commit al dev con su extracto, y nada cambia", async () => {
    await setup();
    write("b.txt", "b2\n");
    const [id] = Object.values(await hunkIds());
    const hook = join(repo.dir, ".git", "hooks", "pre-commit");
    mkdirSync(dirname(hook), { recursive: true });
    writeFileSync(hook, "#!/bin/sh\necho 'lint: b.txt sin newline al final' >&2\nexit 1\n");
    chmodSync(hook, 0o755);
    const before = git("status", "--porcelain", "--untracked-files=all");

    const result = await run([{ message: "feat: b", hunks: [id!] }]);

    expect(result.outcome).toBe("hook-failed");
    expect(result.output).toEqual({
      failures: expect.stringMatching(/^\[commit 1 "feat: b"\] git commit falló \(hooks del repo\)\nlint: b\.txt sin newline al final/),
    });
    expect(git("rev-parse", "HEAD")).toBe(base);
    expect(git("status", "--porcelain", "--untracked-files=all")).toBe(before);
    expect(verifyWorktrees()).toEqual([]);
  });

  test("un hook no ve los secretos del entorno del core", async () => {
    await setup();
    write("b.txt", "b2\n");
    const [id] = Object.values(await hunkIds());
    vi.stubEnv("GH_TOKEN", "secreto");
    vi.stubEnv("ANTHROPIC_API_KEY", "secreto");
    const seen = join(dataDir, "hook-env");
    const hook = join(repo.dir, ".git", "hooks", "pre-commit");
    mkdirSync(dirname(hook), { recursive: true });
    writeFileSync(hook, `#!/bin/sh\necho "gh=$GH_TOKEN anthropic=$ANTHROPIC_API_KEY" > ${seen}\n`);
    chmodSync(hook, 0o755);

    const result = await run([{ message: "feat: b", hunks: [id!] }]);

    expect(result.outcome).toBe("ok");
    expect(readFileSync(seen, "utf8")).toBe("gh= anthropic=\n");
  });

  test("un hook que cambia archivos al commitear da árbol distinto y replan", async () => {
    await setup();
    write("b.txt", "b2\n");
    const [id] = Object.values(await hunkIds());
    const hook = join(repo.dir, ".git", "hooks", "pre-commit");
    mkdirSync(dirname(hook), { recursive: true });
    writeFileSync(hook, "#!/bin/sh\necho formateado > fmt.txt\ngit add fmt.txt\n");
    chmodSync(hook, 0o755);

    const result = await run([{ message: "feat: b", hunks: [id!] }]);

    expect(result.outcome).toBe("replan");
    expect(result.output).toEqual({ failures: expect.stringMatching(/^El árbol de los commits no es el del worktree.*\n.*fmt\.txt/) });
    expect(git("rev-parse", "HEAD")).toBe(base);
  });
});

test("el lease vence antes de aplicar: no se hace nada", async () => {
  await setup();
  write("b.txt", "b2\n");
  const [id] = Object.values(await hunkIds());
  workspaces.release(lease);
  const other = await workspaces.acquire({ repo: "repo_r1", branch: "cla-43", base: "main", runId: newId("run") as RunId });
  try {
    await expect(run([{ message: "feat: b", hunks: [id!] }])).rejects.toThrow(/ya no es el vigente/);
    expect(git("rev-parse", "HEAD")).toBe(base);
  } finally {
    workspaces.release(other);
  }
});

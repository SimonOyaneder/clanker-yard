import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { Brief, type IssueDetail } from "@clanker/api";
import {
  acceptanceCriteria,
  createArtifacts,
  createBriefs,
  createWorkspaces,
  listHunks,
  newId,
  openStore,
  type Artifacts,
  type Briefs,
  type Store,
  type WorkspaceLease,
  type Workspaces,
} from "@clanker/core";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { tempGitRepo, type TempGitRepo } from "./git";

// Se prueba aquí y no en el core por lo mismo que Workspaces: necesita repos git reales (tempGitRepo).

const runId = newId("run");

let dataDir: string;
let store: Store;
let repo: TempGitRepo;
let workspaces: Workspaces;
let artifacts: Artifacts;
let briefs: Briefs;
let lease: WorkspaceLease;

beforeEach(async () => {
  dataDir = mkdtempSync(join(tmpdir(), "clanker-briefs-"));
  store = openStore({ path: ":memory:" });
  repo = tempGitRepo({
    remote: true,
    commits: [
      {
        message: "base",
        files: {
          "app/models/transfer.rb": "class Transfer\n  def amount\n    1\n  end\nend\n",
          "README.md": "# demo\n",
        },
      },
    ],
  });
  workspaces = createWorkspaces({
    store,
    dataDir,
    repos: () => ({ path: repo.dir, defaultBranch: "main" }),
    identityOf: async () => ({ name: "Ana Pérez", email: "ana@example.com" }),
  });
  artifacts = createArtifacts({ store, dir: join(dataDir, "artifacts") });
  briefs = createBriefs({ workspaces, artifacts });
  lease = await workspaces.acquire({ repo: "r1", branch: "cla-1", base: "main", runId });
});

afterEach(() => {
  workspaces.release(lease);
  repo.cleanup();
  store.close();
  rmSync(dataDir, { recursive: true, force: true });
});

function write(path: string, content: string) {
  const full = join(lease.path, path);
  mkdirSync(dirname(full), { recursive: true });
  writeFileSync(full, content);
}

const git = (...args: string[]) => repo.git("-C", lease.path, ...args);

const issue: IssueDetail = {
  ref: { tracker: "linear", id: "i1", key: "CLA-39", url: "https://linear.app/clanker-yard/issue/CLA-39" },
  project: "p1",
  title: "Preparar el brief y los artefactos del worktree",
  body: [
    "**Contexto**",
    "Cada agente recibe un brief chico.",
    "",
    "**Qué hacer**",
    "",
    "* Carpeta `.clanker-run/` agregada a `.git/info/exclude`.",
    "* Artefactos `issue.md`, `diff.patch` y `hunks.json`.",
    "",
    "**Criterios de aceptación**",
    "",
    "* Test: `.clanker-run` nunca aparece en `git status`.",
    "* Test: `hunks.json` es estable para el mismo diff.",
    "* Test: el brief de un caso típico queda bajo 1k tokens.",
    "",
    "**Notas**",
    "* esto ya no es un criterio",
  ].join("\n"),
  status: "in_progress",
  rawStatus: "In Progress",
  priority: 1,
  labels: ["workspaces", "agents"],
  relations: {
    blocks: [],
    blockedBy: [{ tracker: "linear", id: "i2", key: "CLA-22", url: "https://linear.app/clanker-yard/issue/CLA-22" }],
    related: [],
  },
  updatedAt: 1_000,
  comments: [{ id: "c1", author: { id: "u1", name: "Simón" }, text: "Ojo con los worktrees.", createdAt: 2_000 }],
};

function request(round: number, since?: string, extra: Partial<Parameters<Briefs["prepare"]>[0]> = {}) {
  return {
    lease,
    run: { id: runId, subject: { type: "issue" as const, id: "CLA-39" }, round, attempt: 1 },
    mode: "implement",
    issue,
    since,
    ...extra,
  };
}

describe(".clanker-run", () => {
  test("nunca aparece en git status, ni con archivos nuevos ni al preparar otra ronda", async () => {
    write("app/models/payout.rb", "class Payout\nend\n");

    const first = await briefs.prepare(request(1));
    await briefs.prepare(request(2, first.snapshot));

    expect(existsSync(join(lease.path, ".clanker-run", "diff.patch"))).toBe(true);
    expect(git("status", "--porcelain", "--untracked-files=all")).toBe("?? app/models/payout.rb");
    const exclude = readFileSync(join(repo.dir, ".git", "info", "exclude"), "utf8");
    expect(exclude.split("\n").filter((l) => l === "/.clanker-run/")).toHaveLength(1);
  });

  test("no toca el index real: lo que no está en stage sigue sin estarlo", async () => {
    write("README.md", "# demo\n\nmás\n");
    write("nuevo.txt", "hola\n");

    await briefs.prepare(request(1));

    expect(git("diff", "--cached", "--name-only")).toBe("");
    expect(git("status", "--porcelain")).toBe(" M README.md\n?? nuevo.txt");
  });
});

describe("diff.patch y diff-round.patch", () => {
  test("diff.patch es contra la base e incluye cambios sin commit y archivos nuevos", async () => {
    write("app/models/transfer.rb", "class Transfer\n  def amount\n    2\n  end\nend\n");
    write("app/models/payout.rb", "class Payout\nend\n");

    await briefs.prepare(request(1));

    const diff = readFileSync(join(lease.path, ".clanker-run", "diff.patch"), "utf8");
    expect(diff).toContain("diff --git a/app/models/transfer.rb b/app/models/transfer.rb");
    expect(diff).toContain("+    2");
    expect(diff).toContain("diff --git a/app/models/payout.rb b/app/models/payout.rb");
    expect(diff.endsWith("\n")).toBe(true);
    // Es un patch aplicable sobre la base.
    expect(git("apply", "--check", "--reverse", ".clanker-run/diff.patch")).toBe("");
  });

  test("diff-round.patch trae solo lo de la ronda, aunque se commitee entremedio", async () => {
    write("a.txt", "ronda uno\n");
    const first = await briefs.prepare(request(1));
    expect(existsSync(join(lease.path, ".clanker-run", "diff-round.patch"))).toBe(false);
    expect(first.brief.artifacts.diffRound).toBeUndefined();

    git("add", "a.txt");
    git("commit", "-m", "uno");
    write("b.txt", "ronda dos\n");
    const second = await briefs.prepare(request(2, first.snapshot));

    const round = readFileSync(join(lease.path, ".clanker-run", "diff-round.patch"), "utf8");
    expect(round).toContain("b/b.txt");
    expect(round).not.toContain("a.txt");
    expect(readFileSync(join(lease.path, ".clanker-run", "diff.patch"), "utf8")).toContain("a.txt");
    expect(second.brief.artifacts.diffRound).toBe(".clanker-run/diff-round.patch");
  });
});

describe("hunks.json", () => {
  function changeTwoFiles() {
    write("app/models/transfer.rb", "class Transfer\n  def amount\n    2\n  end\n  def x\n  end\nend\n");
    write("app/models/payout.rb", "class Payout\nend\n");
  }
  const hunksFile = () => readFileSync(join(lease.path, ".clanker-run", "hunks.json"), "utf8");

  test("es estable para el mismo diff, también entre rondas", async () => {
    changeTwoFiles();

    const first = await briefs.prepare(request(1));
    const before = hunksFile();
    await briefs.prepare(request(2, first.snapshot));

    expect(hunksFile()).toBe(before);
    expect(JSON.parse(before)).toEqual([
      { id: "h1", path: "app/models/payout.rb", header: "@@ -0,0 +1,2 @@" },
      { id: "h2", path: "app/models/transfer.rb", header: "@@ -1,5 +1,7 @@" },
    ]);
  });

  test("un id por hunk, con su archivo y su cabecera", () => {
    const diff = [
      "diff --git a/x.rb b/x.rb",
      "index 1..2 100644",
      "--- a/x.rb",
      "+++ b/x.rb",
      "@@ -10,6 +10,9 @@ class X",
      " a",
      "--- una línea borrada que empieza con guiones",
      "@@ -40,2 +43,2 @@",
      "-b",
      "+c",
      "diff --git a/gone.rb b/gone.rb",
      "deleted file mode 100644",
      "--- a/gone.rb",
      "+++ /dev/null",
      "@@ -1 +0,0 @@",
      "-z",
      "diff --git a/img.png b/img.png",
      "GIT binary patch",
      "literal 3",
      "",
    ].join("\n");

    expect(listHunks(diff).map(({ id, path, header }) => ({ id, path, header }))).toEqual([
      { id: "h1", path: "x.rb", header: "@@ -10,6 +10,9 @@" },
      { id: "h2", path: "x.rb", header: "@@ -40,2 +43,2 @@" },
      { id: "h3", path: "gone.rb", header: "@@ -1 +0,0 @@" },
      { id: "h4", path: "img.png", header: "(binario)" },
    ]);
  });

  test("un cambio que git no parte en hunks es un hunk entero: vacío nuevo, borrado vacío, modo y binario", () => {
    const diff = [
      "diff --git a/empty.txt b/empty.txt",
      "new file mode 100644",
      "index 0000000..e69de29",
      "diff --git a/old.txt b/old.txt",
      "deleted file mode 100644",
      "index e69de29..0000000",
      "diff --git a/run.sh b/run.sh",
      "old mode 100644",
      "new mode 100755",
      "",
    ].join("\n");

    expect(listHunks(diff).map(({ id, path, header }) => `${id} ${path} ${header}`)).toEqual([
      "h1 empty.txt (archivo vacío nuevo)",
      "h2 old.txt (archivo vacío borrado)",
      "h3 run.sh (cambio de modo)",
    ]);
  });

  test("el encabezado del archivo y el cuerpo de cada hunk dan el patch de cualquier subconjunto", () => {
    const diff = ["diff --git a/x.rb b/x.rb", "index 1..2 100644", "--- a/x.rb", "+++ b/x.rb", "@@ -1 +1 @@", "-a", "+b", "@@ -9 +9 @@", "-c", "+d", ""].join("\n");

    const [first, second] = listHunks(diff);

    expect(first!.fileHeader).toBe("diff --git a/x.rb b/x.rb\nindex 1..2 100644\n--- a/x.rb\n+++ b/x.rb\n");
    expect(first!.body).toBe("@@ -1 +1 @@\n-a\n+b\n");
    expect(second!.body).toBe("@@ -9 +9 @@\n-c\n+d\n");
    expect(first!.fileHeader + first!.body + second!.body).toBe(diff);
  });
});

describe("Brief", () => {
  test("un caso típico queda bajo 1k tokens (4 caracteres por token) y cumple el esquema", async () => {
    write("a.txt", "x\n");
    const { brief } = await briefs.prepare(
      request(2, undefined, {
        learnings: Array.from({ length: 12 }, (_, i) => `Aprendizaje ${i + 1}: usa el helper existente antes de escribir uno nuevo.`),
        payload: { instructions: [{ id: "f1", path: "app/models/transfer.rb", line: 42, change: "memoiza el client" }] },
        reports: [
          { round: 1, role: "review-bugs", report: { outcome: "changes", summary: "1 hallazgo", payload: {} } },
        ],
      }),
    );

    expect(JSON.stringify(brief, null, 2).length / 4).toBeLessThan(1000);
    expect(Brief.parse(brief)).toEqual(brief);
    expect(brief.learnings).toHaveLength(10);
    expect(brief.base).toBe("origin/main");
    expect(brief.worktree).toBe(lease.path);
    expect(brief.artifacts).toEqual({
      issue: ".clanker-run/issue.md",
      diff: ".clanker-run/diff.patch",
      hunks: ".clanker-run/hunks.json",
      "report-r1-review-bugs": ".clanker-run/reports/r1-review-bugs.json",
    });
  });

  test("la issue lleva la key, el título y a lo más 5 criterios; el resto queda en issue.md", async () => {
    const many = { ...issue, body: `**Criterios de aceptación**\n${Array.from({ length: 8 }, (_, i) => `- c${i + 1}`).join("\n")}` };

    const { brief } = await briefs.prepare(request(1, undefined, { issue: many }));

    expect(brief.issue?.criteria).toEqual(["c1", "c2", "c3", "c4", "c5"]);
    const md = readFileSync(join(lease.path, ".clanker-run", "issue.md"), "utf8");
    expect(md).toContain("- c8");
  });

  test("issue.md trae cuerpo, relaciones y comentarios", async () => {
    await briefs.prepare(request(1));

    const md = readFileSync(join(lease.path, ".clanker-run", "issue.md"), "utf8");
    expect(md).toContain("# CLA-39 Preparar el brief y los artefactos del worktree");
    expect(md).toContain("**Criterios de aceptación**");
    expect(md).toContain("- Bloqueada por: CLA-22");
    expect(md).toContain("### Simón · 1970-01-01T00:00:02.000Z\n\nOjo con los worktrees.");
  });

  test("sin issue no hay issue.md ni campo issue", async () => {
    const { brief } = await briefs.prepare(request(1, undefined, { issue: undefined }));

    expect(brief.issue).toBeUndefined();
    expect(brief.artifacts.issue).toBeUndefined();
    expect(existsSync(join(lease.path, ".clanker-run", "issue.md"))).toBe(false);
  });

  test("cada archivo y el brief quedan en artifacts con una ref a la corrida", async () => {
    write("a.txt", "x\n");
    const { brief } = await briefs.prepare(request(1));

    const diff = readFileSync(join(lease.path, ".clanker-run", "diff.patch"));
    const hash = createHash("sha256").update(diff).digest("hex");
    expect(artifacts.get(hash as never)?.content.toString()).toBe(diff.toString());
    const briefHash = createHash("sha256").update(JSON.stringify(brief)).digest("hex");
    expect(artifacts.get(briefHash as never)?.kind).toBe("brief");
  });

  test("un lease que ya no es el vigente no deja nada escrito", async () => {
    workspaces.release(lease);
    const other = await workspaces.acquire({ repo: "r1", branch: "cla-1", base: "main", runId: newId("run") });
    try {
      await expect(briefs.prepare(request(1))).rejects.toThrow(/ya no es el vigente/);
    } finally {
      workspaces.release(other);
    }
  });
});

describe("acceptanceCriteria", () => {
  test("lee listas con viñetas, números y checkboxes bajo el rótulo, en cualquier formato", () => {
    expect(acceptanceCriteria("## Criterios de aceptación\n\n- [ ] uno\n- [x] dos\n3. tres\n\n## Otro\n- no")).toEqual([
      "uno",
      "dos",
      "tres",
    ]);
    expect(acceptanceCriteria("Acceptance criteria:\n* a")).toEqual(["a"]);
    expect(acceptanceCriteria("**Acceptance criteria**\n* a")).toEqual(["a"]);
  });

  test("sin sección no hay criterios, y uno largo se acorta", () => {
    expect(acceptanceCriteria("Solo texto")).toEqual([]);
    const [long] = acceptanceCriteria(`**Criterios de aceptación**\n- ${"x".repeat(500)}`);
    expect(long).toHaveLength(200);
    expect(long!.endsWith("…")).toBe(true);
  });
});

import type { CachedIssue, ClankerProject, IssueRef, Person, QueueEntry, StackOn, StatusCategory, TrackerCapabilities } from "@clanker/api";
import { describe, expect, test } from "vitest";
import { type QueuePrFact, type QueueRun, tickDev, type TickDevInput } from "./queue";

const PROJECT = "prj_00000000000000000000000001" as const;
const OTHER_PROJECT = "prj_00000000000000000000000002" as const;
const ME: Person = { id: "me", name: "Yo" };
const ALL: TrackerCapabilities = { relations: true, subIssues: true, milestones: true, priorities: true, estimates: true };

const ref = (n: number): IssueRef => ({ tracker: "local", id: String(n), key: `CLA-${n}`, url: `https://example.com/CLA-${n}` });
const issueId = (n: number) => `iss_${String(n).padStart(26, "0")}` as const;

/** Una issue del caché en `todo`, sin dueño; `n` es también su orden de creación. */
function issue(n: number, overrides: Partial<CachedIssue> = {}): CachedIssue {
  return {
    id: issueId(n),
    projectId: PROJECT,
    ref: ref(n),
    project: "p",
    title: `Issue ${n}`,
    body: "",
    status: "todo",
    rawStatus: "Todo",
    priority: 0,
    labels: [],
    relations: { blocks: [], blockedBy: [], related: [] },
    updatedAt: 0,
    ...overrides,
  };
}

const blockedBy = (...blockers: number[]) => ({ relations: { blocks: [], blockedBy: blockers.map(ref), related: [] } });

const REPO = "repo_a";
const project = (overrides: Partial<TickDevInput["project"]> = {}): TickDevInput["project"] => ({
  id: PROJECT,
  queueFilter: {},
  stackOn: "ci_green",
  repos: [{ repoId: REPO as ClankerProject["repos"][number]["repoId"], labels: [] }],
  ...overrides,
});

function queue(issues: CachedIssue[], extra: Partial<TickDevInput> = {}): QueueEntry[] {
  return tickDev({ project: project(), me: ME, capabilities: ALL, issues, runs: [], prs: [], ...extra });
}

const keys = (entries: QueueEntry[]) => entries.map((e) => e.issue.ref.key);
const only = (entries: QueueEntry[]) => {
  expect(entries).toHaveLength(1);
  return entries[0]!;
};

const run = (n: number, status: QueueRun["status"], outcome: string | null = null): QueueRun => ({ issueId: issueId(n), status, outcome });
const pr = (n: number, extra: Partial<QueuePrFact> = {}): QueuePrFact => ({
  issueId: issueId(n),
  repoId: REPO,
  key: `app#${100 + n}`,
  headRef: `cla-${n}`,
  baseRef: "main",
  ci: "green",
  ...extra,
});

describe("elegibles", () => {
  test("por defecto solo entran las issues en todo", () => {
    const issues = [issue(1), ...(["backlog", "in_progress", "in_review", "done", "canceled"] as StatusCategory[]).map((status, i) => issue(i + 2, { status }))];

    expect(keys(queue(issues))).toEqual(["CLA-1"]);
  });

  test("queueFilter.status reemplaza el default", () => {
    const issues = [issue(1), issue(2, { status: "backlog" })];

    const entries = queue(issues, { project: project({ queueFilter: { status: ["backlog"] } }) });

    expect(keys(entries)).toEqual(["CLA-2"]);
  });

  test("queueFilter.labels exige todos los labels", () => {
    const issues = [issue(1, { labels: ["a"] }), issue(2, { labels: ["a", "b"] }), issue(3)];

    expect(keys(queue(issues, { project: project({ queueFilter: { labels: ["a", "b"] } }) }))).toEqual(["CLA-2"]);
  });

  test("no-clanker excluye por defecto y excludeLabels lo reemplaza", () => {
    const issues = [issue(1, { labels: ["no-clanker"] }), issue(2, { labels: ["wip"] }), issue(3)];

    expect(keys(queue(issues))).toEqual(["CLA-2", "CLA-3"]);
    expect(keys(queue(issues, { project: project({ queueFilter: { excludeLabels: ["wip"] } }) }))).toEqual(["CLA-1", "CLA-3"]);
  });

  test("entra la issue sin dueño o propia, nunca la de otra persona", () => {
    const issues = [issue(1), issue(2, { assignee: ME }), issue(3, { assignee: { id: "otra", name: "Otra" } })];

    expect(keys(queue(issues))).toEqual(["CLA-1", "CLA-2"]);
  });

  test("una issue con sub-issues abiertas no entra; con todas cerradas sí", () => {
    const parent = issue(1);
    const open = issue(2, { parent: ref(1), status: "in_progress" });
    const done = issue(3, { parent: ref(4), status: "done" });
    const closedParent = issue(4);

    const entries = queue([parent, open, done, closedParent]);

    expect(keys(entries)).toEqual(["CLA-4"]);
  });

  test("las sub-issues de otro proyecto también cuentan", () => {
    const parent = issue(1);
    const child = issue(2, { parent: ref(1), projectId: OTHER_PROJECT });

    expect(keys(queue([parent, child]))).toEqual([]);
  });

  test("sin la capacidad subIssues no se miran los hijos", () => {
    const issues = [issue(1), issue(2, { parent: ref(1), status: "in_progress" })];

    expect(keys(queue(issues, { capabilities: { ...ALL, subIssues: false } }))).toEqual(["CLA-1"]);
  });

  test("una issue con corrida del carril dev, viva o terminada, no entra", () => {
    const issues = [1, 2, 3, 4, 5, 6, 7].map((n) => issue(n));
    const runs = [run(1, "queued"), run(2, "running"), run(3, "parked"), run(4, "done", "done"), run(5, "failed"), run(6, "canceled")];

    expect(keys(queue(issues, { runs }))).toEqual(["CLA-7"]);
  });

  test("las issues de otros proyectos no entran", () => {
    const issues = [issue(1), issue(2, { projectId: OTHER_PROJECT })];

    expect(keys(queue(issues))).toEqual(["CLA-1"]);
  });
});

describe("orden", () => {
  test("prioridad: de 1 a 4 y sin prioridad (0) al final", () => {
    const issues = [issue(1, { priority: 0 }), issue(2, { priority: 4 }), issue(3, { priority: 1 }), issue(4, { priority: 2 })];

    expect(keys(queue(issues))).toEqual(["CLA-3", "CLA-4", "CLA-2", "CLA-1"]);
  });

  test("milestone: el que vence antes, luego el sin fecha por nombre y al final sin milestone", () => {
    const issues = [
      issue(1),
      issue(2, { milestone: { name: "Fase 2" } }),
      issue(3, { milestone: { name: "B", due: "2026-12-31" } }),
      issue(4, { milestone: { name: "Fase 1" } }),
      issue(5, { milestone: { name: "A", due: "2026-11-30" } }),
    ];

    expect(keys(queue(issues))).toEqual(["CLA-5", "CLA-3", "CLA-4", "CLA-2", "CLA-1"]);
  });

  test("a igual milestone gana la que bloquea a más issues", () => {
    const blocks = (n: number) => ({ relations: { blocks: Array.from({ length: n }, (_, i) => ref(90 + i)), blockedBy: [], related: [] } });
    const issues = [issue(1, blocks(0)), issue(2, blocks(2)), issue(3, blocks(1))];

    expect(keys(queue(issues))).toEqual(["CLA-2", "CLA-3", "CLA-1"]);
  });

  test("a igual bloqueo gana el estimate menor y sin estimate va al final", () => {
    const issues = [issue(1), issue(2, { estimate: 5 }), issue(3, { estimate: 1 })];

    expect(keys(queue(issues))).toEqual(["CLA-3", "CLA-2", "CLA-1"]);
  });

  test("a igual todo lo anterior, la más antigua primero", () => {
    expect(keys(queue([issue(3), issue(1), issue(2)]))).toEqual(["CLA-1", "CLA-2", "CLA-3"]);
  });

  test("la prioridad manda sobre el milestone, y este sobre el bloqueo", () => {
    const issues = [issue(1, { priority: 2, milestone: { name: "A", due: "2026-01-01" } }), issue(2, { priority: 1 }), issue(3, { priority: 2 })];

    expect(keys(queue(issues))).toEqual(["CLA-2", "CLA-1", "CLA-3"]);
  });

  test("las que el usuario subió van antes que todo, la última subida primero", () => {
    const issues = [issue(1, { priority: 1 }), issue(2, { priority: 4 }), issue(3), issue(4, { priority: 2 })];
    const boosted = new Map([
      [issueId(3), 100],
      [issueId(2), 200],
    ]);

    expect(keys(queue(issues, { boosted }))).toEqual(["CLA-2", "CLA-3", "CLA-1", "CLA-4"]);
  });

  test("una issue saltada sale blocked y marcada como saltada por el usuario", () => {
    const entries = queue([issue(1), issue(2)], { skipped: new Set([issueId(1)]) });

    expect(entries.map((e) => [e.issue.ref.key, e.state, "skipped" in e ? e.skipped : undefined])).toEqual([
      ["CLA-2", "ready", undefined],
      ["CLA-1", "blocked", true],
    ]);
  });

  test("salen primero las ready, luego las waiting y las blocked, cada grupo en su orden", () => {
    const issues = [
      issue(1, { priority: 1, ...blockedBy(10) }),
      issue(2, { priority: 2, ...blockedBy(11) }),
      issue(3, { priority: 3 }),
      issue(4, { priority: 4 }),
      issue(10, { status: "in_progress", projectId: OTHER_PROJECT }),
      issue(11, { status: "in_progress", projectId: OTHER_PROJECT }),
    ];
    const runs = [run(11, "running")];

    const entries = queue(issues, { runs });

    expect(entries.map((e) => [e.issue.ref.key, e.state])).toEqual([
      ["CLA-3", "ready"],
      ["CLA-4", "ready"],
      ["CLA-2", "waiting"],
      ["CLA-1", "blocked"],
    ]);
  });
});

describe("tabla de bloqueantes", () => {
  const blocked = (blocker: Partial<CachedIssue> = {}) => [issue(1, blockedBy(2)), issue(2, { status: "in_progress", rawStatus: "In Progress", projectId: OTHER_PROJECT, ...blocker })];

  test("sin bloqueantes: lista sobre la branch por defecto", () => {
    const entry = only(queue([issue(1)]));

    expect(entry).toMatchObject({ state: "ready", base: { kind: "default" }, dependsOn: [] });
  });

  test("bloqueante done o canceled: no bloquea", () => {
    for (const status of ["done", "canceled"] as const) {
      expect(only(queue(blocked({ status }))).state).toBe("ready");
    }
  });

  test("PR abierto del mismo repo que cumple stackOn: apilada sobre su branch", () => {
    const entry = only(queue(blocked(), { prs: [pr(2)] }));

    expect(entry).toMatchObject({ state: "ready", base: { kind: "stacked", parent: { key: "app#102", branch: "cla-2" } }, dependsOn: [], reason: "apilada sobre app#102" });
  });

  test("PR abierto en otro repo: sobre la branch por defecto y depende de repo#n, nunca como base", () => {
    const entry = only(queue(blocked(), { prs: [pr(2, { repoId: "repo_b", key: "api#7", ci: "not_green" })] }));

    expect(entry).toMatchObject({ state: "ready", base: { kind: "default" }, dependsOn: ["api#7"], reason: "lista sobre la branch por defecto, depende de api#7" });
  });

  test("bloqueante en vuelo en otro slot: waiting, y se reevalúa en el próximo tick", () => {
    const entry = only(queue(blocked(), { runs: [run(2, "running")] }));

    expect(entry).toMatchObject({ state: "waiting", reason: "espera a CLA-2, en curso" });
  });

  test("en vuelo con un PR que todavía no cumple stackOn: waiting con el motivo del PR", () => {
    const entry = only(queue(blocked(), { runs: [run(2, "running")], prs: [pr(2, { ci: "not_green" })] }));

    expect(entry).toMatchObject({ state: "waiting", reason: "espera a CLA-2: el PR app#102 todavía no cumple stackOn ci_green" });
  });

  test("un PR cuyo CI no se pudo leer dice por qué", () => {
    const entry = only(queue(blocked(), { runs: [run(2, "running")], prs: [pr(2, { ci: "unread", ciError: "401" })] }));

    expect(entry).toMatchObject({ state: "waiting", reason: "espera a CLA-2: no se pudo leer el CI de app#102 (401)" });
  });

  test.each([
    ["Todo sin correr", { status: "todo", rawStatus: "Todo" }],
    ["backlog", { status: "backlog", rawStatus: "Backlog" }],
  ] as const)("bloqueante en %s sin PR ni corrida: blocked con el motivo", (_, blocker) => {
    const entry = only(queue(blocked(blocker)));

    expect(entry).toMatchObject({ state: "blocked", reason: `bloqueada por CLA-2 (${blocker.rawStatus}): no tiene PR abierto ni corrida en curso` });
  });

  test("bloqueante de otra persona: blocked y lo dice", () => {
    const entry = only(queue(blocked({ assignee: { id: "otra", name: "Ana" } })));

    expect(entry).toMatchObject({ state: "blocked", reason: expect.stringContaining("de Ana") });
  });

  test("bloqueante con PR que no cumple stackOn y sin corrida viva: blocked", () => {
    const entry = only(queue(blocked(), { prs: [pr(2, { ci: "not_green" })], runs: [run(2, "done", "blocked")] }));

    expect(entry).toMatchObject({ state: "blocked", reason: "bloqueada por CLA-2 (In Progress): el PR app#102 todavía no cumple stackOn ci_green y su corrida ya terminó" });
  });

  test("bloqueante que no está en el caché: blocked", () => {
    const entry = only(queue([issue(1, blockedBy(99))]));

    expect(entry).toMatchObject({ state: "blocked", reason: expect.stringContaining("CLA-99") });
  });

  test("con varios bloqueantes, uno blocked manda sobre uno waiting, y este sobre uno listo", () => {
    const issues = [
      issue(1, blockedBy(2, 3, 4)),
      issue(2, { status: "in_progress", projectId: OTHER_PROJECT }),
      issue(3, { status: "in_progress", projectId: OTHER_PROJECT }),
      issue(4, { status: "done", projectId: OTHER_PROJECT }),
    ];

    expect(only(queue(issues, { prs: [pr(2)], runs: [run(3, "running")] })).state).toBe("waiting");
    expect(only(queue(issues, { prs: [pr(2)] })).state).toBe("blocked");
    expect(only(queue(issues, { prs: [pr(2), pr(3)] })).state).toBe("ready");
  });

  test("sin la capacidad relations no se calculan bloqueos", () => {
    const entry = only(queue(blocked(), { capabilities: { ...ALL, relations: false } }));

    expect(entry).toMatchObject({ state: "ready", base: { kind: "default" } });
  });

  describe("stackOn", () => {
    const withStackOn = (stackOn: StackOn, extra: Partial<TickDevInput>) => only(queue(blocked(), { project: project({ stackOn }), ...extra }));

    test("any_open apila sobre cualquier PR abierto", () => {
      expect(withStackOn("any_open", { prs: [pr(2, { ci: "not_green" })] }).state).toBe("ready");
    });

    test("ci_green pide el CI verde y no el LGTM", () => {
      expect(withStackOn("ci_green", { prs: [pr(2, { ci: "green" })] }).state).toBe("ready");
      expect(withStackOn("ci_green", { prs: [pr(2, { ci: "not_green" })], runs: [run(2, "running")] }).state).toBe("waiting");
    });

    test("ready pide que el flujo del bloqueante haya terminado ok", () => {
      expect(withStackOn("ready", { prs: [pr(2, { ci: "not_green" })], runs: [run(2, "done", "done")] }).state).toBe("ready");
      expect(withStackOn("ready", { prs: [pr(2)], runs: [run(2, "running")] })).toMatchObject({
        state: "waiting",
        reason: "espera a CLA-2: el PR app#102 todavía no cumple stackOn ready",
      });
      expect(withStackOn("ready", { prs: [pr(2)], runs: [run(2, "done", "blocked")] }).state).toBe("blocked");
    });
  });

  describe("dos o más PRs en ramas distintas", () => {
    const two = [issue(1, blockedBy(2, 3)), issue(2, { status: "in_progress", projectId: OTHER_PROJECT }), issue(3, { status: "in_progress", projectId: OTHER_PROJECT })];

    test("en la misma cadena del stack: la base es la de más arriba", () => {
      const entry = only(queue(two, { prs: [pr(2), pr(3, { baseRef: "cla-2" })] }));

      expect(entry).toMatchObject({ state: "ready", base: { kind: "stacked", parent: { key: "app#103", branch: "cla-3" } } });
    });

    test("en cadenas distintas que cumplen stackOn: base combinada de las puntas", () => {
      const entry = only(queue(two, { prs: [pr(2), pr(3)] }));

      expect(entry).toMatchObject({
        state: "ready",
        base: { kind: "combined", parents: [{ key: "app#102", branch: "cla-2" }, { key: "app#103", branch: "cla-3" }] },
        reason: "base combinada de app#102 y app#103",
      });
    });

    test("si uno no cumple stackOn, espera a que lo cumpla", () => {
      const entry = only(queue(two, { prs: [pr(2), pr(3, { ci: "not_green" })], runs: [run(3, "running")] }));

      expect(entry.state).toBe("waiting");
    });

    test("tres PRs: una cadena de dos y uno aparte son dos puntas", () => {
      const three = [...two, issue(4, { status: "in_progress", projectId: OTHER_PROJECT })];
      const issues = [issue(1, blockedBy(2, 3, 4)), ...three.slice(1)];

      const entry = only(queue(issues, { prs: [pr(2), pr(3, { baseRef: "cla-2" }), pr(4)] }));

      expect(entry).toMatchObject({ base: { kind: "combined", parents: [{ branch: "cla-3" }, { branch: "cla-4" }] } });
    });

    test("un bloqueante cerrado junto a otro con PR no estorba la base", () => {
      const issues = [issue(1, blockedBy(2, 3)), issue(2, { status: "in_progress", projectId: OTHER_PROJECT }), issue(3, { status: "done" })];

      expect(only(queue(issues, { prs: [pr(2)] }))).toMatchObject({ base: { kind: "stacked" } });
    });
  });
});

describe("pureza", () => {
  test("no muta lo que recibe y es determinista", () => {
    const issues = [issue(2, { priority: 1 }), issue(1, { priority: 1 })];
    const before = structuredClone(issues);

    const first = queue(issues);

    expect(issues).toEqual(before);
    expect(queue(issues)).toEqual(first);
  });
});

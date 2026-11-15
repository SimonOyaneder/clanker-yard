import { compileJsonSchema, Profile, Role } from "@clanker/api";
import { afterEach, describe, expect, test } from "vitest";
import { createDefs } from "../defs/defs";
import { openStore, type Store } from "../store/store";
import { clankerLoopTemplate } from "./index";

const { roles, profiles } = clankerLoopTemplate;

const open: Store[] = [];
afterEach(() => {
  for (const store of open.splice(0)) store.close();
});

describe("defs", () => {
  test("todos los roles y perfiles se guardan como defs builtin", () => {
    const store = openStore({ path: ":memory:" });
    open.push(store);
    const defs = createDefs(store);
    defs.register("role", Role);
    defs.register("profile", Profile);

    for (const [slug, body] of Object.entries(roles)) {
      defs.save({ kind: "role", slug, scope: "builtin", body, source: "import" });
    }
    for (const [slug, body] of Object.entries(profiles)) {
      defs.save({ kind: "profile", slug, scope: "builtin", body, source: "import" });
    }

    expect(defs.list("role").map((d) => d.slug).sort()).toEqual(Object.keys(roles).sort());
    expect(defs.list("profile").map((d) => d.slug).sort()).toEqual(["alto", "eco", "max", "medio"]);
  });

  test("cada perfil da modelo a todos los roles y a dev-escala", () => {
    for (const [slug, profile] of Object.entries(profiles)) {
      expect(Object.keys(profile.roles).sort(), slug).toEqual([...Object.keys(roles), "dev-escala"].sort());
    }
  });

  test("los esquemas de brief y de reporte se pueden compilar", () => {
    for (const role of Object.values(roles)) {
      for (const m of Object.values(role.modes)) {
        compileJsonSchema(m.report);
        if (m.payload) compileJsonSchema(m.payload);
      }
    }
  });

  test("los cuatro reviewers comparten el prompt y cada uno tiene su rúbrica", () => {
    const reviewers = Object.entries(roles).filter(([slug]) => slug.startsWith("review-"));
    expect(reviewers).toHaveLength(4);
    expect(new Set(reviewers.map(([, r]) => r.prompt)).size).toBe(1);
    expect(new Set(reviewers.map(([, r]) => r.modes.review?.instructions)).size).toBe(4);
  });
});

describe("prompts", () => {
  const all = [
    ...Object.entries(roles).flatMap(([slug, role]) => [
      { where: `${slug} (prompt)`, text: role.prompt },
      ...Object.entries(role.modes).map(([name, m]) => ({ where: `${slug}.${name}`, text: m.instructions })),
    ]),
  ];

  test("no piden nada que ahora hace el core", () => {
    const core = /\b(push\w*|gh|linear|squash\w*|fixups?|force|techlead|clanker-loop)\b/i;
    for (const { where, text } of all) expect(text, where).not.toMatch(core);
  });

  test("la plantilla base no trae nada propio de un repo o de una empresa", () => {
    const specific = /\b(acme|api|fin[- ]review|merge-queue|coverage-bot|srb|sorbet|rails|rspec|rubocop|tapioca|linear)\b/i;
    for (const { where, text } of all) expect(text, where).not.toMatch(specific);
  });
});

// Lo que los flujos de la plantilla (D1: techlead-clasico, pr-feedback, council, rebase-conflicto) piden a los roles.
const flowNodes = [
  { role: "dev", mode: "plan", on: ["ok"], brief: { issue: "$run.subject", ws: "$ws" } },
  { role: "plan-check", mode: "check", on: ["ok", "changes"], brief: { plan: "$plan" } },
  { role: "dev", mode: "implement", on: ["ok"], brief: { plan: "$plan", notes: "$plan-check" } },
  { role: "dev", mode: "fix", on: ["ok"], brief: { plan: "$plan", input: "$prev" } },
  ...["bugs", "tests", "patterns", "lore"].map((focus) => ({
    role: `review-${focus}`,
    mode: "review",
    on: ["ok", "changes"],
    brief: { ws: "$ws", plan: "$plan", previous: "$self" },
  })),
  { role: "review-bugs", mode: "re-review", on: ["ok", "changes"], brief: { ws: "$run.params.ws" } },
  { role: "review-tests", mode: "re-review", on: ["ok", "changes"], brief: { ws: "$run.params.ws" } },
  { role: "committer", mode: "plan", on: ["ok"], brief: { ws: "$ws", cuts: "$implement.cuts", issue: "$run.subject" } },
  { role: "committer", mode: "route", on: ["ok"], brief: { hunks: "$fixups.unrouted" } },
  { role: "triage", mode: "bot", on: ["fix", "reply"], brief: { items: "$bot-wait.items" } },
  { role: "triage", mode: "ci", on: ["fix", "foreign"], brief: { items: "$ci-wait.failures" } },
  { role: "triage", mode: "coverage", on: ["fix", "reply"], brief: { items: "$cov.items" } },
  { role: "dev", mode: "council", on: ["ok"], brief: {} },
  { role: "dev", mode: "conflict", on: ["resolved", "behavior"], brief: { failures: "$prev.failures" } },
  { role: "dev", mode: "fix", on: ["ok"], brief: { failures: "$prev.failures" } },
];

describe("calza con los flujos de la plantilla", () => {
  test.each(flowNodes.map((n) => [`${n.role} ${n.mode}`, n] as const))("%s", (_name, node) => {
    const spec = roles[node.role]?.modes[node.mode];
    expect(spec, "el rol o el modo no existe").toBeDefined();
    expect(spec?.outcomes).toEqual(expect.arrayContaining(node.on));

    // Como Flows.validate: un ref ocupa el lugar de cualquier valor.
    const result = spec?.payload ? compileJsonSchema(spec.payload).safeParse(node.brief) : undefined;
    const problems = (result?.success === false ? result.error.issues : []).filter((issue) => {
      let value: unknown = node.brief;
      for (const key of issue.path) value = (value as Record<PropertyKey, unknown> | undefined)?.[key];
      return !(typeof value === "string" && value.startsWith("$"));
    });
    expect(problems).toEqual([]);
  });

  test("un reviewer acepta como previous sus hallazgos o su reporte anterior (lo que resuelve $self)", () => {
    const payload = compileJsonSchema(roles["review-bugs"]!.modes.review!.payload!);
    const finding = { id: "f1", severity: "red", path: "a.ts", line: 1, claim: "c", fix: "f" };

    expect(payload.safeParse({ previous: [finding] }).success).toBe(true);
    expect(payload.safeParse({ previous: { findings: [finding], previous: [] }, ws: { path: "/w" } }).success).toBe(true);
    expect(payload.safeParse({}).success).toBe(true);
    expect(payload.safeParse({ previous: null }).success).toBe(true);
    expect(payload.safeParse({ previous: "f1" }).success).toBe(false);
  });

  test("el reporte de cada modo valida un ejemplo mínimo", () => {
    const finding = { id: "f1", severity: "yellow", path: "a.ts", line: 3, claim: "c", fix: "f" };
    const examples: Record<string, unknown> = {
      "dev.plan": { approach: "a", files: [], tests: [], mold: "m", assumptions: [], issueDoubts: [] },
      "dev.implement": { files: ["a.ts"], rejected: [], deletedTests: [], cuts: [{ behavior: "b", paths: ["a.ts"] }] },
      "review-bugs.review": { findings: [finding], previous: [{ id: "f0", status: "fixed" }] },
      "committer.plan": {
        commits: [{ message: "feat: x", hunks: ["h1"], tests: ["t"], whyAtomic: "w" }],
        pr: { title: "t", body: "b" },
        notes: [],
      },
      "triage.bot": { items: [{ id: "1", verdict: "false_positive", reply: "r" }] },
      "plan-check.check": { doubts: [{ says: "s", decision: "issue", why: "w" }], corrections: [] },
    };
    for (const [key, payload] of Object.entries(examples)) {
      const [role, mode] = key.split(".") as [string, string];
      const spec = roles[role]?.modes[mode];
      expect(compileJsonSchema(spec!.report).safeParse(payload).success, key).toBe(true);
    }
  });
});

describe("esquemas de reporte", () => {
  const reportsOf = (role: Role) =>
    Object.fromEntries(Object.entries(role.modes).map(([name, m]) => [name, m.report]));

  test("los cuatro reviewers devuelven el mismo reporte", () => {
    const [first, ...rest] = Object.entries(roles)
      .filter(([slug]) => slug.startsWith("review-"))
      .map(([, role]) => reportsOf(role));
    for (const other of rest) expect(other).toEqual(first);
  });

  test("snapshot", () => {
    const distinct = Object.entries(roles).filter(([slug]) => !slug.startsWith("review-") || slug === "review-bugs");
    expect(Object.fromEntries(distinct.map(([slug, role]) => [slug, reportsOf(role)]))).toMatchSnapshot();
  });
});

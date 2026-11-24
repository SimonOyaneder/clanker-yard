import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import { briefOfMessage } from "../agents/brief";
import { git } from "../git/git";
import { roundChange } from "../git/tree";
import { DE_ISSUE_A_PR } from "../template/flows";
import { type Finding, type ReviewBrief } from "../template/payloads";
import { roles } from "../template/roles";
import { harness, okReport } from "../testing/flows-harness";

const cleanup: (() => void | Promise<void>)[] = [];
afterEach(async () => { for (const fn of cleanup.splice(0).reverse()) await fn(); });

const reviewRoles = Object.fromEntries(Object.entries(roles).filter(([role]) => role.startsWith("review-")));

function saveReviews(h: ReturnType<typeof harness>) {
  h.action("prepare", ["ok"]);
  const { reviews, ...nodes } = DE_ISSUE_A_PR.nodes;
  h.save({
    schema: 1, id: "review-rounds", name: "Rondas", start: "ws", trigger: { type: "manual" },
    nodes: {
      ws: { type: "action", action: "prepare", args: {}, on: { ok: "plan" } },
      plan: { type: "action", action: "prepare", args: {}, on: { ok: "reviews" } },
      reviews: { ...reviews, on: { ok: "@done", changes: { to: "fix", maxRounds: 2, exhausted: "@failed" } } },
      ...Object.fromEntries(Object.entries(nodes).filter(([id]) => id.startsWith("rv-"))
        .map(([id, node]) => [id, { ...node, retry: { max: 0, backoffSec: [] } }])),
      fix: { type: "action", action: "fix", args: { findings: "$reviews.findings" }, on: { ok: "reviews" } },
    },
  });
}

test("un reviewer pre-PR que falla sin hallazgos impide dar por aprobada la revisión", async () => {
  const h = harness({
    roles: reviewRoles,
    script: async (call) => call.spec?.role === "review-tests"
      ? { status: "error", message: "se cortó la revisión" }
      : okReport({ findings: [], previous: [] }),
  });
  cleanup.push(h.cleanup);
  h.action("fix", ["ok"]);
  saveReviews(h);
  const id = h.start("review-rounds");
  await h.finished(id);
  const run = h.flows.getRun(id);
  expect(run.status).toBe("parked");
  expect(run.steps.find((s) => s.nodeId === "reviews")).toMatchObject({ outcome: "error", error: expect.stringContaining("rv-tests") });
});

test("un fix en producción reabre tests y patterns; el fix de formato solo reabre los pendientes", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "rounds-"));
  cleanup.push(() => rmSync(cwd, { recursive: true, force: true }));
  await git(cwd, ["init", "-q"]);
  await git(cwd, ["-c", "core.hooksPath=/dev/null", "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "base", "--allow-empty"]);
  const path = "transfer.rb";
  writeFileSync(join(cwd, path), "return 1\n");
  const issue: Finding = { id: "f1", severity: "red", path, line: 1, claim: "permite cero", fix: "rechazar cero" };
  const coverage: Finding = { ...issue, severity: "yellow", claim: "falta el caso de rechazo", fix: "cubrir el rechazo" };
  const pending: Finding[][] = [];
  const visits: string[][] = [[], [], []];
  let round = 0;
  const h = harness({
    workspaceOf: () => ({ path: cwd, base: "main" }),
    roundChange,
    roles: reviewRoles,
    script: async (call) => {
      const role = call.spec!.role;
      visits[round]!.push(role);
      const brief = briefOfMessage(call.prompt)?.payload as ReviewBrief;
      const old = Array.isArray(brief.previous) ? brief.previous : [];
      if (role === "review-bugs" && round === 0) return okReport({ findings: [issue], previous: [] }, "changes");
      if (role === "review-tests" && round === 1) return okReport({ findings: [coverage], previous: [] }, "changes");
      // Un ok contradictorio no cierra el hallazgo que el propio reviewer marca open.
      return okReport({ findings: [], previous: old.map(({ id }) => ({ id, status: round === 1 ? "open" : "fixed" })) });
    },
  });
  cleanup.push(h.cleanup);
  h.action("fix", ["ok"], ({ findings }) => {
    pending.push(findings as Finding[]);
    writeFileSync(join(cwd, path), ++round === 1 ? "return 2\n" : "return 2  \n");
    return { outcome: "ok" };
  });
  saveReviews(h);
  const id = h.start("review-rounds");
  await h.finished(id);
  expect(h.flows.getRun(id).outcome).toBe("done");
  expect(visits.map((v) => v.sort())).toEqual([
    ["review-bugs", "review-lore", "review-patterns", "review-tests"],
    ["review-bugs", "review-patterns", "review-tests"],
    ["review-bugs", "review-tests"],
  ]);
  expect(pending[0]).toEqual([expect.objectContaining({ ...issue, id: expect.stringMatching(/^[0-9a-f]{12}$/), branch: "rv-bugs" })]);
  expect(pending[1]).toContainEqual(pending[0]![0]);
});

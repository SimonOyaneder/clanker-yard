import { describe, expect, test } from "vitest";
import * as z from "zod";
import { Brief, ContextPackage, ContextRef, ContextSource, Profile, Report, Role } from "./index";

const mode = {
  instructions: "Revisa el cambio.",
  report: { type: "object", properties: { findings: { type: "array" } }, required: ["findings"] },
  outcomes: ["lgtm", "changes"],
  session: "new",
} as const;

describe("Role", () => {
  test("acepta cualquier nombre de modo y los defaults opcionales", () => {
    const role = Role.parse({ prompt: "p", context: [], modes: { auditoria: mode, otro: mode } });

    expect(Object.keys(role.modes)).toEqual(["auditoria", "otro"]);
    expect(role.tools).toBeUndefined();
    expect(role.hooks).toBeUndefined();
  });

  test("rechaza un rol sin modos", () => {
    expect(Role.safeParse({ prompt: "p", context: [], modes: {} }).success).toBe(false);
  });

  test("rechaza un modo sin outcomes", () => {
    const result = Role.safeParse({
      prompt: "p",
      context: [],
      modes: { a: { ...mode, outcomes: [] } },
    });

    expect(result.success).toBe(false);
  });

  test("rechaza un esquema de reporte que el core no puede validar", () => {
    const result = Role.safeParse({
      prompt: "p",
      context: [],
      modes: { a: { ...mode, report: { type: "nonsense" } } },
    });

    expect(result.success).toBe(false);
    expect(JSON.stringify(result.error?.issues)).toContain("modes");
  });
});

describe("ToolPolicy y ContextSource", () => {
  test("una política acotada y las cuatro fuentes de contexto son válidas", () => {
    const role = Role.parse({
      prompt: "p",
      context: [
        { kind: "native", sources: ["user", "project"], skills: "all" },
        { kind: "pack", id: "commits" },
        { kind: "repo", files: ["AGENTS.md"] },
        { kind: "file", path: "/x/SKILL.md" },
      ],
      tools: { allow: ["Read", "Grep"], deny: ["Bash"] },
      modes: { a: mode },
    });

    expect(role.context.map((c: ContextSource) => c.kind)).toEqual(["native", "pack", "repo", "file"]);
  });

  test("una fuente de contexto desconocida se rechaza", () => {
    expect(ContextSource.safeParse({ kind: "web", url: "x" }).success).toBe(false);
  });
});

describe("ContextPackage", () => {
  test("guarda referencias de los cuatro tipos", () => {
    const refs = ["skill:commit", "rule:git-safety", "repo:AGENTS.md", "file:~/lore/core_patterns.md"];
    expect(ContextPackage.parse({ description: "cómo hago commits", refs }).refs).toEqual(refs);
  });

  test("un paquete sin referencias, o con una de tipo desconocido o vacía, se rechaza", () => {
    expect(ContextPackage.safeParse({ refs: [] }).success).toBe(false);
    expect(ContextRef.safeParse("url:https://x").success).toBe(false);
    expect(ContextRef.safeParse("skill:").success).toBe(false);
    expect(ContextRef.safeParse("AGENTS.md").success).toBe(false);
  });
});

describe("Profile, Brief y Report", () => {
  test("el perfil define modelo por rol", () => {
    expect(Profile.parse({ roles: { x: { model: "sonnet", effort: "high" } } }).roles.x?.model).toBe(
      "sonnet",
    );
    expect(Profile.safeParse({ roles: { x: { effort: "high" } } }).success).toBe(false);
  });

  test("cada entrada del perfil elige su runtime, y solo uno de los conocidos", () => {
    const profile = Profile.parse({ roles: { dev: { model: "opus" }, review: { runtime: "opencode", model: "openai/gpt-6.1-terra" }, codex: { runtime: "codex", model: "gpt-5.4" } } });
    expect(profile.roles.dev?.runtime).toBeUndefined();
    expect(profile.roles.review?.runtime).toBe("opencode");
    expect(profile.roles.codex?.runtime).toBe("codex");
    expect(Profile.safeParse({ roles: { x: { runtime: "unknown", model: "o3" } } }).success).toBe(false);
  });

  test("el brief exige el id de la corrida con prefijo", () => {
    const brief = {
      run: { id: "run_01J0000000000000000000000A", subject: { type: "issue", id: "1" }, round: 1, attempt: 1 },
      worktree: "/w",
      base: "origin/main",
      mode: "a",
      artifacts: {},
      payload: { cualquier: "cosa" },
    };

    expect(Brief.safeParse(brief).success).toBe(true);
    expect(Brief.safeParse({ ...brief, run: { ...brief.run, id: "x" } }).success).toBe(false);
  });

  test("el reporte lleva outcome, summary y un payload libre", () => {
    expect(Report.safeParse({ outcome: "lgtm", summary: "ok", payload: { a: 1 } }).success).toBe(true);
    expect(Report.safeParse({ summary: "ok", payload: {} }).success).toBe(false);
  });

  test("cada learning lleva su alcance, y los guardados como texto se leen como del proyecto", () => {
    const report = { outcome: "ok", summary: "ok", payload: {} };
    expect(Report.parse({ ...report, learnings: [{ text: "Usa x", scope: "repo" }] }).learnings).toEqual([{ text: "Usa x", scope: "repo" }]);
    expect(Report.parse({ ...report, learnings: ["Usa y"] }).learnings).toEqual([{ text: "Usa y", scope: "project" }]);
    expect(Report.safeParse({ ...report, learnings: [{ text: "Usa z", scope: "org" }] }).success).toBe(false);
  });

  test("el esquema que ve el agente pide learnings como objetos con alcance, no texto suelto", () => {
    expect(z.toJSONSchema(Report)).toMatchObject({
      properties: { learnings: { type: "array", items: { type: "object", required: ["text", "scope"] } } },
    });
  });
});

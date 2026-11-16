import { describe, expect, test } from "vitest";
import { createScrubber } from "./record";

const scrub = createScrubber({ cwd: "/work/wt/CLA-30", home: "/data/clanker", secrets: ["sk-ant-oat01-exacto-del-run"] });

describe("createScrubber", () => {
  test("el worktree queda como ruta relativa y no toca otras carpetas que empiezan igual", () => {
    expect(scrub("lee /work/wt/CLA-30/app/x.rb")).toBe("lee app/x.rb");
    expect(scrub("cd /work/wt/CLA-30 && ls")).toBe("cd . && ls");
    expect(scrub("/work/wt/CLA-30-otro/x")).toBe("/work/wt/CLA-30-otro/x");
  });

  test("CLANKER_HOME y las carpetas de usuario se reemplazan", () => {
    expect(scrub("/data/clanker/transcripts/a.jsonl")).toBe("<clanker-home>/transcripts/a.jsonl");
    expect(scrub("/Users/alguien/.claude/skills y /home/ci/.config")).toBe("<home>/.claude/skills y <home>/.config");
  });

  test.each([
    ["sk-ant-api03-abcdefghijklmnopqrstuvwxyz", "[secreto]"],
    ["ghs_abcdefghijklmnopqrstuvwxyz0123456789", "[secreto]"],
    ["ghp_abcdefghijklmnopqrstuvwxyz0123456789", "[secreto]"],
    ["github_pat_11ABCDEFG0abcdefghijklmnop_qrstuv", "[secreto]"],
    ["lin_api_abcdefghijklmnopqrstuvwxyz012345", "[secreto]"],
    ["Authorization: Bearer abcdefghijklmnop1234", "Authorization: Bearer [secreto]"],
    ["https://user:hunter2@github.com/x.git", "https://[secreto]@github.com/x.git"],
    ["ANTHROPIC_API_KEY=abc123 npm test", "ANTHROPIC_API_KEY=[secreto] npm test"],
    ['{"access_token": "abc123"}', '{"access_token": "[secreto]"}'],
    ["el valor sk-ant-oat01-exacto-del-run quedó", "el valor [secreto] quedó"],
  ])("limpia %s", (input, expected) => {
    expect(scrub(input)).toBe(expected);
  });

  test("un texto sin secretos ni rutas queda igual", () => {
    expect(scrub("Reviso el diff y encuentro 2 hallazgos")).toBe("Reviso el diff y encuentro 2 hallazgos");
  });
});

import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { skillDirs, watchDirs } from "./skills-watch";

let root: string;
const stops: (() => void)[] = [];
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "skills-watch-"));
});
afterEach(async () => {
  for (const stop of stops.splice(0)) stop();
  await rm(root, { recursive: true, force: true });
});

describe("skillDirs", () => {
  test("las carpetas de skills y comandos de cada source del rol", () => {
    expect(skillDirs({ sources: ["user", "project"], skills: ["commit"] }, "/w", "/u")).toEqual([
      "/u/skills",
      "/u/commands",
      "/w/.claude/skills",
      "/w/.claude/commands",
    ]);
    expect(skillDirs({ sources: ["project"], skills: "all" }, "/w", "/u")).toEqual(["/w/.claude/skills", "/w/.claude/commands"]);
  });

  test("un rol sin skills no observa nada", () => {
    expect(skillDirs({ sources: ["user"], skills: [] }, "/w", "/u")).toEqual([]);
    expect(skillDirs(undefined, "/w", "/u")).toEqual([]);
  });
});

describe("watchDirs", () => {
  test("avisa una vez por ráfaga de cambios, también en una skill nueva, y omite las carpetas que no existen", async () => {
    const skills = join(root, "skills");
    await mkdir(skills);
    const onChange = vi.fn();
    stops.push(watchDirs([join(root, "no-existe"), skills], onChange, (error) => { throw error; }));

    await mkdir(join(skills, "commit"));
    await writeFile(join(skills, "commit", "SKILL.md"), "# v1");
    await writeFile(join(skills, "commit", "SKILL.md"), "# v2");

    await vi.waitFor(() => expect(onChange).toHaveBeenCalledTimes(1));
  });
});

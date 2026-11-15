import type { ClankerProject } from "@clanker/api";
import { describe, expect, test } from "vitest";
import { planIssue } from "./issue-repos";

const id = (name: string) => name as ClankerProject["repos"][number]["repoId"];
const FRONT = id("front");
const BACK = id("back");
const project = { repos: [{ repoId: FRONT, labels: ["frontend"] }, { repoId: BACK, labels: ["backend"] }] };

describe("planIssue", () => {
  test("un label mapea a su repo", () => {
    expect(planIssue(project, ["backend"], undefined, [])).toEqual({ kind: "repos", repoIds: [BACK], next: { repoId: BACK, after: undefined } });
  });

  test("ningún label calza en un proyecto con varios repos: ambigua, con los repos a elegir", () => {
    expect(planIssue(project, ["otro"], undefined, [])).toEqual({ kind: "ambiguous", candidates: [FRONT, BACK] });
  });

  test("el repo elegido resuelve la ambigüedad; uno que ya no es del proyecto no", () => {
    expect(planIssue(project, [], BACK, [])).toMatchObject({ kind: "repos", repoIds: [BACK] });
    expect(planIssue(project, [], "gone", [])).toMatchObject({ kind: "ambiguous" });
  });

  test("un label calzado manda sobre lo elegido", () => {
    expect(planIssue(project, ["frontend"], BACK, [])).toMatchObject({ repoIds: [FRONT] });
  });

  test("un proyecto con un repo, o sin ninguno, nunca es ambiguo", () => {
    expect(planIssue({ repos: [{ repoId: FRONT, labels: [] }] }, ["x"], undefined, [])).toMatchObject({ repoIds: [FRONT], next: { repoId: FRONT } });
    expect(planIssue({ repos: [] }, [], undefined, [])).toEqual({ kind: "repos", repoIds: [], next: { repoId: undefined, after: undefined } });
  });

  test("con una corrida ya no queda nada que lanzar en un proyecto de un repo", () => {
    expect(planIssue({ repos: [{ repoId: FRONT, labels: [] }] }, [], undefined, [{}])).toMatchObject({ next: undefined });
    expect(planIssue({ repos: [] }, [], undefined, [{}])).toMatchObject({ next: undefined });
  });

  test("dos repos: uno por corrida, en el orden del proyecto, y cada uno sigue al anterior", () => {
    const both = ["backend", "frontend"];

    expect(planIssue(project, both, undefined, [])).toMatchObject({ repoIds: [FRONT, BACK], next: { repoId: FRONT, after: undefined } });
    expect(planIssue(project, both, undefined, [{ repoId: FRONT }])).toMatchObject({ next: { repoId: BACK, after: FRONT } });
    expect(planIssue(project, both, undefined, [{ repoId: FRONT }, { repoId: BACK }])).toMatchObject({ next: undefined });
  });
});

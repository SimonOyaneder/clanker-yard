import { describe, expect, test } from "vitest";
import {
  Issue,
  IssueFilter,
  IssueRef,
  NewLocalIssue,
  StatusCategory,
} from "./index";

const ref = {
  tracker: "linear",
  id: "abc",
  key: "ENG-9171",
  url: "https://linear.app/x/issue/ENG-9171",
};
const issue = {
  ref,
  project: "p1",
  title: "Algo",
  body: "",
  status: "todo",
  rawStatus: "Todo",
  priority: 2,
  labels: [],
  relations: { blocks: [], blockedBy: [], related: [] },
  updatedAt: 1_700_000_000_000,
};

test("StatusCategory son las 6 categorías del diseño", () => {
  expect(StatusCategory.options).toEqual([
    "backlog",
    "todo",
    "in_progress",
    "in_review",
    "done",
    "canceled",
  ]);
});

describe("Issue", () => {
  test("acepta una issue mínima y una con todo", () => {
    expect(Issue.parse(issue)).toEqual(issue);
    const full = {
      ...issue,
      assignee: { id: "u1", name: "Ana" },
      estimate: 3,
      parent: ref,
      milestone: { name: "Fase 0", due: "2026-12-31" },
    };
    expect(Issue.parse(full)).toEqual(full);
  });

  test("rechaza prioridades fuera de 0 a 4 y trackers desconocidos", () => {
    expect(Issue.safeParse({ ...issue, priority: 5 }).success).toBe(false);
    expect(Issue.safeParse({ ...issue, priority: 2.5 }).success).toBe(false);
    expect(IssueRef.safeParse({ ...ref, tracker: "trello" }).success).toBe(
      false,
    );
  });
});

test("IssueFilter no acepta listas vacías: un filtro vacío no filtra, uno con [] sería ambiguo", () => {
  expect(IssueFilter.parse({})).toEqual({});
  expect(
    IssueFilter.parse({ status: ["todo"], excludeLabels: ["no-clanker"] }),
  ).toBeDefined();
  expect(IssueFilter.safeParse({ status: [] }).success).toBe(false);
});

test("NewLocalIssue pone los defaults de una issue nueva", () => {
  expect(NewLocalIssue.parse({ title: "x" })).toEqual({
    title: "x",
    body: "",
    status: "todo",
    priority: 0,
    labels: [],
  });
  expect(NewLocalIssue.safeParse({ title: "" }).success).toBe(false);
});

import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { NewLearning } from "@clanker/api";
import { newId } from "../store/conventions";
import { openStore, type Store } from "../store/store";
import { createLearnings, LearningNotFoundError, LearningUpdateError, type Learnings } from "./learnings";

let store: Store;
let learnings: Learnings;
const project = newId("prj");
const repo = newId("repo");

beforeEach(() => {
  store = openStore({ path: ":memory:" });
  learnings = createLearnings(store);
});
afterEach(() => store.close());

const propose = (text: string, extra: { roles?: string[]; repoId?: typeof repo; projectId?: typeof project } = {}) =>
  learnings.propose({ ...(extra.repoId ? {} : { projectId: extra.projectId ?? project }), ...(extra.repoId && { repoId: extra.repoId }), text, roles: extra.roles ?? [], tags: [] }, "ui");
const events = (type: string) => store.events.since(0, { types: [type as never] });

describe("propose", () => {
  test("deja un learning proposed de una persona y emite learning.proposed", () => {
    const learning = propose("Usa `let_it_be`");

    expect(learning).toMatchObject({ projectId: project, repoId: null, text: "Usa `let_it_be`", status: "proposed", source: "human", sourceRunId: null });
    expect(events("learning.proposed").map((e) => [e.origin, e.projectId, e.payload])).toEqual([["ui", project, { learningId: learning.id }]]);
  });

  test("el mismo texto en el mismo alcance devuelve el que había, sea cual sea su estado, sin evento", () => {
    const first = propose("Usa `let_it_be`");
    learnings.reject(first.id, "ui");

    expect(propose("Usa `let_it_be`")).toMatchObject({ id: first.id, status: "rejected" });
    expect(events("learning.proposed")).toHaveLength(1);
    // En otro alcance es otro learning.
    expect(propose("Usa `let_it_be`", { repoId: repo }).id).not.toBe(first.id);
  });

  test("el esquema pide exactamente un alcance: proyecto o repo", () => {
    expect(NewLearning.safeParse({ text: "x" }).success).toBe(false);
    expect(NewLearning.safeParse({ text: "x", projectId: project, repoId: repo }).success).toBe(false);
    expect(NewLearning.safeParse({ text: "   ", projectId: project }).success).toBe(false);
    expect(NewLearning.safeParse({ text: " x ", projectId: project }).data).toEqual({ text: "x", projectId: project, roles: [], tags: [] });
  });
});

describe("approve y reject", () => {
  test("approve pasa a approved y emite una vez; repetirlo no cambia nada", () => {
    const { id } = propose("a");

    expect(learnings.approve(id, "ui").status).toBe("approved");
    expect(learnings.approve(id, "ui").status).toBe("approved");

    expect(events("learning.approved")).toHaveLength(1);
  });

  test("reject deja un proposed rejected y retira un approved a archived; un rechazado se puede aprobar después", () => {
    const proposed = propose("a");
    const approved = learnings.approve(propose("b").id, "ui");

    expect(learnings.reject(proposed.id, "cli").status).toBe("rejected");
    expect(learnings.reject(approved.id, "ui").status).toBe("archived");
    expect(learnings.reject(approved.id, "ui").status).toBe("archived");
    expect(events("learning.rejected").map((e) => [e.origin, e.payload])).toEqual([
      ["cli", { learningId: proposed.id }],
      ["ui", { learningId: approved.id }],
    ]);

    expect(learnings.approve(proposed.id, "ui").status).toBe("approved");
  });

  test("un id que no existe lanza LearningNotFoundError", () => {
    const id = newId("lrn");
    expect(() => learnings.approve(id, "ui")).toThrow(LearningNotFoundError);
    expect(() => learnings.reject(id, "ui")).toThrow(LearningNotFoundError);
    expect(() => learnings.update({ id, text: "x" })).toThrow(LearningNotFoundError);
  });
});

describe("update", () => {
  test("cambia lo que se pasa y deja el resto, sin tocar el estado", () => {
    const { id } = propose("a", { roles: ["dev"] });
    learnings.approve(id, "ui");

    expect(learnings.update({ id, text: "b" })).toMatchObject({ text: "b", roles: ["dev"], status: "approved" });
    expect(learnings.update({ id, roles: [], tags: ["git"] })).toMatchObject({ text: "b", roles: [], tags: ["git"] });
  });

  test("no deja repetir el texto de otro learning del mismo alcance", () => {
    propose("a");
    const { id } = propose("b");

    expect(() => learnings.update({ id, text: "a" })).toThrow(LearningUpdateError);
    expect(learnings.update({ id, text: "b" }).text).toBe("b");
  });
});

describe("list", () => {
  test("filtra por alcance y estado, del más reciente al más antiguo", () => {
    const a = propose("a");
    const b = propose("b");
    const c = propose("c", { repoId: repo });
    learnings.approve(b.id, "ui");

    expect(learnings.list().map((l) => l.id)).toEqual([c.id, b.id, a.id]);
    expect(learnings.list({ projectId: project }).map((l) => l.id)).toEqual([b.id, a.id]);
    expect(learnings.list({ repoId: repo }).map((l) => l.id)).toEqual([c.id]);
    expect(learnings.list({ status: ["approved"] }).map((l) => l.id)).toEqual([b.id]);
    expect(learnings.get(a.id)).toEqual(a);
  });
});

describe("forBrief", () => {
  const approve = (text: string, extra?: Parameters<typeof propose>[1]) => learnings.approve(propose(text, extra).id, "ui");

  test("solo los approved: proposed, rejected y archived no entran", () => {
    approve("entra");
    propose("propuesto");
    learnings.reject(propose("rechazado").id, "ui");
    learnings.reject(approve("retirado").id, "ui");

    expect(learnings.forBrief({ projectId: project, role: "dev" })).toEqual(["entra"]);
  });

  test("filtra por proyecto, repo y rol: roles vacío es todos, y los del repo van primero", () => {
    approve("del proyecto");
    approve("solo reviewers", { roles: ["review-bugs"] });
    approve("del repo", { repoId: repo });
    approve("de otro proyecto", { projectId: newId("prj") });
    approve("de otro repo", { repoId: newId("repo") });

    expect(learnings.forBrief({ projectId: project, repoId: repo, role: "dev" })).toEqual(["del repo", "del proyecto"]);
    expect(learnings.forBrief({ projectId: project, repoId: repo, role: "review-bugs" })).toEqual(["del repo", "solo reviewers", "del proyecto"]);
    expect(learnings.forBrief({ projectId: project, role: "dev" })).toEqual(["del proyecto"]);
    expect(learnings.forBrief({ role: "dev" })).toEqual([]);
  });
});

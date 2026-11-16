import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { NewLearning } from "@clanker/api";
import { eq } from "drizzle-orm";
import { newId } from "../store/conventions";
import { learnings as learningsTable } from "../store/schema";
import { openStore, type Store } from "../store/store";
import type { AgentRuntime, RunSpec } from "../agents/runtime";
import { createLearnings, LearningNotFoundError, LearningScreenError, LearningUpdateError, type Learnings } from "./learnings";

let store: Store;
let learnings: Learnings;
const project = newId("prj");
const repo = newId("repo");

beforeEach(() => {
  store = openStore({ path: ":memory:" });
  learnings = createLearnings({ store });
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

describe("repetidos", () => {
  test("un texto casi igual (minúsculas, sin backticks ni puntuación) devuelve el existente", () => {
    const first = propose("Usa `let_it_be` en los specs.");

    expect(propose("usa let_it_be, en los SPECS").id).toBe(first.id);
    expect(propose("Usa `let_it_be` en los specs de otro tipo").id).not.toBe(first.id);
    expect(events("learning.proposed")).toHaveLength(2);
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
    expect(() => learnings.update({ id, text: "x" }, "ui")).toThrow(LearningNotFoundError);
  });
});

describe("update", () => {
  test("cambia lo que se pasa y deja el resto, sin tocar el estado", () => {
    const { id } = propose("a", { roles: ["dev"] });
    learnings.approve(id, "ui");

    expect(learnings.update({ id, text: "b" }, "ui")).toMatchObject({ text: "b", roles: ["dev"], status: "approved" });
    expect(learnings.update({ id, roles: [], tags: ["git"] }, "ui")).toMatchObject({ text: "b", roles: [], tags: ["git"] });
    expect(store.events.since(0, { types: ["learning.updated"] }).map((e) => [e.origin, e.payload])).toEqual([
      ["ui", { learningId: id, fields: ["text"] }],
      ["ui", { learningId: id, fields: ["roles", "tags"] }],
    ]);
  });

  test("no deja repetir el texto de otro learning del mismo alcance", () => {
    propose("a");
    const { id } = propose("b");

    expect(() => learnings.update({ id, text: "a" }, "ui")).toThrow(LearningUpdateError);
    expect(learnings.update({ id, text: "b" }, "ui").text).toBe("b");
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

describe("archive", () => {
  test("un proposed pasa a archived y emite; uno aprobado o ya archivado queda igual", () => {
    const proposed = propose("a");
    const approved = learnings.approve(propose("b").id, "ui");

    const archived = learnings.archive([proposed.id, approved.id], "ui");

    expect(archived.map((l) => l.status)).toEqual(["archived", "approved"]);
    expect(events("learning.rejected")).toHaveLength(1);
    expect(learnings.archive([proposed.id], "ui")[0]!.status).toBe("archived");
    expect(events("learning.rejected")).toHaveLength(1);
    // No se borra: sigue ahí y se puede volver a aprobar.
    expect(learnings.approve(proposed.id, "ui").status).toBe("approved");
  });
});

describe("screen", () => {
  /** Un runtime que responde `structured` y guarda lo que se le pidió. */
  function runtimeAnswering(structured: unknown, status: "success" | "error" = "success") {
    const specs: RunSpec[] = [];
    const usage = { turns: 1, tokensIn: 0, tokensOut: 0, tokensCacheRead: 0, tokensCacheWrite: 0, costMicros: 0, costSource: "estimate" } as const;
    const runtime: AgentRuntime = {
      id: "fake",
      capabilities: { structuredOutput: true, costPerTurn: false, resume: false, fork: false, steer: false },
      start: (spec) => {
        specs.push(spec);
        return Promise.resolve({
          ref: { runtime: "fake", sessionId: "s", cwd: spec.cwd },
          events: (async function* () {})(),
          interrupt: () => Promise.resolve(),
          result: Promise.resolve({ status, text: "", structured, usage, ...(status === "error" && { message: "sin cuota" }) }),
        });
      },
      resume: () => Promise.reject(new Error("no se usa")),
    };
    return { runtime, specs };
  }
  const asAgent = (text: string) => {
    const learning = propose(text);
    store.db.update(learningsTable).set({ source: "agent" }).where(eq(learningsTable.id, learning.id)).run();
    return learning;
  };

  test("revisa solo los propuestos por agentes con un modelo barato, sin cambiar nada", async () => {
    const good = asAgent("Corre `doppler run` para tapioca");
    const bad = asAgent("El job X se mantiene como está");
    propose("a mano");
    const { runtime, specs } = runtimeAnswering({
      verdicts: [
        { id: good.id, keep: true, reason: "reutilizable" },
        { id: bad.id, keep: false, reason: "dato de una sola issue" },
      ],
    });

    const verdicts = await createLearnings({ store, runtime }).screen();

    expect(verdicts).toEqual([
      { id: bad.id, keep: false, reason: "dato de una sola issue" },
      { id: good.id, keep: true, reason: "reutilizable" },
    ]);
    expect(specs).toHaveLength(1);
    expect(specs[0]).toMatchObject({ model: "haiku", tools: { allow: [] } });
    expect(specs[0]!.prompt).toContain("Reutilizable");
    expect(specs[0]!.prompt).toContain(good.text);
    expect(specs[0]!.prompt).not.toContain("a mano");
    expect(learnings.list().map((l) => l.status)).toEqual(["proposed", "proposed", "proposed"]);
  });

  test("un learning sin veredicto se conserva", async () => {
    const one = asAgent("uno");
    const { runtime } = runtimeAnswering({ verdicts: [] });

    expect(await createLearnings({ store, runtime }).screen()).toEqual([{ id: one.id, keep: true, reason: expect.any(String) }]);
  });

  test("si el agente falla o no responde con el formato, lanza un error de dominio y no cambia nada", async () => {
    asAgent("uno");

    await expect(createLearnings({ store, runtime: runtimeAnswering(undefined, "error").runtime }).screen()).rejects.toThrow(LearningScreenError);
    await expect(createLearnings({ store, runtime: runtimeAnswering({ nope: 1 }).runtime }).screen()).rejects.toThrow(/veredictos válidos/);
    await expect(learnings.screen()).rejects.toThrow(LearningScreenError);
    expect(learnings.list()[0]!.status).toBe("proposed");
  });
});

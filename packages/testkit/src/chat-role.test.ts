import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Brief } from "@clanker/api";
import { clankerLoopTemplate, createAgents, createDefs, createRuntimeRegistry, newId, openStore, type Store } from "@clanker/core";
import { afterEach, expect, test, vi } from "vitest";
import { createFakeRuntime } from "./fake-runtime";
import { tempGitRepo, type TempGitRepo } from "./git";

const fixtures = join(dirname(fileURLToPath(import.meta.url)), "../fixtures/runs/chat");
let store: Store;
let repo: TempGitRepo;
afterEach(() => {
  store?.close();
  repo?.cleanup();
});

test("chat edita el borrador y retoma la misma sesión para responder sin modificarlo", async () => {
  repo = tempGitRepo({ commits: [{ message: "init", files: { "hello.txt": "Hola\n", "AGENTS.md": "Edita solo lo pedido.\n" } }] });
  store = openStore({ path: ":memory:" });
  const defs = createDefs({ store });
  const runtime = createFakeRuntime({ fixtures, speed: Infinity });
  const start = vi.spyOn(runtime, "start");
  const resume = vi.spyOn(runtime, "resume");
  const agents = createAgents({ store, defs, runtimes: createRuntimeRegistry([runtime], {}) });
  defs.save({ kind: "role", slug: "chat", scope: "builtin", body: clankerLoopTemplate.roles.chat!, source: "import" });
  defs.save({ kind: "profile", slug: "medio", scope: "builtin", body: clankerLoopTemplate.profiles.medio!, source: "import" });
  const brief: Brief = {
    run: { id: newId("run"), subject: { type: "pr", id: "pr-1" }, round: 1, attempt: 1 },
    worktree: repo.dir,
    base: "origin/main",
    mode: "turn",
    artifacts: {},
    payload: { text: "Cambia el saludo por Hola mundo" },
  };
  const request = { role: "chat", profile: "medio", mode: "turn", workspace: repo.dir, brief };

  const first = await agents.run(request);

  expect(first).toMatchObject({
    status: "success",
    report: {
      outcome: "ok",
      payload: {
        reply: "Actualicé el saludo en `hello.txt`.",
        proposal: { summary: "Ajusta el saludo", items: [{ id: "c1", change: "Actualiza el saludo", path: "hello.txt" }] },
      },
    },
  });
  expect(readFileSync(join(repo.dir, "hello.txt"), "utf8")).toBe("Hola mundo\n");
  const diff = repo.git("diff");

  const second = await agents.run({
    ...request,
    resumeFrom: first.sessionId,
    brief: { ...brief, run: { ...brief.run, round: 2 }, payload: { text: "Explica el cambio" } },
  });

  expect(second).toMatchObject({
    status: "success",
    sessionId: first.sessionId,
    report: { outcome: "ok", payload: { reply: "El saludo en `hello.txt` ahora dice «Hola mundo».", proposal: null } },
  });
  expect(start).toHaveBeenCalledTimes(1);
  expect(resume).toHaveBeenCalledTimes(1);
  expect(resume).toHaveBeenCalledWith(
    (await start.mock.results[0]!.value).ref,
    expect.stringContaining("Explica el cambio"),
    expect.any(Object),
  );
  expect(repo.git("diff")).toBe(diff);
});

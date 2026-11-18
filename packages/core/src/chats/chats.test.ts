import type { ChatId } from "@clanker/api";
import { describe, expect, test, vi } from "vitest";
import { createArtifacts } from "../artifacts/artifacts";
import { createDefs } from "../defs/defs";
import { createErrorReporter } from "../errors/reporter";
import { createProjects } from "../projects/projects";
import { createRepos } from "../repos/repos";
import { newId } from "../store/conventions";
import { prChats } from "../store/schema";
import { openStore } from "../store/store";
import { seedPr } from "../testing/pull-requests";
import { createPrChats, type PrChatsDeps } from "./chats";

/** El chat con lo mínimo para `send`: lo que rechaza antes de lanzar un turno no toca agentes ni git. */
function setup(openReason: (scope: string) => string | undefined) {
  const store = openStore({ path: ":memory:" });
  const defs = createDefs({ store });
  const repoId = createRepos({ store }).add({ name: "demo", path: "/no/existe" });
  const prId = seedPr(store, { repoId, number: 1, headRef: "feat", headSha: "abc" });
  const chatId = newId("chat") as ChatId;
  store.tx(({ db }) => db.insert(prChats).values({ id: chatId, prId, status: "active", runtime: "claude-sdk", model: "sonnet" }).run());
  const run = vi.fn();
  const deps: PrChatsDeps = {
    store,
    agents: { run, resume: run },
    runtimes: { get: (id) => ({ id: id ?? "claude-sdk" }) as never, idFor: (id) => id ?? "claude-sdk" },
    scratch: {} as never,
    defs,
    projects: createProjects({ store, defs }),
    breakers: { openReason },
    artifacts: createArtifacts({ store, dir: "/no/existe" }),
    details: { get: vi.fn() },
    repoConfig: () => ({}) as never,
    flows: { start: vi.fn() },
    errors: createErrorReporter({ store }),
  };
  return { chats: createPrChats(deps), store, chatId, run };
}

describe("chats.send", () => {
  test("con el breaker del runtime abierto rechaza el turno y dice qué hacer, sin guardar el mensaje", async () => {
    const { chats, store, chatId, run } = setup((scope) => (scope === "runtime:claude-sdk" ? "Claude no tiene sesión: corre `claude auth login`." : undefined));

    await expect(chats.send({ chatId, text: "hola" }, "ui")).rejects.toThrow(
      "El runtime claude-sdk está en pausa: Claude no tiene sesión: corre `claude auth login`. Cuando se resuelva, vuelve a enviar el mensaje o cambia de runtime.",
    );
    expect(run).not.toHaveBeenCalled();
    expect(store.db.$client.prepare("SELECT count(*) AS n FROM pr_chat_messages").get()).toEqual({ n: 0 });
    await chats.close();
  });

  test("el breaker de otro runtime no frena al elegido", async () => {
    const { chats, chatId } = setup((scope) => (scope === "runtime:claude-sdk" ? "sin sesión" : undefined));

    await expect(chats.send({ chatId, text: "hola", runtime: "opencode", model: "opencode/gpt-5-nano" }, "ui")).resolves.toMatchObject({ runtime: "opencode", busy: true });
    await chats.close();
  });
});

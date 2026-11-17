import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ciFailureReportAction,
  councilThreadsAction,
  prBotThreadsAction,
  createConnections,
  createDefs,
  createFileSecrets,
  createPacks,
  newId,
  openStore,
  OUTPUT_INLINE_MAX_BYTES,
  prCommentAction,
  prReplyAction,
  prResolveThreadAction,
  reviewRequestBotAction,
  type ActionCtx,
  type Connections,
  type Store,
} from "@clanker/core";
import { afterEach, describe, expect, test } from "vitest";
import { tempGitRepo, type TempGitRepo } from "./git";
import { startGitHubSim, type GitHubSim, type SimPr } from "./github-sim";

// Comentar, responder y resolver threads contra el GitHub simulado (`startGitHubSim`): nunca GitHub ni
// tokens reales. El pack de la org decide el prefijo, el bot y a quién se le resuelven los threads.

const TOKEN = "github_pat_UNIQUE-0123456789";
const ACCOUNT = "octocat";
const REPO = "octocat/secret-project";
const BOT = "review-bot[bot]";

const PACK = {
  id: "acme",
  version: 1,
  activate: { githubOrgs: ["octocat"] },
  actors: { ignore: "\\[bot\\]$|^coverage-bot$" },
  reviewBot: {
    logins: [BOT],
    request: { type: "comment", body: "/review" },
    lgtm: { reviewState: "APPROVED" },
    resolvableAuthors: [BOT, "coverage-bot"],
  },
  conventions: { commentPrefix: "[clanker] ", councilPrefix: "[clanker-council] " },
};

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

/** `pack: null` no carga ningún pack: el repo queda con los defaults neutros. */
async function setup({ pack = PACK, draft = true }: { pack?: object | null; draft?: boolean } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "clanker-feedback-"));
  const store: Store = openStore({ path: ":memory:" });
  const repo: TempGitRepo = tempGitRepo({ remote: true, commits: [{ message: "chore: base", files: { "a.txt": "a\n" } }], branches: { feat: [{ message: "feat: algo", files: { "b.txt": "b\n" } }] } });
  const sim: GitHubSim = await startGitHubSim({ origin: repo, repo: REPO, token: TOKEN, bot: BOT });
  const connections: Connections = createConnections({ store, secrets: createFileSecrets({ dir: join(dir, "secrets") }), github: { baseUrl: sim.baseUrl } });
  await connections.connect({ provider: "github", account: ACCOUNT, scopes: [], token: TOKEN }, "core");
  const packs = createPacks({ defs: createDefs({ store }) });
  if (pack) {
    const packDir = join(dir, "pack");
    mkdirSync(packDir);
    writeFileSync(join(packDir, "pack.json"), JSON.stringify(pack));
    await packs.load(packDir);
  }
  cleanups.push(async () => {
    await sim.close();
    repo.cleanup();
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });

  const pauses: number[] = [];
  const deps = { connections, packs, pause: (ms: number) => (pauses.push(ms), Promise.resolve()) };
  const pr = sim.openPr({ head: "feat", draft });
  const ref = { account: ACCOUNT, repo: REPO, number: pr.number };
  return { sim, pr, ref, pauses, deps, botThreads: prBotThreadsAction(deps), councilThreads: councilThreadsAction(deps), comment: prCommentAction(deps), reply: prReplyAction(deps), resolve: prResolveThreadAction(deps), requestBot: reviewRequestBotAction(deps) };
}

/** Un paso del motor: la `key` es la misma en todos los reintentos de una visita, y `once` recuerda las etapas hechas. */
const ctx = (key = "run_1:reply:1"): ActionCtx => {
  const done = new Map<string, unknown>();
  return {
    runId: newId("run"),
    stepId: newId("stp"),
    key,
    signal: new AbortController().signal,
    once: async <T>(stage: string, fn: () => Promise<T>) => {
      if (!done.has(stage)) done.set(stage, await fn());
      return done.get(stage) as T;
    },
  };
};

const conversation = (pr: SimPr) => pr.node().comments.map((c) => c.body);
const threadOf = (pr: SimPr, commentId: number) => pr.node().reviewThreads.find((t) => t.comments.nodes[0]!.fullDatabaseId === String(commentId))!;
const bodies = (pr: SimPr, commentId: number) => threadOf(pr, commentId).comments.nodes.map((c) => c.body);
const graphqlWrites = (sim: GitHubSim) =>
  sim.requests.filter((r) => r.path === "/graphql" && /mutation/.test((r.body as { query: string }).query));

describe("pr.comment", () => {
  test("publica con el prefijo del pack y la marca, con la identidad de la cuenta", async () => {
    const { sim, pr, ref, comment } = await setup();

    const result = await comment.run(comment.args.parse({ pr: ref, body: "Listo para otra pasada" }), ctx());

    expect(result).toEqual({ outcome: "ok", output: { created: true, url: expect.stringContaining(`/pull/${pr.number}#issuecomment-`) } });
    expect(conversation(pr)).toEqual(["[clanker] Listo para otra pasada\n\n<!-- clanker:run_1:reply:1 -->"]);
    for (const request of sim.requests.filter((r) => r.method === "POST")) expect(request.authorization).toBe(`bearer ${TOKEN}`);
  });

  test("re-ejecutar el mismo paso no duplica el comentario, una visita nueva sí comenta", async () => {
    const { pr, ref, comment } = await setup();
    const args = comment.args.parse({ pr: ref, body: "Aplicado" });

    await comment.run(args, ctx("run_1:note:1"));
    const again = await comment.run(args, ctx("run_1:note:1"));
    await comment.run(args, ctx("run_1:note:2"));

    expect(again.output).toMatchObject({ created: false });
    expect(conversation(pr)).toHaveLength(2);
  });

  test("sin pack no pone prefijo, y nunca firma como hecho por una IA", async () => {
    const { pr, ref, comment } = await setup({ pack: null });

    await comment.run(comment.args.parse({ pr: ref, body: "Aplicado\n\nCo-Authored-By: Claude <noreply@anthropic.com>" }), ctx());

    expect(conversation(pr)).toEqual(["Aplicado\n\n<!-- clanker:run_1:reply:1 -->"]);
  });
});

describe("review.requestBot", () => {
  test("sin pack da none y no comenta", async () => {
    const { pr, ref, requestBot } = await setup({ pack: null });

    const result = await requestBot.run(requestBot.args.parse({ pr: ref }), ctx());

    expect(result).toEqual({ outcome: "none" });
    expect(conversation(pr)).toEqual([]);
  });

  test("un pack sin bot también da none", async () => {
    const withoutBot = { ...PACK, reviewBot: undefined };
    const { pr, ref, requestBot } = await setup({ pack: withoutBot });

    expect((await requestBot.run(requestBot.args.parse({ pr: ref }), ctx())).outcome).toBe("none");
    expect(conversation(pr)).toEqual([]);
  });

  test("con bot comenta el comando tal cual, sin prefijo, y da requestedAt con la hora de GitHub", async () => {
    const { pr, ref, requestBot } = await setup();

    const result = await requestBot.run(requestBot.args.parse({ pr: ref }), ctx("run_1:bot-req:1"));

    expect(conversation(pr)).toEqual(["/review"]);
    expect(result).toEqual({ outcome: "ok", output: { requestedAt: Date.parse(pr.node().comments[0]!.createdAt) } });
  });

  test("re-ejecutar el paso no duplica el comando y devuelve el mismo requestedAt", async () => {
    const { pr, ref, requestBot } = await setup();
    const args = requestBot.args.parse({ pr: ref });
    const step = ctx("run_1:bot-req:1");

    const first = await requestBot.run(args, step);
    const again = await requestBot.run(args, step);

    expect(again).toEqual(first);
    expect(conversation(pr)).toHaveLength(1);
  });
});

describe("pr.reply", () => {
  test("sin triage (el flujo llegó tras un CI rojo, sin el del bot) no responde a nadie y vuelve a pedir el bot", async () => {
    const { sim, ref, reply } = await setup();

    const result = await reply.run(reply.args.parse({ pr: ref, triage: null, rerequestBot: true }), ctx("run_1:reply-fixed:1"));

    expect(result.output).toMatchObject({ replied: [], resolved: [], skipped: [], requestedAt: expect.any(Number) });
    expect(sim.pr(1).node().comments.map((c) => c.body.split("\n")[0])).toEqual(["/review"]);
  });

  test("responde con el sha del fixup o con la razón, resuelve los threads del bot y vuelve a pedir el bot", async () => {
    const { sim, pr, ref, reply } = await setup();
    const [fixed, rejected] = pr.botFindings(["Falta validar el monto", "Renombra esto"]);
    const args = reply.args.parse({
      pr: ref,
      triage: {
        items: [
          { id: String(fixed!.commentId), reply: undefined },
          { id: String(rejected!.commentId), reply: "falso positivo, el monto ya se valida en `Transfer`" },
        ],
      },
      shas: { [String(fixed!.commentId)]: "abc1234def5678" },
      rerequestBot: true,
    });

    const result = await reply.run(args, ctx("run_1:reply-fixed:1"));

    expect(bodies(pr, fixed!.commentId)).toEqual([
      "Falta validar el monto",
      `[clanker] aplicado en abc1234\n\n<!-- clanker:run_1:reply-fixed:1:${fixed!.commentId} -->`,
    ]);
    expect(bodies(pr, rejected!.commentId)[1]).toMatch(/^\[clanker\] falso positivo, el monto ya se valida en `Transfer`\n\n<!-- clanker:/);
    expect(pr.node().reviewThreads.map((t) => t.isResolved)).toEqual([true, true]);
    expect(conversation(pr)).toEqual(["/review"]);
    expect(result.output).toEqual({
      replied: [String(fixed!.commentId), String(rejected!.commentId)],
      resolved: [String(fixed!.commentId), String(rejected!.commentId)],
      skipped: [],
      requestedAt: Date.parse(pr.node().comments[0]!.createdAt),
    });
    for (const request of sim.requests.filter((r) => r.method === "POST")) expect(request.authorization).toBe(`bearer ${TOKEN}`);
  });

  test("re-ejecutar no duplica respuestas ni el comando al bot, y retoma la resolución que quedó a medias", async () => {
    const { pr, ref, reply } = await setup();
    const [thread] = pr.botFindings(["Falta validar el monto"]);
    const args = reply.args.parse({ pr: ref, triage: { items: [{ id: String(thread!.commentId), reply: "no aplica" }] }, rerequestBot: true });

    const step = ctx();
    await reply.run(args, step);
    pr.resolve(thread!.id, false);
    await reply.run(args, step);

    expect(bodies(pr, thread!.commentId)).toHaveLength(2);
    expect(conversation(pr)).toHaveLength(1);
    expect(threadOf(pr, thread!.commentId).isResolved).toBe(true);
  });

  test("un segundo entre escrituras", async () => {
    const { pr, ref, reply, pauses } = await setup();
    const threads = pr.botFindings(["uno", "dos"]);
    const items = threads.map((t) => ({ id: String(t.commentId), reply: "no aplica" }));

    await reply.run(reply.args.parse({ pr: ref, triage: { items }, rerequestBot: true }), ctx());

    // responder, resolver, responder, resolver y pedir el bot: cinco escrituras, cuatro esperas.
    expect(pauses).toEqual([1000, 1000, 1000, 1000]);
  });

  test("un ítem que no es un thread (un check de CI) o sin sha ni razón se salta", async () => {
    const { pr, ref, reply } = await setup();
    const [thread] = pr.botFindings(["Falta validar el monto"]);
    const id = String(thread!.commentId);

    const { output } = await reply.run(reply.args.parse({ pr: ref, triage: { items: [{ id: "c1", reply: "flaky" }, { id }] } }), ctx());

    expect(output).toMatchObject({
      replied: [],
      skipped: [
        { id: "c1", reason: "no es un thread del PR" },
        { id, reason: "sin sha del fixup ni razón que decir" },
      ],
    });
    expect(bodies(pr, thread!.commentId)).toHaveLength(1);
  });

  test("nunca resuelve threads humanos: con el PR en draft los responde y quedan abiertos", async () => {
    const { sim, pr, ref, reply } = await setup();
    const human = pr.thread("maria", "¿Esto no debería ir en un job?");

    await reply.run(reply.args.parse({ pr: ref, triage: { items: [{ id: String(human.commentId), reply: "lo movemos en otro pr" }] } }), ctx());

    expect(bodies(pr, human.commentId)).toHaveLength(2);
    expect(threadOf(pr, human.commentId).isResolved).toBe(false);
    expect(graphqlWrites(sim)).toEqual([]);
  });

  test("fuera de draft no responde a humanos", async () => {
    const { sim, pr, ref, reply } = await setup({ draft: false });
    const human = pr.thread("maria", "¿Esto no debería ir en un job?");

    const { output } = await reply.run(reply.args.parse({ pr: ref, triage: { items: [{ id: String(human.commentId), reply: "lo movemos" }] } }), ctx());

    expect(output).toMatchObject({ replied: [], skipped: [{ id: String(human.commentId), reason: expect.stringContaining("humano") }] });
    expect(bodies(pr, human.commentId)).toHaveLength(1);
    expect(sim.requests.filter((r) => r.method === "POST" && r.path !== "/graphql")).toEqual([]);
    expect(graphqlWrites(sim)).toEqual([]);
  });

  test("un thread de council se responde, también fuera de draft, y no se resuelve", async () => {
    const { sim, pr, ref, reply } = await setup({ draft: false });
    const council = pr.councilThread("renombra el método", { by: "simon" });
    const bot = pr.botFindings(["Falta validar el monto"])[0]!;

    await reply.run(
      reply.args.parse({
        pr: ref,
        triage: { items: [{ id: String(council.commentId), reply: "tiene más sentido dejarlo" }, { id: String(bot.commentId), reply: "no aplica" }] },
      }),
      ctx(),
    );

    expect(bodies(pr, council.commentId)[1]).toMatch(/^\[clanker\] tiene más sentido dejarlo/);
    expect(threadOf(pr, council.commentId).isResolved).toBe(false);
    expect(threadOf(pr, bot.commentId).isResolved).toBe(true);
    expect(graphqlWrites(sim)).toHaveLength(1);
  });

  test("la razón de un ítem rechazado gana al sha que pushFixups le dio, y un council ya respondido no se responde otra vez", async () => {
    const { pr, ref, reply } = await setup({ draft: false });
    const rejected = pr.councilThread("renombra el método");
    const applied = pr.councilThread("agrega un test");
    const answered = pr.councilThread("mueve esto");
    pr.reply(answered.id, ACCOUNT, "[clanker] aplicado en abc1234");
    const items = [rejected, applied, answered].map((t) => ({ id: String(t.commentId) }));
    const shas = Object.fromEntries(items.map(({ id }) => [id, "f".repeat(40)]));

    const { output } = await reply.run(
      reply.args.parse({ pr: ref, triage: { items }, shas, rejected: [{ id: String(rejected.commentId), reason: "ya lo cubre otro test" }] }),
      ctx(),
    );

    expect(bodies(pr, rejected.commentId)[1]).toMatch(/^\[clanker\] ya lo cubre otro test/);
    expect(bodies(pr, applied.commentId)[1]).toMatch(/^\[clanker\] aplicado en fffffff/);
    expect(bodies(pr, answered.commentId)).toHaveLength(2);
    expect(output).toMatchObject({ replied: [String(rejected.commentId), String(applied.commentId)], skipped: [{ id: String(answered.commentId), reason: expect.stringContaining("ya tiene una respuesta") }] });
    expect([rejected, applied].map((t) => threadOf(pr, t.commentId).isResolved)).toEqual([false, false]);
  });

  test("solo resuelve a los autores resolubles del pack: coverage-bot sí, un bot que el pack no lista no", async () => {
    const { pr, ref, reply } = await setup({ pack: { ...PACK, reviewBot: { ...PACK.reviewBot, resolvableAuthors: ["coverage-bot"] } } });
    const ci = pr.thread("coverage-bot", "Cobertura baja en `Transfer`");
    const bot = pr.botFindings(["Falta validar el monto"])[0]!;
    const items = [ci, bot].map((t) => ({ id: String(t.commentId), reply: "no aplica" }));

    await reply.run(reply.args.parse({ pr: ref, triage: { items } }), ctx());

    expect(threadOf(pr, ci.commentId).isResolved).toBe(true);
    expect(threadOf(pr, bot.commentId).isResolved).toBe(false);
    expect(bodies(pr, bot.commentId)).toHaveLength(2);
  });

  test("sin pack responde sin prefijo y no resuelve nada, ni al bot", async () => {
    const { sim, pr, ref, reply } = await setup({ pack: null });
    const bot = pr.botFindings(["Falta validar el monto"])[0]!;

    await reply.run(reply.args.parse({ pr: ref, triage: { items: [{ id: String(bot.commentId), reply: "no aplica" }] }, rerequestBot: true }), ctx());

    expect(bodies(pr, bot.commentId)[1]).toMatch(/^no aplica\n\n<!-- clanker:/);
    expect(graphqlWrites(sim)).toEqual([]);
    expect(conversation(pr)).toEqual([]);
  });

  test("lo que dice el agente no puede firmar como hecho por una IA", async () => {
    const { pr, ref, reply } = await setup();
    const bot = pr.botFindings(["Falta validar el monto"])[0]!;
    const text = "no aplica\nGenerated with Claude Code\nCo-Authored-By: Claude <noreply@anthropic.com>";

    await reply.run(reply.args.parse({ pr: ref, triage: { items: [{ id: String(bot.commentId), reply: text }] } }), ctx());

    expect(bodies(pr, bot.commentId)[1]).not.toMatch(/claude|anthropic/i);
  });
});

describe("pr.resolveThread", () => {
  test("resuelve el thread de un autor resoluble del pack", async () => {
    const { pr, ref, resolve } = await setup();
    const bot = pr.botFindings(["Falta validar el monto"])[0]!;

    const result = await resolve.run(resolve.args.parse({ pr: ref, thread: bot.commentId }), ctx());

    expect(result.outcome).toBe("ok");
    expect(threadOf(pr, bot.commentId).isResolved).toBe(true);
  });

  test("nunca resuelve threads humanos ni de council", async () => {
    const { sim, pr, ref, resolve } = await setup();
    const human = pr.thread("maria", "Esto no me convence");
    const council = pr.councilThread("renombra el método");
    // Aunque el autor del thread sea resoluble, un thread de council no se resuelve.
    const councilByBot = pr.councilThread("otro", { by: BOT });

    const results = [];
    for (const thread of [human, council, councilByBot]) {
      results.push(await resolve.run(resolve.args.parse({ pr: ref, thread: String(thread.commentId) }), ctx()));
    }

    expect(results.map((r) => r.outcome)).toEqual(["refused", "refused", "refused"]);
    expect(results[0]!.output).toEqual({ reason: "El thread es de human: el core no lo resuelve." });
    expect(pr.node().reviewThreads.map((t) => t.isResolved)).toEqual([false, false, false]);
    expect(graphqlWrites(sim)).toEqual([]);
  });

  test("un thread que no existe se rechaza", async () => {
    const { ref, resolve } = await setup();

    const result = await resolve.run(resolve.args.parse({ pr: ref, thread: "999999" }), ctx());

    expect(result.outcome).toBe("refused");
  });
});

describe("ci.failureReport", () => {
  const RULES = { failureReport: [{ match: "circleci run get ([0-9a-f-]+)", command: "circleci run get $1 --failure-report" }] };
  const failure = (description?: string) => ({ id: "ci:tests", kind: "ci", text: "El check tests falló en abc1234.", ...(description && { description }) });

  test("con una regla del pack que calza corre su comando con el grupo entre comillas y suma el final del reporte", async () => {
    const commands: string[] = [];
    const { ref, deps } = await setup({ pack: { ...PACK, ciRules: RULES } });
    const report = ciFailureReportAction({ ...deps, runReport: (command) => (commands.push(command), Promise.resolve(`inicio\n${"x".repeat(40_000)}\nrspec ./spec/a_spec.rb:3`)) });

    const result = await report.run(report.args.parse({ pr: ref, failures: [failure("Job failed. run the CircleCI CLI: circleci run get 554de8da-4d40 --failure-report")] }), ctx());

    expect(commands).toEqual(["circleci run get '554de8da-4d40' --failure-report"]);
    const [item] = (result.output as { items: { id: string; text: string }[] }).items;
    expect(item?.id).toBe("ci:tests");
    expect(item?.text).toContain("rspec ./spec/a_spec.rb:3");
    expect(item?.text).toContain("solo el final");
    expect(item?.text).not.toContain("inicio");
  });

  test("los reportes largos se recortan entre todos para que la lista quepa en el brief del triage (caso BA-9227)", async () => {
    const { ref, deps } = await setup({ pack: { ...PACK, ciRules: RULES } });
    // Un log real: muchas líneas cortas (cada salto pesa 2 bytes en el JSON) y algo que no es ASCII.
    const log = (name: string) => `${"0.3 seconds average ./spec/ñandú_spec.rb:4\n".repeat(800)}Failed examples:\nrspec ./spec/${name}_spec.rb:173`;
    const report = ciFailureReportAction({ ...deps, runReport: (command) => Promise.resolve(log(command.includes("'aaa'") ? "a" : "b")) });

    const result = await report.run(
      report.args.parse({ pr: ref, failures: [failure("circleci run get aaa --failure-report"), { ...failure("circleci run get bbb --failure-report"), id: "ci:lint" }] }),
      ctx(),
    );

    const items = (result.output as { items: { id: string; text: string }[] }).items;
    expect(Buffer.byteLength(JSON.stringify(result.output))).toBeLessThanOrEqual(OUTPUT_INLINE_MAX_BYTES);
    expect(items.map((i) => i.id)).toEqual(["ci:tests", "ci:lint"]);
    expect(items[0]?.text).toContain("rspec ./spec/a_spec.rb:173");
    expect(items[1]?.text).toContain("rspec ./spec/b_spec.rb:173");
    expect(items[0]?.text).toContain("solo el final");
  });

  test("sin regla que calce el ítem sigue igual, y si el comando falla queda con una nota", async () => {
    const { ref, deps } = await setup({ pack: { ...PACK, ciRules: RULES } });
    const report = ciFailureReportAction({ ...deps, runReport: () => Promise.reject(new Error("circleci: not logged in")) });

    const result = await report.run(report.args.parse({ pr: ref, failures: [failure("Build failed"), failure("circleci run get abc --failure-report")] }), ctx());

    const [plain, failed] = (result.output as { items: { text: string }[] }).items;
    expect(plain?.text).toBe("El check tests falló en abc1234.");
    expect(failed?.text).toContain("No se pudo traer el detalle con `circleci run get 'abc' --failure-report`: circleci: not logged in");
  });
});

describe("pr.botThreads", () => {
  test("da los threads abiertos de los bots resolubles que no son el de review, con su texto sin marcas HTML", async () => {
    const { pr, ref, botThreads } = await setup();
    const coverage = pr.thread("coverage-bot", "<sub>reported by reviewdog</sub><br>Not covered lines: 17\n<!-- __reviewdog__:abc -->", { path: "b.txt", line: 1 });
    pr.botFindings(["Falta validar el monto"]);
    pr.thread("ana", "un humano pide algo");

    const result = await botThreads.run(botThreads.args.parse({ pr: ref }), ctx());

    expect(result).toEqual({
      outcome: "ok",
      output: { items: [{ id: String(coverage.commentId), kind: "bot", path: "b.txt", line: 1, text: "reported by reviewdog\nNot covered lines: 17" }] },
    });
  });

  test("no cuenta lo resuelto ni lo respondido con [clanker]; sin bots resolubles aparte del de review es none", async () => {
    const { pr, ref, botThreads } = await setup();
    pr.thread("coverage-bot", "ya resuelto", { resolved: true });
    const answered = pr.thread("coverage-bot", "ya respondido");
    pr.reply(answered.id, ACCOUNT, "[clanker] no aplica");
    expect(await botThreads.run(botThreads.args.parse({ pr: ref }), ctx())).toEqual({ outcome: "none" });

    const onlyReviewBot = await setup({ pack: { ...PACK, reviewBot: { ...PACK.reviewBot, resolvableAuthors: [BOT] } } });
    onlyReviewBot.pr.thread("coverage-bot", "Cobertura baja");
    expect(await onlyReviewBot.botThreads.run(onlyReviewBot.botThreads.args.parse({ pr: onlyReviewBot.ref }), ctx())).toEqual({ outcome: "none" });
  });
});

describe("council.threads", () => {
  test("da los threads de council abiertos con su ruta, línea y texto sin el prefijo, en el orden del PR", async () => {
    const { pr, ref, councilThreads } = await setup({ draft: false });
    const first = pr.councilThread("renombra el método", { path: "b.txt", line: 1 });
    const second = pr.councilThread("  agrega un test\n", { path: "a.txt", line: 3 });

    const result = await councilThreads.run(councilThreads.args.parse({ pr: ref }), ctx());

    expect(result).toEqual({
      outcome: "ok",
      output: {
        items: [
          { id: String(first.commentId), path: "b.txt", line: 1, change: "renombra el método" },
          { id: String(second.commentId), path: "a.txt", line: 3, change: "agrega un test" },
        ],
      },
    });
  });

  test("no cuenta lo resuelto, lo respondido con [clanker], ni lo que no es de council: sin threads es none", async () => {
    const { pr, ref, councilThreads } = await setup();
    pr.resolve(pr.councilThread("ya resuelto").id);
    const answered = pr.councilThread("ya respondido");
    pr.reply(answered.id, ACCOUNT, "[clanker] no aplica");
    pr.botFindings(["Falta validar el monto"]);
    pr.thread("ana", "un humano pide algo");

    expect(await councilThreads.run(councilThreads.args.parse({ pr: ref }), ctx())).toEqual({ outcome: "none" });
  });

  test("un PR que ya no está abierto no tiene nada que atender", async () => {
    const { pr, ref, councilThreads } = await setup();
    pr.councilThread("renombra el método");
    pr.merge();

    expect(await councilThreads.run(councilThreads.args.parse({ pr: ref }), ctx())).toEqual({ outcome: "none" });
  });
});

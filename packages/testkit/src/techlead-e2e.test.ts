import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, onTestFinished, test, vi } from "vitest";
import { REPO, startTechleadScenario, TOKEN, type TechleadScenario } from "./techlead-scenario";

// Criterio de la fase 1 sin gastar tokens: una issue del tracker local corre `de-issue-a-pr` en el core
// real (`startCore`) con el runtime fake hasta un PR draft con LGTM del bot, sin ningún LLM orquestador.

vi.setConfig({ testTimeout: 60_000 });

let scenario: TechleadScenario | undefined;
afterEach(async () => {
  await scenario?.cleanup();
  scenario = undefined;
});

describe("de-issue-a-pr de punta a punta", () => {
  test.each(["local", "linear"] as const)("una issue del tracker %s termina en done con el PR draft, sin fixup! en el remoto y con una respuesta [clanker] por hallazgo", async (tracker) => {
    scenario = await startTechleadScenario({ tracker });
    const { client, store } = scenario;

    const { issueId, run: started } = await scenario.run();
    const run = await scenario.finished(started.id);

    expect(run).toMatchObject({ status: "done", outcome: "done", flow: { slug: "de-issue-a-pr" } });
    const nodes = run.steps.filter((s) => !/^(rv|lr)-/.test(s.nodeId)).map((s) => [s.nodeId, s.outcome]);
    expect(nodes).toEqual([
      ["ws", "ok"],
      ["plan", "ok"],
      ["plan-check", "skipped"],
      ["implement", "ok"],
      ["checks", "fail"],
      ["fix", "ok"],
      ["checks", "ok"],
      ["reviews", "changes"],
      ["fix", "ok"],
      ["checks", "ok"],
      ["reviews", "ok"],
      ["sync", "same"],
      ["commit", "ok"],
      ["publish", "ok"],
      ["feedback", "done"],
    ]);

    // El PR draft con los dos commits del committer; el fixup del hallazgo del bot ya quedó squasheado.
    const pr = scenario.pr();
    const [pull] = scenario.github.pulls();
    expect(pull).toMatchObject({ number: 1, draft: true, state: "open", title: `[${(await client.issues.get({ id: issueId })).ref.key}] feat(transfers): validate and round the transfer amount` });
    const log = scenario.remoteLog(pull!.head.ref);
    expect(log.map((c) => c.subject).reverse()).toEqual([
      "feat(transfers): validate and round the transfer amount",
      "test(transfers): log a created transfer",
    ]);
    expect(scenario.repo.git("--git-dir", scenario.repo.remoteDir!, "show", `${pull!.head.ref}:src/transfer.ts`)).toContain("got ${amount}");
    expect(pr.headSha()).toBe(log[0]!.sha);

    // Watch corre con el core real: el PR que se publicó entra al caché con su detalle (el head puede ir
    // atrás de un force push reciente: el siguiente sondeo lo alcanza).
    await vi.waitFor(async () => {
      const [cached] = await client.prs.list({});
      expect(cached).toMatchObject({ owned: true, state: { state: "draft" } });
    }, { timeout: 15_000, interval: 250 });

    // El hallazgo se respondió una vez, con el sha del commit que quedó pusheado, y se resolvió.
    const [thread] = pr.node().reviewThreads;
    const bodies = thread!.comments.nodes.map((c) => c.body.split("\n")[0]);
    expect(bodies).toEqual(["Falta incluir el monto en el mensaje del error", `[clanker] aplicado en ${log.at(-1)!.sha.slice(0, 7)}`]);
    expect(thread!.isResolved).toBe(true);
    expect(pr.node().comments.map((c) => c.body.split("\n")[0])).toEqual(["/review", "/review"]);
    expect(pr.node().reviews.map((r) => r.state)).toEqual(["COMMENTED", "APPROVED"]);

    // El push salió por git con el token del PAT entregado por askpass: nunca en el entorno de git.
    expect(scenario.gitAuthorizations.length).toBeGreaterThan(0);
    expect(new Set(scenario.gitAuthorizations)).toEqual(new Set([`Basic ${Buffer.from(`acme:${TOKEN}`).toString("base64")}`]));

    // `runs.get` muestra el costo por paso: cada agente suma el suyo y la corrida el total.
    const costs = Object.fromEntries(run.steps.filter((s) => s.costMicros > 0).map((s) => [s.nodeId, s.costMicros]));
    expect(costs).toMatchObject({ plan: 31_000, implement: 82_000, commit: 27_000, "rv-bugs": expect.any(Number) });
    expect(run.costMicros).toBeGreaterThan(0);
    expect(run.steps.reduce((sum, s) => sum + s.costMicros, 0)).toBe(run.costMicros);

    // Cada paso agent recibió su `.clanker-run/`; la segunda vuelta de un nodo parte de lo que él vio antes (`diff-round.patch`).
    const { path } = store.db.$client.prepare("SELECT path FROM workspaces").get() as { path: string };
    expect(readdirSync(join(path, ".clanker-run")).sort()).toEqual(expect.arrayContaining(["diff.patch", "hunks.json", "issue.md"]));
    expect(readFileSync(join(path, ".clanker-run/issue.md"), "utf8")).toContain("Validar el monto de una transfer");
    const roles = store.db.$client.prepare("SELECT role FROM artifact_refs WHERE owner_id = ?").all(run.id) as { role: string }[];
    expect(roles.map((r) => r.role)).toEqual(expect.arrayContaining(["r0/diff-round.patch", "snapshot/rv-bugs/1/1", "snapshot/rv-bugs/2/1"]));

    // Al terminar la corrida el worktree queda suelto, no con el lease de una corrida que ya no existe.
    const released = store.events.since(0, { runId: run.id, types: ["lease.released"] }).map((e) => (e.payload as { resource: string }).resource);
    expect(released.filter((resource) => resource === "workspace")).toHaveLength(1);
    expect(store.db.$client.prepare("SELECT state, holder_run_id AS holder FROM workspaces").all()).toEqual([{ state: "idle", holder: null }]);

    // La issue salió de la cola y no vuelve: reclamada, nunca otra vez `todo`.
    expect(await client.issues.get({ id: issueId })).toMatchObject({ status: "in_progress" });
    expect((await client.issues.list({ projectId: scenario.project.id })).filter((i) => i.status === "todo")).toEqual([]);
    // El repo temporal no tiene AGENTS.md ni paquetes de contexto: los roles avisan y corren igual. Nada más falló.
    expect(store.events.since(0, { types: ["error"] }).filter((e) => e.payload.scope !== "agent.context")).toEqual([]);
    if (scenario.linear) {
      // El adapter de Linear reclamó la issue en el Linear falso: asignada a quien autorizó el token y en curso.
      const [stored] = await scenario.linear.workspace.execute("{ issues { nodes { identifier state { name } assignee { id } } } }").then((r) => (r.data as { issues: { nodes: { state: { name: string }; assignee: { id: string } }[] } }).issues.nodes);
      expect(stored).toMatchObject({ state: { name: "In Progress" }, assignee: { id: scenario.linear.workspace.viewer.id } });
    }
  });
});

describe("pr-feedback con el core real", () => {
  test("sin LGTM tras las rondas externas responde al bot, sigue al CI con una nota y no deja fixup! en el remoto", async () => {
    scenario = await startTechleadScenario({ bot: [{ findings: ["Falta incluir el monto en el mensaje del error"] }, { findings: ["Falta un test del monto negativo"] }] });
    const { store } = scenario;

    const { run: started } = await scenario.run({ externalRounds: 1 });
    const run = await scenario.finished(started.id);

    expect(run).toMatchObject({ status: "done", outcome: "done" });
    const feedback = await scenario.feedback(started.id);
    expect(feedback).toMatchObject({ status: "done", outcome: "done", rounds: { external: 1 } });
    expect(feedback.steps.filter((s) => !s.nodeId.startsWith("lr-")).map((s) => [s.nodeId, s.outcome])).toEqual([
      ["bot-req", "ok"],
      ["bot-wait", "findings"],
      ["triage", "fix"],
      ["fix", "ok"],
      ["checks", "ok"],
      ["light", "ok"],
      ["fixups", "ok"],
      ["reply-fixed", "ok"],
      ["bot-wait", "findings"],
      ["triage", "fix"],
      ["reply", "ok"],
      ["ci-wait", "ok"],
      ["ci-bots", "none"],
    ]);
    const notes = store.events.since(0, { types: ["decision.opened"], runId: feedback.id }).map((e) => (e.payload as { title: string }).title);
    expect(notes).toEqual(["Sin LGTM tras las rondas externas"]);

    // El primer hallazgo se respondió con el sha del fixup ya squasheado y se resolvió; el segundo sigue abierto
    // porque la ronda se agotó sin un arreglo que citar.
    const [first, second] = scenario.pr().node().reviewThreads;
    expect(first!.comments.nodes.map((c) => c.body.split("\n")[0])).toEqual(["Falta incluir el monto en el mensaje del error", expect.stringMatching(/^\[clanker\] aplicado en [0-9a-f]{7}$/)]);
    expect(first!.isResolved).toBe(true);
    expect(second!.comments.nodes).toHaveLength(1);
    expect(second!.isResolved).toBe(false);
    expect(scenario.remoteLog(scenario.github.pulls()[0]!.head.ref).map((c) => c.subject)).not.toContainEqual(expect.stringMatching(/^fixup!/));
  });
});

describe("council con el core real", () => {
  test("dos threads, uno aplicado y uno rechazado: fixup! visibles en el remoto, sin force push, respondidos con [clanker] y sin resolver", async () => {
    scenario = await startTechleadScenario();
    const { store, github, project } = scenario;
    const { run: started } = await scenario.run();
    await scenario.finished(started.id);

    // Dos comentarios del council sobre el PR que abrió la corrida.
    const pr = scenario.pr();
    const [pull] = github.pulls();
    const branch = pull!.head.ref;
    const before = scenario.remoteLog(branch);
    const applied = pr.councilThread("rechaza también los montos no finitos", { path: "src/transfer.ts", line: 2 });
    const rejected = pr.councilThread("usa un framework de test", { path: "src/transfer.test.ts", line: 3 });

    // Lo que Watch emite al ver un thread de council (watch.test.ts lo prueba con sondeos): `startTriggers` arranca el flujo.
    const row = store.db.$client.prepare("SELECT id FROM pull_requests WHERE number = 1").get() as { id: string };
    store.tx((tx) =>
      tx.emit({
        type: "pr.comment",
        origin: "watch",
        projectId: project.id,
        subject: { type: "pr", id: row.id },
        payload: { repo: REPO, number: 1, threadIds: [applied.commentId, rejected.commentId], base: "main" },
      }),
    );
    // El CI de la punta nueva (el fixup) termina verde apenas se pushea, como el de cualquier push.
    const green = setInterval(() => {
      if (pr.headSha() !== before[0]!.sha) {
        clearInterval(green);
        pr.ci("green");
      }
    }, 20);
    onTestFinished(() => clearInterval(green));

    const council = await vi.waitFor(
      async () => {
        const runs = (await scenario!.client.runs.list({ projectId: project.id })).filter((r) => r.flow.slug === "council");
        expect(runs).toHaveLength(1);
        const detail = await scenario!.client.runs.get({ id: runs[0]!.id });
        expect(detail.status).toBe("done");
        return detail;
      },
      { timeout: 40_000, interval: 100 },
    );

    expect(council).toMatchObject({ outcome: "done", lane: "maintenance" });
    expect(council.steps.filter((s) => !/^lr-/.test(s.nodeId)).map((s) => [s.nodeId, s.outcome])).toEqual([
      ["ws", "ok"],
      ["threads", "ok"],
      ["work", "ok"],
      ["checks", "ok"],
      ["light", "ok"],
      ["fixups", "ok"],
      ["reply", "ok"],
      ["ci-wait", "ok"],
    ]);

    // El remoto solo avanzó: los commits de antes siguen en su lugar y el arreglo es un `fixup!` visible, sin autosquash.
    const after = scenario.remoteLog(branch);
    expect(after.map((c) => c.subject).reverse()).toEqual([
      ...before.map((c) => c.subject).reverse(),
      "fixup! feat(transfers): validate and round the transfer amount",
    ]);
    expect(after.slice(1)).toEqual(before);
    scenario.repo.git("--git-dir", scenario.repo.remoteDir!, "merge-base", "--is-ancestor", before[0]!.sha, after[0]!.sha);

    // Cada thread quedó respondido una vez, el aplicado con el sha del fixup y el rechazado con la razón, y ninguno se resolvió.
    const bodies = (id: number) => pr.node().reviewThreads.find((t) => t.comments.nodes[0]!.fullDatabaseId === String(id))!;
    expect(bodies(applied.commentId).comments.nodes.map((c) => c.body.split("\n")[0])).toEqual([
      "[clanker-council] rechaza también los montos no finitos",
      `[clanker] aplicado en ${after[0]!.sha.slice(0, 7)}`,
    ]);
    expect(bodies(rejected.commentId).comments.nodes.map((c) => c.body.split("\n")[0])).toEqual([
      "[clanker-council] usa un framework de test",
      "[clanker] el repo no tiene un framework de test: transfer.test.ts es un script, no un spec",
    ]);
    expect([applied, rejected].map((t) => bodies(t.commentId).isResolved)).toEqual([false, false]);
    expect(scenario.repo.git("--git-dir", scenario.repo.remoteDir!, "show", `${branch}:src/transfer.ts`)).toContain("Number.isFinite");
    // Sin bot: el flujo no le pidió ninguna review (las dos de `/review` son de la corrida de la issue).
    expect(pr.node().comments.map((c) => c.body.split("\n")[0])).toEqual(["/review", "/review"]);
    expect(store.events.since(0, { types: ["error"] }).filter((e) => e.payload.scope !== "agent.context")).toEqual([]);
  });
});

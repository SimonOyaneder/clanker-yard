import { describe, expect, test } from "vitest";
import { PackSettings, type ResolvedPack } from "@clanker/api";
import { buildPrState, EXCERPT_MAX_CHARS } from "./pr-state";
import type { PrNode } from "./pr-query";
import { bot, checkRun, comment, HEAD_SHA, OLD_SHA, prNode, review, statusContext, thread, user } from "./pr-fixtures";

const VIEWER = "simon";

/** El pack de ejemplo de `docs/design.html#d-ops`, solo con lo que el PrState lee. */
const acme: ResolvedPack = {
  id: "acme",
  ...PackSettings.parse({
    actors: {
      ignore: "\\[bot\\]$|^(coverage-bot|linear-code|release-bot|merge-queue|deploy-bot|github-actions|review-bot|codecov|dependabot)$",
      silentReviewBody: "^\\s*(lgtm|looks good to me|:shipit:|👍|✅|🚀)[\\s!.]*$",
    },
    signals: [
      {
        id: "risk",
        source: "label",
        match: "^risk[:/ _-]?(high|mid|medium|low)$",
        flags: "i",
        alias: { medium: "mid" },
        levels: {
          high: { label: "Riesgo alto", tone: "bad", hint: "Label risk:high" },
          mid: { label: "Riesgo medio", tone: "warn", hint: "Label risk:mid" },
          low: { label: "Riesgo bajo", tone: "ok", hint: "Label risk:low" },
        },
      },
    ],
    reviewBot: {
      logins: ["review-bot", "review-bot[bot]"],
      request: { type: "comment", body: "/review" },
      lgtm: { reviewState: "APPROVED", bodyMatch: "LGTM", sameSha: true },
    },
    ciRules: { ignoreChecks: ["merge-queue"], okStates: ["SUCCESS", "SKIPPED", "NEUTRAL"] },
    conventions: { commentPrefix: "[clanker] ", councilPrefix: "[clanker-council] " },
    mergeStrategy: {
      type: "comment",
      command: "/merge",
      queueCheck: "merge-queue",
      ready: ["notDraft", "approved", "ciGreen", "baseIsDefault", "noConflict", "noHumanOpenThreads", "notQueued"],
      offer: ["ready", "humanApprover", "noHumanTalk", "noCouncilOpen", "notHold"],
      auto: ["offer", "noHumanResolvedThreads", "noCouncilEver"],
      onOffer: "gate",
      onAuto: "act",
    },
  }),
};
const noPack: ResolvedPack = { id: null, ...PackSettings.parse({}) };

const build = (node: PrNode, pack = acme, more: { hold?: boolean; mergeApplies?: boolean } = {}) => buildPrState(node, { pack, viewer: VIEWER, ...more });

describe("el PR", () => {
  test("lo básico: clave, ramas, head y decisión de GitHub", () => {
    const state = build(prNode({ reviewDecision: "CHANGES_REQUESTED", baseRefName: "feat/padre", mergeCommit: { oid: "c".repeat(40) } }));

    expect(state).toMatchObject({
      key: "api#4251",
      state: "open",
      headRef: "feat/x",
      headSha: HEAD_SHA,
      baseRef: "feat/padre",
      baseIsDefault: false,
      reviewDecision: "changes_requested",
      mergeCommitSha: "c".repeat(40),
    });
    expect(build(prNode()).reviewDecision).toBe("none");
    expect(build(prNode()).baseIsDefault).toBe(true);
    expect("mergeCommitSha" in build(prNode())).toBe(false);
  });

  test.each([
    [{ isDraft: true }, "draft"],
    [{ state: "MERGED" as const }, "merged"],
    [{ state: "CLOSED" as const, isDraft: true }, "closed"],
  ])("estado %j es %s", (overrides, expected) => {
    expect(build(prNode(overrides)).state).toBe(expected);
  });

  test.each([
    [{ mergeable: "CONFLICTING" as const, mergeStateStatus: "DIRTY" as const }, "conflict"],
    [{ mergeable: "UNKNOWN" as const, mergeStateStatus: "UNKNOWN" as const }, "unknown"],
    [{ mergeable: "MERGEABLE" as const, mergeStateStatus: "BEHIND" as const }, "behind"],
    [{ mergeable: "MERGEABLE" as const, mergeStateStatus: "BLOCKED" as const }, "clean"],
    [{ mergeable: "MERGEABLE" as const, mergeStateStatus: "UNSTABLE" as const }, "clean"],
  ])("mergeable %j es %s", (overrides, expected) => {
    expect(build(prNode(overrides)).mergeable).toBe(expected);
  });
});

describe("bot de review", () => {
  const lgtm = (over: Parameters<typeof review>[2] = {}) => review(bot("review-bot[bot]"), "APPROVED", { body: "LGTM, nada que objetar", ...over });

  test("LGTM: APPROVED con LGTM en el body sobre el head actual", () => {
    const approved = lgtm();

    expect(build(prNode({ reviews: [approved] })).bot).toEqual({
      state: "lgtm",
      sha: HEAD_SHA,
      reviewId: Number(approved.fullDatabaseId),
      at: "2026-11-10T10:00:00Z",
      findings: [],
    });
  });

  test("un LGTM de un commit anterior no vale para el head: es como si el bot no hubiera revisado", () => {
    expect(build(prNode({ reviews: [lgtm({ sha: OLD_SHA })] })).bot).toEqual({ state: "none", findings: [] });
  });

  test("sin sameSha en el pack, el LGTM de otro commit sí vale", () => {
    const pack: ResolvedPack = {
      ...acme,
      reviewBot: { ...acme.reviewBot!, lgtm: { reviewState: "APPROVED", bodyMatch: "LGTM" } },
    };

    expect(build(prNode({ reviews: [lgtm({ sha: OLD_SHA })] }), pack).bot).toMatchObject({ state: "lgtm", sha: OLD_SHA });
  });

  test("hallazgos: una review del bot que no cumple la regla (aprobada sin LGTM, comentada o con cambios)", () => {
    const withFindings = [
      review(bot("review-bot[bot]"), "APPROVED", { body: "Approved, pero mira el thread de abajo" }),
      review(bot("review-bot"), "COMMENTED", { body: "LGTM" }),
      review(bot("review-bot[bot]"), "CHANGES_REQUESTED", { body: "LGTM salvo esto" }),
    ];

    for (const r of withFindings) {
      expect(build(prNode({ reviews: [r] })).bot).toMatchObject({ state: "findings", sha: HEAD_SHA, reviewId: Number(r.fullDatabaseId), at: "2026-11-10T10:00:00Z" });
    }
  });

  test("los hallazgos son los threads del bot sin resolver, con su lugar y su texto", () => {
    const [open, resolved, human] = [
      thread(bot("review-bot[bot]"), "Falta validar el monto"),
      thread(bot("review-bot[bot]"), "Ya corregido", { resolved: true }),
      thread(user("ana"), "otra cosa"),
    ];
    open.comments.nodes[0] = { ...open.comments.nodes[0]!, path: "app/models/transfer.rb", line: 42 };
    const r = review(bot("review-bot[bot]"), "COMMENTED", { body: "Ver threads" });

    expect(build(prNode({ reviews: [r], reviewThreads: [open, resolved, human] })).bot.findings).toEqual([
      { id: open.comments.nodes[0]!.fullDatabaseId, path: "app/models/transfer.rb", line: 42, text: "Falta validar el monto" },
    ]);
  });

  test("una review del bot sin threads abiertos es ella misma el hallazgo", () => {
    const withBody = review(bot("review-bot[bot]"), "CHANGES_REQUESTED", { body: "  Falta el test  " });
    const empty = review(bot("review-bot[bot]"), "COMMENTED");

    expect(build(prNode({ reviews: [withBody] })).bot.findings).toEqual([{ id: `review-${withBody.fullDatabaseId}`, text: "Falta el test" }]);
    expect(build(prNode({ reviews: [empty] })).bot.findings).toEqual([{ id: `review-${empty.fullDatabaseId}`, text: "El bot no aprobó y no dejó comentarios." }]);
  });

  test("gana la review más reciente; las descartadas y las sin enviar no cuentan", () => {
    const state = build(
      prNode({
        reviews: [
          review(bot("review-bot[bot]"), "CHANGES_REQUESTED", { body: "falta algo", at: "2026-11-10T09:00:00Z" }),
          lgtm({ at: "2026-11-10T10:00:00Z" }),
          review(bot("review-bot[bot]"), "DISMISSED", { body: "LGTM", at: "2026-11-10T11:00:00Z" }),
          review(bot("review-bot[bot]"), "PENDING", { body: "borrador", at: "2026-11-10T12:00:00Z" }),
        ],
      }),
    );

    expect(state.bot.state).toBe("lgtm");
  });

  test("sin reviews del bot, o sin bot en el pack (aunque alguien escriba LGTM), es none", () => {
    expect(build(prNode()).bot).toEqual({ state: "none", findings: [] });
    expect(build(prNode({ reviews: [review(user("ana"), "APPROVED", { body: "LGTM" })] })).bot).toEqual({ state: "none", findings: [] });
    expect(build(prNode({ reviews: [lgtm()] }), noPack).bot).toEqual({ state: "none", findings: [] });
  });
});

describe("threads", () => {
  test("humano abierto, humano resuelto y del bot abierto, cada uno por quien abrió el thread", () => {
    const state = build(
      prNode({
        reviewThreads: [
          thread(user("ana"), "esto falta"),
          thread(user("ana"), "otro"),
          thread(user("beto"), "ya arreglado", { resolved: true }),
          thread(bot("review-bot[bot]"), "🟡 posible N+1"),
          thread(bot("review-bot[bot]"), "ya resuelto", { resolved: true }),
          thread(bot("github-actions[bot]"), "no es el bot de review"),
          thread(null, "cuenta borrada"),
          thread(user(VIEWER), "nota mía sin prefijo"),
        ],
      }),
    );

    // `unresolved` cuenta todo thread abierto, también el de un bot que no es el de review, el de una cuenta borrada y el del usuario.
    expect(state.threads).toEqual({ unresolved: 6, humanOpen: 2, humanResolved: 1, botOpen: 1, councilOpen: [], councilEver: false });
  });

  test("council abierto: el id de su primer comentario, y no cuenta como humano aunque lo escriba el usuario", () => {
    const open = thread(user(VIEWER), "[clanker-council] 🟡 falta un test");
    const state = build(prNode({ reviewThreads: [open, thread(user(VIEWER), "[clanker-council] ya aplicado", { resolved: true })] }));

    expect(state.threads).toEqual({
      unresolved: 1,
      humanOpen: 0,
      humanResolved: 0,
      botOpen: 0,
      councilOpen: [Number(open.comments.nodes[0]!.fullDatabaseId)],
      councilEver: true,
    });
  });

  test("council respondido con el prefijo del pack: ya no está abierto aunque nadie lo resuelva", () => {
    const answered = thread(user(VIEWER), "[clanker-council] 🟡 falta un test", { replies: [[user(VIEWER), "[clanker] aplicado en abc123"]] });
    const unanswered = thread(user(VIEWER), "[clanker-council] 🟡 otro", { replies: [[user("ana"), "+1"], [user(VIEWER), "lo veo"]] });
    const state = build(prNode({ reviewThreads: [answered, unanswered] }));

    expect(state.threads).toMatchObject({ councilOpen: [Number(unanswered.comments.nodes[0]!.fullDatabaseId)], councilEver: true });
  });

  test("council resuelto: ya no está abierto pero queda councilEver", () => {
    const state = build(prNode({ reviewThreads: [thread(user(VIEWER), "[clanker-council] listo", { resolved: true })] }));

    expect(state.threads).toMatchObject({ councilOpen: [], councilEver: true });
  });

  test("sin pack no hay council ni bot: el prefijo es texto y todo thread de un humano cuenta", () => {
    const state = build(
      prNode({ reviewThreads: [thread(user("ana"), "[clanker-council] hola"), thread(bot("review-bot[bot]"), "x"), thread(user("coverage-bot"), "ci")] }),
      noPack,
    );

    expect(state.threads).toEqual({ unresolved: 3, humanOpen: 2, humanResolved: 0, botOpen: 0, councilOpen: [], councilEver: false });
  });
});

describe("CI con las reglas del pack", () => {
  test("un check ignorado por el pack (merge-queue) no tiñe el CI de rojo", () => {
    const state = build(
      prNode({ head: { oid: HEAD_SHA, contexts: [checkRun("test", "SUCCESS"), statusContext("merge-queue", "FAILURE"), checkRun("lint", "SKIPPED"), checkRun("types", "NEUTRAL")] } }),
    );

    expect(state.ci).toEqual({ state: "green", sha: HEAD_SHA, failing: [], flaky: [] });
  });

  test("rojo gana sobre pendiente y lista los checks que fallaron, cualquiera sea su conclusión", () => {
    const state = build(
      prNode({
        head: {
          oid: HEAD_SHA,
          contexts: [checkRun("a", "FAILURE"), checkRun("b", "CANCELLED"), checkRun("c", "TIMED_OUT"), statusContext("d", "ERROR"), checkRun("e", "IN_PROGRESS"), checkRun("f", "SUCCESS")],
        },
      }),
    );

    expect(state.ci).toEqual({ state: "red", sha: HEAD_SHA, failing: ["a", "b", "c", "d"], flaky: [] });
  });

  test("pendiente: un check sin terminar o un status esperado", () => {
    for (const pending of [checkRun("e2e", "IN_PROGRESS"), statusContext("deploy", "EXPECTED"), statusContext("other", "PENDING")]) {
      expect(build(prNode({ head: { oid: HEAD_SHA, contexts: [checkRun("test", "SUCCESS"), pending] } })).ci).toEqual({
        state: "pending",
        sha: HEAD_SHA,
        failing: [],
        flaky: [],
      });
    }
  });

  test("sin checks, o solo checks ignorados, es none", () => {
    expect(build(prNode()).ci.state).toBe("none");
    expect(build(prNode({ head: { oid: HEAD_SHA, contexts: [statusContext("merge-queue", "PENDING")] } })).ci.state).toBe("none");
  });

  test("knownFlaky del pack marca, entre los que fallan, los flaky conocidos", () => {
    const pack: ResolvedPack = { ...acme, ciRules: { ...acme.ciRules, knownFlaky: ["e2e", "visual"] } };
    const contexts = [checkRun("e2e", "FAILURE"), checkRun("unit", "FAILURE"), checkRun("visual", "SUCCESS")];

    expect(build(prNode({ head: { oid: HEAD_SHA, contexts } }), pack).ci).toMatchObject({ state: "red", failing: ["e2e", "unit"], flaky: ["e2e"] });
  });

  test("okStates del pack: si SKIPPED no es ok, un check saltado deja el CI rojo", () => {
    const pack: ResolvedPack = { ...acme, ciRules: { okStates: ["SUCCESS"] } };

    expect(build(prNode({ head: { oid: HEAD_SHA, contexts: [checkRun("a", "SUCCESS"), checkRun("b", "SKIPPED")] } }), pack).ci).toMatchObject({
      state: "red",
      failing: ["b"],
    });
  });
});

describe("CI sin pack", () => {
  test("solo cuentan los checks requeridos de la branch protection", () => {
    const state = build(
      prNode({ head: { oid: HEAD_SHA, contexts: [checkRun("ci/test", "SUCCESS", true), statusContext("ci/status", "SUCCESS", true), checkRun("opcional", "FAILURE")] } }),
      noPack,
    );

    expect(state.ci).toEqual({ state: "green", sha: HEAD_SHA, failing: [], flaky: [] });
  });

  test("un requerido en rojo es rojo; uno sin terminar es pendiente", () => {
    const contexts = (required: Parameters<typeof checkRun>[1]) => [checkRun("ci/test", required, true), checkRun("opcional", "SUCCESS")];

    expect(build(prNode({ head: { oid: HEAD_SHA, contexts: contexts("FAILURE") } }), noPack).ci).toMatchObject({ state: "red", failing: ["ci/test"] });
    expect(build(prNode({ head: { oid: HEAD_SHA, contexts: contexts("IN_PROGRESS") } }), noPack).ci.state).toBe("pending");
  });

  test("sin checks requeridos no hay CI que esperar: none, aunque haya checks en rojo", () => {
    const state = build(prNode({ head: { oid: HEAD_SHA, contexts: [checkRun("opcional", "FAILURE")] } }), noPack);

    expect(state.ci.state).toBe("none");
  });
});

describe("reviewers humanos", () => {
  test("solo humanos: ni el autor, ni bots, ni las cuentas que el pack ignora", () => {
    const state = build(
      prNode({
        reviews: [
          review(user("ana"), "APPROVED"),
          review(user("octocat"), "COMMENTED", { body: "yo mismo" }),
          review(bot("dependabot[bot]"), "APPROVED"),
          review(user("coverage-bot"), "APPROVED"),
          review(bot("review-bot[bot]"), "APPROVED", { body: "LGTM" }),
          review(null, "APPROVED"),
        ],
      }),
    );

    expect(state.reviewers).toEqual([{ login: "ana", avatarUrl: "https://avatars.example/ana", state: "approved" }]);
  });

  test("sin pack, una cuenta que el pack de ejemplo ignora es una persona más", () => {
    const state = build(prNode({ reviews: [review(user("coverage-bot"), "APPROVED")] }), noPack);

    expect(state.reviewers.map((r) => r.login)).toEqual(["coverage-bot"]);
  });

  test("el último estado de cada uno: descartada lo borra, comentar después de aprobar no quita la aprobación", () => {
    const state = build(
      prNode({
        reviews: [
          review(user("ana"), "CHANGES_REQUESTED", { at: "2026-11-10T09:00:00Z" }),
          review(user("ana"), "APPROVED", { at: "2026-11-10T10:00:00Z" }),
          review(user("ana"), "COMMENTED", { body: "una duda", at: "2026-11-10T11:00:00Z" }),
          review(user("beto"), "APPROVED", { at: "2026-11-10T09:00:00Z" }),
          review(user("beto"), "DISMISSED", { at: "2026-11-10T10:00:00Z" }),
          review(user("caro"), "COMMENTED", { body: "ojo", at: "2026-11-10T09:00:00Z" }),
          review(user("dani"), "PENDING", { at: "2026-11-10T09:00:00Z" }),
        ],
      }),
    );

    expect(state.reviewers.map((r) => [r.login, r.state])).toEqual([
      ["ana", "approved"],
      ["caro", "commented"],
    ]);
  });

  test("una review pedida de nuevo pisa la anterior y queda pendiente; un bot pedido no aparece", () => {
    const state = build(
      prNode({
        reviews: [review(user("ana"), "APPROVED")],
        requestedReviewers: [user("ana"), user("beto"), bot("review-bot[bot]"), user("octocat")],
      }),
    );

    expect(state.reviewers.map((r) => [r.login, r.state])).toEqual([
      ["ana", "pending"],
      ["beto", "pending"],
    ]);
  });
});

describe("talk", () => {
  test("lo que escribieron humanos, en orden: comentarios, reviews con texto y reviews que piden cambios", () => {
    const state = build(
      prNode({
        reviews: [
          review(user("ana"), "COMMENTED", { body: "una duda sobre el nombre", at: "2026-11-10T12:00:00Z" }),
          review(user("beto"), "CHANGES_REQUESTED", { body: "", at: "2026-11-10T14:00:00Z" }),
          review(user("caro"), "APPROVED", { body: "LGTM", at: "2026-11-10T13:00:00Z" }),
          review(user("dani"), "APPROVED", { body: "", at: "2026-11-10T13:30:00Z" }),
          review(user("eli"), "APPROVED", { body: "Se ve bien, solo un nit en el test", at: "2026-11-10T15:00:00Z" }),
        ],
        comments: [
          comment(user("fer"), "¿esto ya está en prod?", "2026-11-10T11:00:00Z"),
          comment(user(VIEWER), "/merge", "2026-11-10T16:00:00Z"),
          comment(bot("review-bot[bot]"), "review lista", "2026-11-10T11:30:00Z"),
          comment(user("coverage-bot"), "CI verde", "2026-11-10T11:40:00Z"),
          comment(null, "de una cuenta borrada", "2026-11-10T11:50:00Z"),
        ],
      }),
    );

    expect(state.talk).toEqual([
      { kind: "comment", author: "fer", at: "2026-11-10T11:00:00Z", excerpt: "¿esto ya está en prod?" },
      { kind: "review", author: "ana", at: "2026-11-10T12:00:00Z", excerpt: "una duda sobre el nombre" },
      { kind: "changes", author: "beto", at: "2026-11-10T14:00:00Z", excerpt: "" },
      { kind: "review", author: "eli", at: "2026-11-10T15:00:00Z", excerpt: "Se ve bien, solo un nit en el test" },
    ]);
  });

  test("como el vigilante: un texto de solo espacios es texto, una review descartada con texto sigue contando y lo del council no cuenta", () => {
    const state = build(
      prNode({
        reviews: [
          review(user("ana"), "COMMENTED", { body: "  \n ", at: "2026-11-10T10:00:00Z" }),
          review(user("beto"), "DISMISSED", { body: "revisa esto", at: "2026-11-10T11:00:00Z" }),
          review(user("caro"), "DISMISSED", { body: "", at: "2026-11-10T12:00:00Z" }),
          review(user("dani"), "COMMENTED", { body: "[clanker-council] 🟡 mueve esto", at: "2026-11-10T13:00:00Z" }),
          review(user("eli"), "CHANGES_REQUESTED", { body: "[clanker-council] cambios", at: "2026-11-10T14:00:00Z" }),
        ],
        comments: [comment(user("fer"), "[clanker-council] 🟡 otro", "2026-11-10T15:00:00Z"), comment(user("gus"), "va", "2026-11-10T16:00:00Z")],
      }),
    );

    expect(state.talk.map((t) => [t.kind, t.author])).toEqual([
      ["review", "ana"],
      ["review", "beto"],
      ["comment", "gus"],
    ]);
  });

  test("como el vigilante: el primer comentario de un thread humano sin resolver cuenta, sus respuestas, los resueltos y los del bot, la cuenta o el council no", () => {
    const state = build(
      prNode({
        reviewThreads: [
          thread(user("ana"), "esto está raro", { replies: [[user("beto"), "yo también lo vi"]], at: "2026-11-10T12:00:00Z" }),
          thread(user("caro"), "ya quedó", { resolved: true, at: "2026-11-10T12:10:00Z" }),
          thread(user(VIEWER), "lo dije yo", { at: "2026-11-10T12:20:00Z" }),
          thread(bot("review-bot[bot]"), "bug posible", { at: "2026-11-10T12:30:00Z" }),
          thread(user("dani"), "[clanker-council] 🟡 mueve esto", { at: "2026-11-10T12:40:00Z" }),
        ],
      }),
    );

    expect(state.talk).toEqual([{ kind: "comment", author: "ana", at: "2026-11-10T12:00:00Z", excerpt: "esto está raro" }]);
  });

  test("sin pack, una review sin texto sigue siendo silenciosa pero un LGTM escrito cuenta", () => {
    const state = build(
      prNode({ reviews: [review(user("ana"), "APPROVED", { body: "" }), review(user("beto"), "APPROVED", { body: "LGTM" })] }),
      noPack,
    );

    expect(state.talk.map((t) => t.author)).toEqual(["beto"]);
  });

  test("el extracto va en una línea y se corta", () => {
    const state = build(prNode({ comments: [comment(user("ana"), `primera\n\n  línea ${"x".repeat(400)}`)] }));

    const { excerpt } = state.talk[0]!;
    expect(excerpt.startsWith("primera línea xxx")).toBe(true);
    expect(excerpt).toHaveLength(EXCERPT_MAX_CHARS);
    expect(excerpt.endsWith("…")).toBe(true);
  });
});

describe("señales y labels del pack", () => {
  const withLabels = (...names: string[]) => prNode({ labels: names.map((name) => ({ name, color: "d73a4a", description: null })) });

  test("el riesgo sale del label, sin mayúsculas ni alias", () => {
    expect(build(withLabels("risk:high")).signals).toEqual({ risk: "high" });
    expect(build(withLabels("bug", "Risk/Medium")).signals).toEqual({ risk: "mid" });
    expect(build(withLabels("risk low")).signals).toEqual({ risk: "low" });
  });

  test("sin label de riesgo, o con uno que no es un nivel del pack, no hay señal", () => {
    expect(build(withLabels("bug")).signals).toEqual({});
    expect(build(withLabels("risk:extreme")).signals).toEqual({});
  });

  test("sin pack no hay señales, pero los labels se entregan igual", () => {
    const state = build(withLabels("risk:high"), noPack);

    expect(state.signals).toEqual({});
    expect(state.labels).toEqual([{ name: "risk:high", color: "d73a4a", description: null }]);
  });
});

describe("approvers", () => {
  test("los humanos cuya última review que opina es una aprobación, en orden alfabético", () => {
    const state = build(
      prNode({
        reviews: [
          review(user("caro"), "APPROVED", { at: "2026-11-10T10:00:00Z" }),
          review(user("ana"), "APPROVED", { at: "2026-11-10T11:00:00Z" }),
          review(user("ana"), "COMMENTED", { body: "una duda", at: "2026-11-10T12:00:00Z" }),
          review(user("beto"), "APPROVED", { at: "2026-11-10T10:00:00Z" }),
          review(user("beto"), "CHANGES_REQUESTED", { body: "no", at: "2026-11-10T13:00:00Z" }),
          review(user("dani"), "APPROVED", { at: "2026-11-10T10:00:00Z" }),
          review(user("dani"), "DISMISSED", { at: "2026-11-10T14:00:00Z" }),
          review(user("eli"), "APPROVED", { at: "2026-11-10T15:00:00Z" }),
          review(user("eli"), "PENDING", { at: "2026-11-10T16:00:00Z" }),
        ],
      }),
    );

    expect(state.approvers).toEqual(["ana", "caro", "eli"]);
  });

  test("ni bots, ni cuentas del pack, ni la cuenta conectada aprueban", () => {
    const state = build(
      prNode({
        reviews: [
          review(bot("review-bot[bot]"), "APPROVED", { body: "LGTM" }),
          review(user("codecov"), "APPROVED"),
          review(user(VIEWER), "APPROVED"),
          review(null, "APPROVED"),
        ],
      }),
    );

    expect(state.approvers).toEqual([]);
  });
});

describe("merge", () => {
  /** Aprobado por un humano, CI verde y sobre la principal: lo mínimo para el nivel auto de Acme. */
  const ready = (overrides: Partial<PrNode> = {}) =>
    prNode({
      reviewDecision: "APPROVED",
      reviews: [review(user("ana"), "APPROVED")],
      head: { oid: HEAD_SHA, contexts: [checkRun("rspec", "SUCCESS")] },
      ...overrides,
    });
  const fin = (body = "/merge", at = "2026-11-10T12:00:00Z") => comment(user(VIEWER), body, at);

  test("con la estrategia del pack: ready, offer y auto de un PR limpio", () => {
    expect(build(ready()).merge).toEqual({ via: "comment", command: "/merge", ready: true, blockers: [], queue: null, offer: true, auto: true });
  });

  test("un /merge de la cuenta conectada lo pone en cola, y merge-queue en FAILURE o ERROR lo da por fallado", () => {
    const queued = build(ready({ comments: [fin("  /merge\n")], head: { oid: HEAD_SHA, contexts: [checkRun("rspec", "SUCCESS"), statusContext("merge-queue", "PENDING")] } }));
    const failed = (state: "FAILURE" | "ERROR") =>
      build(ready({ comments: [fin()], head: { oid: HEAD_SHA, contexts: [checkRun("rspec", "SUCCESS"), statusContext("merge-queue", state)] } })).merge.queue;

    expect(queued.merge).toMatchObject({ queue: "queued", ready: false, blockers: [], offer: false, auto: false });
    expect(failed("FAILURE")).toBe("failed");
    expect(failed("ERROR")).toBe("failed");
    // Sin el check de la cola, o con uno que no falló, sigue en cola.
    expect(build(ready({ comments: [fin()] })).merge.queue).toBe("queued");
    expect(build(ready({ comments: [fin()], head: { oid: HEAD_SHA, contexts: [statusContext("merge-queue", "SUCCESS")] } })).merge.queue).toBe("queued");
  });

  test("solo cuenta el comando exacto de la cuenta conectada", () => {
    for (const comments of [
      [fin("/merge please")],
      [fin("/Merge")],
      [comment(user("ana"), "/merge")],
      [comment(bot("review-bot[bot]"), "/merge")],
    ]) {
      expect(build(ready({ comments })).merge.queue).toBeNull();
    }
  });

  test("un comando con caracteres de regex se compara literal", () => {
    const pack: ResolvedPack = { ...acme, mergeStrategy: { ...acme.mergeStrategy!, command: "merge (now)?" } };

    expect(build(ready({ comments: [fin("merge (now)?")] }), pack).merge.queue).toBe("queued");
    expect(build(ready({ comments: [fin("merge now")] }), pack).merge.queue).toBeNull();
  });

  test("hold apaga offer y auto pero no ready", () => {
    expect(build(ready(), acme, { hold: true })).toMatchObject({ hold: true, merge: { ready: true, offer: false, auto: false } });
    expect(build(ready()).hold).toBe(false);
  });

  test("donde la estrategia no aplica, o sin pack, se mergea con el botón de GitHub y /merge no significa nada", () => {
    const withFin = ready({ comments: [fin()] });

    expect(build(withFin, acme, { mergeApplies: false }).merge).toEqual({ via: "button", ready: true, blockers: [], queue: null, offer: true, auto: false });
    expect(build(withFin, noPack).merge).toMatchObject({ via: "button", queue: null, auto: false });
  });

  test("un PR sin aprobación o con un hilo de humano abierto no está listo", () => {
    const state = build(prNode({ reviewThreads: [thread(user("ana"), "falta esto")], head: { oid: HEAD_SHA, contexts: [checkRun("rspec", "SUCCESS")] } }));

    expect(state.merge).toMatchObject({ ready: false, offer: false, blockers: ["falta aprobación", "1 hilos de humanos sin resolver"] });
  });

  test("un PR mergeado o cerrado no tiene merge", () => {
    expect(build(ready({ state: "MERGED" })).merge).toEqual({ via: "comment", command: "/merge", ready: false, blockers: [], queue: null, offer: false, auto: false });
  });
});

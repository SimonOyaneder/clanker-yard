import { CodexStatus } from "@clanker/api";
import { expect, test } from "vitest";
import type { RateLimitSnapshot } from "./api";
import { CodexLimits, codexStatusWithLimits, mergeCodexLimits } from "./usage";

function snapshot(input: Partial<RateLimitSnapshot> = {}): RateLimitSnapshot {
  return {
    limitId: "codex", limitName: "Codex", planType: "plus", rateLimitReachedType: null,
    primary: { usedPercent: 25, windowDurationMins: 300, resetsAt: 2000000000 },
    secondary: null, credits: null, spendControlReached: false, ...input,
  };
}

function limits(input: Partial<CodexLimits> = {}): CodexLimits {
  return { ordinaryUsageAllowed: true, rateLimits: snapshot(), rateLimitsByLimitId: null, ...input };
}

test("proyecta una ventana con resets en milisegundos y plan del snapshot", () => {
  const status = codexStatusWithLimits({ state: "ready" }, limits());
  expect(status).toEqual({
    state: "ready", plan: "plus",
    usage: { windows: [{ id: "codex:primary", label: "Codex", windowMins: 300, usedPercent: 25, resetsAt: 2000000000000 }] },
  });
  expect(CodexStatus.safeParse(status).success).toBe(true);
});

test("conserva el orden de los buckets y primary antes de secondary, sin suponer duraciones", () => {
  const status = codexStatusWithLimits({ state: "ready", plan: "business" }, limits({
    rateLimitsByLimitId: {
      spark: snapshot({ limitId: "spark", limitName: null, primary: { usedPercent: 12, windowDurationMins: null, resetsAt: null } }),
      codex: snapshot({ secondary: { usedPercent: 60, windowDurationMins: 10080, resetsAt: 2100000000 } }),
    },
  }));
  expect(status.plan).toBe("business");
  expect(status.usage?.windows).toEqual([
    { id: "spark:primary", windowMins: null, usedPercent: 12 },
    { id: "codex:primary", label: "Codex", windowMins: 300, usedPercent: 25, resetsAt: 2000000000000 },
    { id: "codex:secondary", label: "Codex", windowMins: 10080, usedPercent: 60, resetsAt: 2100000000000 },
  ]);
});

test("usa el mapa cuando existe y el snapshot compatible solo cuando falta", () => {
  const data = limits({ rateLimitsByLimitId: { spark: snapshot({ limitId: "spark" }) } });
  expect(codexStatusWithLimits({ state: "ready" }, data).usage?.windows.map((window) => window.id)).toEqual(["spark:primary"]);
  expect(codexStatusWithLimits({ state: "ready" }, { ...data, rateLimitsByLimitId: {} }).usage?.windows).toEqual([]);
  expect(codexStatusWithLimits({ state: "ready" }, limits({ rateLimits: snapshot({ limitId: null }) })).usage?.windows[0]?.id).toBe("codex:primary");
});

test.each([
  { hasCredits: true, unlimited: false, balance: null },
  { hasCredits: false, unlimited: true, balance: "10.500" },
])("conserva créditos canónicos incluso sin ventanas (%j)", (credits) => {
  const status = codexStatusWithLimits({ state: "ready" }, limits({
    rateLimits: snapshot({ primary: null, credits }),
    rateLimitsByLimitId: { spark: snapshot({ primary: null, credits: { hasCredits: false, unlimited: false, balance: "999" } }) },
  }));
  expect(status.usage).toEqual({ windows: [], credits });
});

test("no toma créditos de otro bucket ni inventa un balance cero", () => {
  const status = codexStatusWithLimits({ state: "ready" }, limits({
    rateLimitsByLimitId: { spark: snapshot({ credits: { hasCredits: true, unlimited: false, balance: "999" } }) },
  }));
  expect(status.usage).not.toHaveProperty("credits");
});

test.each([
  limits({ ordinaryUsageAllowed: false }),
  limits({ rateLimits: snapshot({ rateLimitReachedType: "rate_limit_reached" }) }),
  limits({ rateLimitsByLimitId: { spark: snapshot({ limitId: "spark", rateLimitReachedType: "workspace_owner_usage_limit_reached" }) } }),
])("evidencia explícita de cuota basta aunque los porcentajes sean bajos", (data) => {
  expect(codexStatusWithLimits({ state: "ready" }, data)).toMatchObject({ state: "quota_exhausted" });
});

test("no decide permiso ordinario por porcentaje, créditos o tiempo de reset", () => {
  const status = codexStatusWithLimits({ state: "ready" }, limits({
    ordinaryUsageAllowed: null,
    rateLimits: snapshot({ primary: { usedPercent: 100, windowDurationMins: 300, resetsAt: 1 }, credits: { hasCredits: false, unlimited: false, balance: "0" } }),
  }));
  expect(status.state).toBe("ready");
});

test.each(["login_expired", "login_required", "error", "not_installed", "outdated"] as const)("no pisa el estado %s con evidencia de cuota", (state) => {
  expect(codexStatusWithLimits({ state, message: "previous" }, limits({ ordinaryUsageAllowed: false })))
    .toMatchObject({ state, message: "previous" });
  expect(codexStatusWithLimits({ state, message: "previous" }, limits()))
    .toMatchObject({ state, message: "previous" });
});

test("no recupera cuota agotada con una notificación; una lectura completa parte de ready", () => {
  const data = limits();
  expect(codexStatusWithLimits({ state: "quota_exhausted", message: "blocked", resetsAt: 123 }, data))
    .toMatchObject({ state: "quota_exhausted", resetsAt: 123 });
  expect(codexStatusWithLimits({ state: "ready" }, data).state).toBe("ready");
});

test("el reset de cuota considera todas las ventanas agotadas", () => {
  expect(codexStatusWithLimits({ state: "ready" }, limits({
    ordinaryUsageAllowed: false,
    rateLimits: snapshot({
      primary: { usedPercent: 100, windowDurationMins: 300, resetsAt: 2000000000 },
      secondary: { usedPercent: 100, windowDurationMins: 10080, resetsAt: 2100000000 },
    }),
  })).resetsAt).toBe(2100000000000);
});

test("inicia límites desconocidos con una notificación sin inferir ordinaryUsageAllowed", () => {
  const update = snapshot({ limitId: null });
  expect(mergeCodexLimits(undefined, update)).toEqual({
    ordinaryUsageAllowed: null, rateLimits: update, rateLimitsByLimitId: null,
  });
  const identified = snapshot();
  expect(mergeCodexLimits(undefined, identified)).toEqual({
    ordinaryUsageAllowed: null, rateLimits: identified, rateLimitsByLimitId: { codex: identified },
  });
});

test.each(["codex", null])("mezcla ventanas y metadatos del fallback %s sin mutar el snapshot anterior", (limitId) => {
  const before = limits({
    ordinaryUsageAllowed: false,
    rateLimits: snapshot({
      limitId,
      secondary: { usedPercent: 60, windowDurationMins: 10080, resetsAt: 2100000000 },
      credits: { hasCredits: true, unlimited: false, balance: "7" },
      rateLimitReachedType: "rate_limit_reached", spendControlReached: true,
    }),
  });
  const saved = structuredClone(before);
  const next = mergeCodexLimits(before, snapshot({
    limitId: null, limitName: null, planType: null, rateLimitReachedType: null,
    spendControlReached: null,
    primary: { usedPercent: 0, windowDurationMins: null, resetsAt: null },
    credits: { hasCredits: false, unlimited: false, balance: null },
  }));
  expect(next).toMatchObject({
    ordinaryUsageAllowed: false,
    rateLimits: {
      limitId, limitName: "Codex", planType: "plus", rateLimitReachedType: "rate_limit_reached",
      spendControlReached: true,
      primary: { usedPercent: 0, windowDurationMins: 300, resetsAt: 2000000000 },
      secondary: { usedPercent: 60, windowDurationMins: 10080, resetsAt: 2100000000 },
      credits: { hasCredits: false, unlimited: false, balance: "7" },
    },
  });
  expect(next.rateLimitsByLimitId).toEqual({ codex: next.rateLimits });
  expect(codexStatusWithLimits({ state: "ready" }, next).usage?.windows).toEqual([
    { id: "codex:primary", label: "Codex", windowMins: 300, usedPercent: 0, resetsAt: 2000000000000 },
    { id: "codex:secondary", label: "Codex", windowMins: 10080, usedPercent: 60, resetsAt: 2100000000000 },
  ]);
  expect(CodexLimits.safeParse(next).success).toBe(true);
  expect(before).toEqual(saved);
});

test("conserva créditos al llegar null y respeta false y cadena vacía", () => {
  const before = limits({ rateLimits: snapshot({ credits: { hasCredits: true, unlimited: true, balance: "5" }, spendControlReached: true }) });
  expect(mergeCodexLimits(before, snapshot()).rateLimits.credits).toEqual(before.rateLimits.credits);
  expect(mergeCodexLimits(before, snapshot({ credits: { hasCredits: false, unlimited: false, balance: "" } })).rateLimits)
    .toMatchObject({ credits: { hasCredits: false, unlimited: false, balance: "" }, spendControlReached: false });
});

test("mezcla por limitId sin perder buckets ni reemplazar los créditos canónicos", () => {
  const codex = snapshot({ credits: { hasCredits: true, unlimited: false, balance: "10" } });
  const spark = snapshot({ limitId: "spark", limitName: "Spark", secondary: { usedPercent: 3, windowDurationMins: 90, resetsAt: 2100000000 } });
  const before = limits({ rateLimits: codex, rateLimitsByLimitId: { codex, spark } });
  const next = mergeCodexLimits(before, snapshot({ limitId: "spark", limitName: null, primary: { usedPercent: 50, windowDurationMins: null, resetsAt: null } }));
  expect(next.rateLimits).toEqual(codex);
  expect(next.rateLimitsByLimitId?.codex).toEqual(codex);
  expect(next.rateLimitsByLimitId?.spark).toMatchObject({
    limitName: "Spark",
    primary: { usedPercent: 50, windowDurationMins: 300, resetsAt: 2000000000 },
    secondary: spark.secondary,
  });
  expect(codexStatusWithLimits({ state: "ready" }, next).usage?.credits?.balance).toBe("10");
  const third = mergeCodexLimits(next, snapshot({ limitId: "third" }));
  expect(Object.keys(third.rateLimitsByLimitId!)).toEqual(["codex", "spark", "third"]);
});

test("un bucket nuevo tras fallback conserva también el canónico", () => {
  const next = mergeCodexLimits(limits(), snapshot({ limitId: "spark" }));
  expect(Object.keys(next.rateLimitsByLimitId!)).toEqual(["codex", "spark"]);
  expect(next.rateLimits).toEqual(snapshot());
});

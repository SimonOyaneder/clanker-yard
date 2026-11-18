import type { CodexStatus } from "@clanker/api";
import * as z from "zod";
import type { RateLimitSnapshot } from "./api";

const Window = z.object({
  usedPercent: z.number(),
  windowDurationMins: z.number().nullable(),
  resetsAt: z.int().nonnegative().nullable(),
});

const Snapshot = z.object({
  limitId: z.string().nullable(),
  limitName: z.string().nullable().optional(),
  planType: z.string().nullable().optional(),
  rateLimitReachedType: z.string().nullable().optional(),
  primary: Window.nullable(),
  secondary: Window.nullable(),
  credits: z.object({
    hasCredits: z.boolean(),
    unlimited: z.boolean(),
    balance: z.string().nullable(),
  }).nullable(),
  spendControlReached: z.boolean().nullable(),
});

export const CodexLimits = z.object({
  ordinaryUsageAllowed: z.boolean().nullable(),
  rateLimits: Snapshot,
  rateLimitsByLimitId: z.record(z.string(), Snapshot).nullable(),
});

export type CodexLimits = z.infer<typeof CodexLimits>;

function mergeSnapshot(previous: RateLimitSnapshot | undefined, update: RateLimitSnapshot): RateLimitSnapshot {
  if (!previous) return update;
  const window = (before: RateLimitSnapshot["primary"], next: RateLimitSnapshot["primary"]) =>
    next === null ? before : {
      ...next,
      windowDurationMins: next.windowDurationMins ?? before?.windowDurationMins ?? null,
      resetsAt: next.resetsAt ?? before?.resetsAt ?? null,
    };
  return {
    ...previous,
    ...update,
    limitId: update.limitId ?? previous.limitId,
    limitName: update.limitName ?? previous.limitName,
    planType: update.planType ?? previous.planType,
    rateLimitReachedType: update.rateLimitReachedType ?? previous.rateLimitReachedType,
    spendControlReached: update.spendControlReached ?? previous.spendControlReached,
    primary: window(previous.primary, update.primary),
    secondary: window(previous.secondary, update.secondary),
    credits: update.credits === null ? previous.credits : {
      ...update.credits,
      balance: update.credits.balance ?? previous.credits?.balance ?? null,
    },
  };
}

export function mergeCodexLimits(previous: CodexLimits | undefined, update: RateLimitSnapshot): CodexLimits {
  if (!previous) {
    return {
      ordinaryUsageAllowed: null,
      rateLimits: update,
      rateLimitsByLimitId: update.limitId === null ? null : { [update.limitId]: update },
    };
  }
  const canonical = previous.rateLimits;
  const isCanonical = update.limitId === null || canonical.limitId === null || update.limitId === canonical.limitId;
  const rateLimits = isCanonical ? mergeSnapshot(canonical, update) : canonical;
  let buckets = previous.rateLimitsByLimitId;
  const id = update.limitId ?? canonical.limitId ?? "codex";
  buckets = { ...(buckets ?? { [canonical.limitId ?? "codex"]: canonical }) };
  buckets[id] = mergeSnapshot(buckets[id], update);
  return { ...previous, rateLimits, rateLimitsByLimitId: buckets };
}

export function codexStatusWithLimits(status: CodexStatus, limits: CodexLimits): CodexStatus {
  const buckets = limits.rateLimitsByLimitId === null
    ? [[limits.rateLimits.limitId ?? "codex", limits.rateLimits] as const]
    : Object.entries(limits.rateLimitsByLimitId);
  const windows = buckets.flatMap(([id, snapshot]) =>
    (["primary", "secondary"] as const).flatMap((kind) => {
      const window = snapshot[kind];
      return window === null ? [] : [{
        id: `${id}:${kind}`,
        ...(snapshot.limitName == null ? {} : { label: snapshot.limitName }),
        windowMins: window.windowDurationMins,
        usedPercent: window.usedPercent,
        ...(window.resetsAt === null ? {} : { resetsAt: window.resetsAt * 1000 }),
      }];
    }));
  const snapshots = [limits.rateLimits, ...buckets.map(([, snapshot]) => snapshot)];
  const exhausted = limits.ordinaryUsageAllowed === false || snapshots.some((snapshot) => snapshot.rateLimitReachedType != null);
  const next: CodexStatus = {
    ...status,
    ...(status.plan !== undefined || limits.rateLimits.planType == null ? {} : { plan: limits.rateLimits.planType }),
    usage: {
      windows,
      ...(limits.rateLimits.credits === null ? {} : { credits: limits.rateLimits.credits }),
    },
  };
  if (status.state !== "ready" && status.state !== "quota_exhausted") return next;
  if (!exhausted && status.state !== "quota_exhausted") return next;
  const resets = windows.filter((window) => window.usedPercent >= 100 && window.resetsAt !== undefined).map((window) => window.resetsAt!);
  const resetsAt = resets.length === 0 ? status.resetsAt : Math.max(...resets);
  return {
    ...next,
    state: "quota_exhausted",
    message: `Codex no permite uso ordinario con la cuota actual.${resetsAt === undefined ? " Revisa el uso de tu plan." : ` Se reinicia el ${new Date(resetsAt).toISOString()}.`}`,
    ...(resetsAt === undefined ? {} : { resetsAt }),
  };
}

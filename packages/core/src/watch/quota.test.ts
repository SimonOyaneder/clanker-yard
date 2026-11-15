import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { rateKey } from "../github/client";
import { syncCursors } from "../store/schema";
import { openStore, type Store } from "../store/store";
import { throttleOf } from "./quota";

const NOW = 1_000_000;
const RESET = NOW + 600_000;

let store: Store;

beforeEach(() => {
  store = openStore({ path: ":memory:" });
});

afterEach(() => store.close());

function quota(resource: string, remaining: number, { limit = 5000, resetAt = RESET }: { limit?: number | null; resetAt?: number } = {}) {
  store.tx((tx) =>
    tx.db.insert(syncCursors).values({ key: rateKey("octocat", resource), checkedAt: NOW, rateRemaining: remaining, resetAt, rateLimit: limit }).run(),
  );
}

describe("throttleOf", () => {
  test("sin cuota informada, o con bastante, no frena", () => {
    expect(throttleOf(store, "octocat", NOW)).toEqual({ level: "normal" });
    quota("core", 2000);
    expect(throttleOf(store, "octocat", NOW)).toEqual({ level: "normal" });
  });

  test("bajo 25% de REST o de GraphQL, intervalos al doble", () => {
    quota("graphql", 1000);
    expect(throttleOf(store, "octocat", NOW)).toEqual({ level: "slow" });
  });

  test("bajo 10% solo los PRs con waits, hasta que la cuota se renueve", () => {
    quota("core", 400);
    quota("graphql", 1000);
    expect(throttleOf(store, "octocat", NOW)).toEqual({ level: "waits-only", until: RESET });
  });

  test("la fracción sale del tope que GitHub informó, no de 5000", () => {
    quota("search", 3, { limit: 30 });
    quota("core", 20, { limit: 100 });
    expect(throttleOf(store, "octocat", NOW)).toEqual({ level: "slow" });
  });

  test("sin requests restantes no se hace nada hasta el reset", () => {
    quota("core", 0);
    expect(throttleOf(store, "octocat", NOW)).toEqual({ level: "exhausted", until: RESET });
  });

  test("una cuota cuyo reset ya pasó se da por renovada", () => {
    quota("core", 0, { resetAt: NOW - 1 });
    expect(throttleOf(store, "octocat", NOW)).toEqual({ level: "normal" });
  });
});

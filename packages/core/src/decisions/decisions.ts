import type { Decision, DecisionFilter, DecisionId, DecisionResolution } from "@clanker/api";
import { and, desc, eq, inArray, sql } from "drizzle-orm";
import { newId } from "../store/conventions";
import { decisions, pullRequests } from "../store/schema";
import type { Store, Tx } from "../store/store";

export interface Decisions {
  /** De la más reciente a la más antigua. */
  list(filter?: DecisionFilter): Decision[];
  get(id: DecisionId): Decision | undefined;
}

export function createDecisions({ store }: { store: Store }): Decisions {
  return {
    list: (filter = {}) =>
      store.db
        .select()
        .from(decisions)
        .where(
          and(
            filter.projectId === undefined ? undefined : eq(decisions.projectId, filter.projectId),
            filter.runId === undefined ? undefined : eq(decisions.runId, filter.runId),
            filter.status === undefined ? undefined : inArray(decisions.status, filter.status),
            filter.kind === undefined ? undefined : inArray(decisions.kind, filter.kind),
          ),
        )
        .orderBy(desc(decisions.id))
        .all(),
    get: (id) => store.db.select().from(decisions).where(eq(decisions.id, id)).get(),
  };
}

/** Lo que se necesita para abrir una decisión. Sin `options` no hay nada que elegir: una nota. */
export type NewDecision = Pick<Decision, "kind" | "title" | "body"> &
  Partial<Pick<Decision, "projectId" | "runId" | "stepRunId" | "subject" | "options">>;

/**
 * Deja una decisión `pending` en la bandeja y emite `decision.opened`, en la transacción de quien la
 * abre: nace junto con lo que la causó o no nace. No toca la corrida: quien abre un `gate` o un
 * `needs_human` es quien la estaciona.
 */
export function openDecision(tx: Tx, decision: NewDecision): Decision {
  const { kind, title, body } = decision;
  const id = newId("dec");
  const opened = tx.emit({
    type: "decision.opened",
    origin: "core",
    projectId: decision.projectId ?? undefined,
    runId: decision.runId ?? undefined,
    stepRunId: decision.stepRunId ?? undefined,
    subject: decision.subject ?? undefined,
    payload: { decisionId: id, kind, title },
  });
  return tx.db
    .insert(decisions)
    .values({
      id,
      projectId: decision.projectId ?? null,
      runId: decision.runId ?? null,
      stepRunId: decision.stepRunId ?? null,
      subject: decision.subject ?? null,
      kind,
      title,
      body,
      options: decision.options ?? [],
      status: "pending",
      createdAt: opened.ts,
    })
    .returning()
    .get();
}

/**
 * Cierra una decisión `pending` y emite `decision.resolved`: `answered` con la opción elegida,
 * `expired` si siguió sola por su default y `superseded` si ya no hay nada que decidir (la corrida
 * se canceló). `undefined` si ya estaba cerrada.
 */
export function closeDecision(
  tx: Tx,
  id: DecisionId,
  closing: { status: "answered" | "expired" | "superseded"; resolution?: DecisionResolution; by: string },
): Decision | undefined {
  const open = tx.db
    .select()
    .from(decisions)
    .where(and(eq(decisions.id, id), eq(decisions.status, "pending")))
    .get();
  if (!open) return undefined;
  const resolved = tx.emit({
    type: "decision.resolved",
    origin: "core",
    projectId: open.projectId ?? undefined,
    runId: open.runId ?? undefined,
    stepRunId: open.stepRunId ?? undefined,
    subject: open.subject ?? undefined,
    payload: { decisionId: id, status: closing.status },
  });
  return tx.db
    .update(decisions)
    .set({ status: closing.status, resolution: closing.resolution ?? null, resolvedBy: closing.by, resolvedAt: resolved.ts })
    .where(eq(decisions.id, id))
    .returning()
    .get();
}

/**
 * Una `review_note` sobre un PR que ya se mergeó no tiene nada que revisar: las pendientes cuyo
 * `subject` es ese PR quedan `expired` (decisión 20, `docs/design.html#decisiones`). Devuelve cuántas.
 * Watch lo corre en cada despertar, así también cae lo que llegó con el PR ya mergeado (la importación del loop).
 */
export function expireMergedReviewNotes(store: Store): number {
  const stale = store.db
    .select({ id: decisions.id })
    .from(decisions)
    .innerJoin(pullRequests, sql`${pullRequests.id} = json_extract(${decisions.subject}, '$.id')`)
    .where(and(eq(decisions.status, "pending"), eq(decisions.kind, "review_note"), sql`json_extract(${decisions.subject}, '$.type') = 'pr'`, eq(pullRequests.state, "merged")))
    .all();
  if (stale.length === 0) return 0;
  return store.tx((tx) => stale.filter(({ id }) => closeDecision(tx, id, { status: "expired", resolution: { reason: "pr_merged" }, by: "watch" })).length);
}

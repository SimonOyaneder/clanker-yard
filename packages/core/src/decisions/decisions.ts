import type { Decision, DecisionFilter, DecisionId } from "@clanker/api";
import { and, desc, eq, inArray } from "drizzle-orm";
import { newId } from "../store/conventions";
import { decisions } from "../store/schema";
import type { Store, Tx } from "../store/store";

export interface Decisions {
  /** De la más reciente a la más antigua. */
  list(filter?: DecisionFilter): Decision[];
  get(id: DecisionId): Decision | undefined;
}

export function createDecisions(store: Store): Decisions {
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

/** Lo que se necesita para abrir una decisión que no bloquea: `review_note` o `note`. */
export type NewNote = Pick<Decision, "kind" | "title" | "body"> &
  Partial<Pick<Decision, "projectId" | "runId" | "stepRunId" | "subject">>;

/**
 * Deja una decisión `pending` en la bandeja y emite `decision.opened`, en la transacción de quien la
 * abre: nace junto con lo que la causó o no nace. No toca la corrida: una nota no estaciona nada.
 */
export function openNote(tx: Tx, note: NewNote): Decision {
  const { kind, title, body } = note;
  const id = newId("dec");
  const opened = tx.emit({
    type: "decision.opened",
    origin: "core",
    projectId: note.projectId ?? undefined,
    runId: note.runId ?? undefined,
    stepRunId: note.stepRunId ?? undefined,
    subject: note.subject ?? undefined,
    payload: { decisionId: id, kind, title },
  });
  return tx.db
    .insert(decisions)
    .values({
      id,
      projectId: note.projectId ?? null,
      runId: note.runId ?? null,
      stepRunId: note.stepRunId ?? null,
      subject: note.subject ?? null,
      kind,
      title,
      body,
      options: [],
      status: "pending",
      createdAt: opened.ts,
    })
    .returning()
    .get();
}

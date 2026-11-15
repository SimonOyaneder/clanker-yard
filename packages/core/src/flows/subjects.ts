import type { RunId, SubjectRef } from "@clanker/api";
import { and, asc, desc, eq, inArray, isNull, or } from "drizzle-orm";
import { decisions, runs } from "../store/schema";
import type { Store, Tx } from "../store/store";

// Una sola corrida dueña que escribe por sujeto (`docs/design.html#d-flows`, decisiones 3 y 9). El
// sujeto de una corrida es el suyo (`subject_*`) y, si es de una issue que ya publicó su PR, también
// ese PR (`claimed_pr_id`). Una corrida nueva sobre un sujeto ocupado queda `queued`: espera a la
// dueña, no a un slot. Si la dueña es de dev y está `parked`, el carril de mantenimiento le pide
// prestado el sujeto y el worktree (`borrowed_from_run_id`) y se los devuelve al terminar.

type RunRow = typeof runs.$inferSelect;
type Db = Store["db"];

/** Los estados en que una corrida que escribe ocupa su sujeto: `queued` espera y no lo ocupa. */
const HOLDING = ["running", "waiting", "parked", "paused"] as const;

const scopeOf = (run: RunRow) => ({
  projectId: run.projectId ?? undefined,
  runId: run.id,
  subject: { type: run.subjectType, id: run.subjectId },
});

/** Dónde queda una corrida que escribe, antes de existir: corriendo, esperando o con un sujeto prestado. */
type Admission = { status: "running" } | { status: "queued" } | { status: "running"; lender: RunRow };

export interface SubjectsDeps {
  /**
   * Pasa los worktrees que tiene `from` a `to`, en la tx del préstamo o de la devolución. Sin esto el
   * préstamo solo mueve el sujeto.
   */
  handOverWorkspaces?: (tx: Tx, from: RunId, to: RunId) => void;
}

/** La corrida viva que escribe sobre `subject` (en el suyo o en el PR que tomó al publicarlo); un préstamo no cuenta. */
export function ownerOf(db: Db, subject: SubjectRef): RunRow | undefined {
  return db
    .select()
    .from(runs)
    .where(
      and(
        eq(runs.writes, true),
        isNull(runs.parentRunId),
        isNull(runs.borrowedFromRunId),
        inArray(runs.status, HOLDING),
        or(
          and(eq(runs.subjectType, subject.type), eq(runs.subjectId, subject.id)),
          subject.type === "pr" ? eq(runs.claimedPrId, subject.id) : undefined,
        ),
      ),
    )
    .get();
}

/** La corrida que tiene prestado el sujeto de `ownerId`, si hay una. */
export function loanOf(db: Db, ownerId: RunId): RunRow | undefined {
  return db
    .select()
    .from(runs)
    .where(and(eq(runs.borrowedFromRunId, ownerId), inArray(runs.status, HOLDING)))
    .get();
}

export const hasQueued = (db: Db): boolean => db.select({ id: runs.id }).from(runs).where(eq(runs.status, "queued")).limit(1).get() !== undefined;

/**
 * Si `run` puede tomar prestado el sujeto de su dueña `owner`: es de dev, está estacionada y no tiene ya
 * otro préstamo. Solo el carril de mantenimiento pide prestado; una corrida de dev espera.
 */
function lendable(db: Db, run: Pick<RunRow, "lane">, owner: RunRow): boolean {
  return run.lane === "maintenance" && owner.lane === "dev" && owner.status === "parked" && !loanOf(db, owner.id);
}

/** El PR que `runId` (o la corrida raíz de la que es subflujo) toma como sujeto además del suyo. */
export function claimPr(tx: Tx, runId: RunId, prId: string): void {
  let run = tx.db.select().from(runs).where(eq(runs.id, runId)).get();
  while (run?.parentRunId) run = tx.db.select().from(runs).where(eq(runs.id, run.parentRunId)).get();
  if (run?.writes) tx.db.update(runs).set({ claimedPrId: prId }).where(eq(runs.id, run.id)).run();
}

export function createSubjects({ handOverWorkspaces }: SubjectsDeps) {
  /** Una corrida que no escribe (`effects: "local"`) o es hija de otra hereda el sujeto y nunca espera. */
  function admit(db: Db, run: Pick<RunRow, "subjectType" | "subjectId" | "lane" | "writes" | "parentRunId">): Admission {
    if (!run.writes || run.parentRunId !== null) return { status: "running" };
    const owner = ownerOf(db, { type: run.subjectType, id: run.subjectId });
    if (!owner) return { status: "running" };
    return lendable(db, run, owner) ? { status: "running", lender: owner } : { status: "queued" };
  }

  /** `run` ya quedó con `borrowed_from_run_id`: pasa el worktree de `lender` y lo anota en la línea de tiempo. */
  function lend(tx: Tx, run: RunRow, lender: RunRow): void {
    handOverWorkspaces?.(tx, lender.id, run.id);
    tx.emit({ type: "run.borrowed", origin: "core", ...scopeOf(run), payload: { runId: run.id, fromRunId: lender.id } });
  }

  /** Las corridas que esperaban un sujeto y ya lo tienen libre (o prestable) pasan a correr, las más antiguas primero. */
  function promoteQueued(tx: Tx): void {
    const waiting = tx.db.select().from(runs).where(eq(runs.status, "queued")).orderBy(asc(runs.id)).all();
    for (const run of waiting) {
      const owner = ownerOf(tx.db, { type: run.subjectType, id: run.subjectId });
      if (owner && !lendable(tx.db, run, owner)) continue;
      tx.db
        .update(runs)
        .set({ status: "running", borrowedFromRunId: owner?.id ?? null })
        .where(eq(runs.id, run.id))
        .run();
      tx.emit({ type: "run.status", origin: "core", ...scopeOf(run), payload: { from: "queued", to: "running" } });
      if (owner) lend(tx, run, owner);
    }
  }

  /**
   * `run` terminó (ya con su estado final) y todavía no emitió `run.finished`: si tenía un sujeto prestado
   * lo devuelve junto con el worktree (antes de `run.finished`, para que el worktree no se suelte con ella); si
   * era la dueña de un préstamo vivo, el préstamo pasa a ser la dueña; y las corridas que esperaban toman lo que quedó libre.
   */
  function ended(tx: Tx, run: RunRow): void {
    if (run.borrowedFromRunId !== null) giveBack(tx, run, run.borrowedFromRunId);
    tx.db
      .update(runs)
      .set({ borrowedFromRunId: null })
      .where(and(eq(runs.borrowedFromRunId, run.id), inArray(runs.status, HOLDING)))
      .run();
    promoteQueued(tx);
  }

  function giveBack(tx: Tx, borrower: RunRow, lenderId: RunId): void {
    handOverWorkspaces?.(tx, borrower.id, lenderId);
    tx.emit({ type: "run.returned", origin: "core", ...scopeOf(borrower), payload: { runId: borrower.id, fromRunId: lenderId } });
    // Si su decisión se resolvió durante el préstamo, la dueña esperaba justo esto: vuelve a la cola de su carril.
    const lender = tx.db.select().from(runs).where(eq(runs.id, lenderId)).get();
    if (lender?.status !== "parked" || pendingBlocking(tx.db, lender.id)) return;
    const resolved = tx.db
      .select({ id: decisions.id })
      .from(decisions)
      .where(and(eq(decisions.runId, lender.id), inArray(decisions.kind, ["gate", "needs_human"])))
      .orderBy(desc(decisions.id))
      .get();
    tx.db.update(runs).set({ status: "running", parkReason: null }).where(eq(runs.id, lender.id)).run();
    tx.emit({ type: "run.requeued", origin: "core", ...scopeOf(lender), payload: { decisionId: resolved?.id, reason: lender.parkReason } });
  }

  return { admit, lend, promoteQueued, ended };
}

/** Si la corrida tiene una decisión bloqueante (gate o needs_human) abierta. */
function pendingBlocking(db: Db, runId: RunId): boolean {
  return (
    db
      .select({ id: decisions.id })
      .from(decisions)
      .where(and(eq(decisions.runId, runId), eq(decisions.status, "pending"), inArray(decisions.kind, ["gate", "needs_human"])))
      .get() !== undefined
  );
}

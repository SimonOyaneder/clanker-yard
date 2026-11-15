import type { RunId, SubjectRef } from "@clanker/api";
import { and, desc, eq, inArray, isNull, notExists, or } from "drizzle-orm";
import { decisions, runs } from "../store/schema";
import type { Store, Tx } from "../store/store";
import { hasRoom, type LaneCapacity } from "./lanes";

// Una sola corrida dueña que escribe por sujeto (`docs/design.html#d-flows`, decisiones 3 y 9). El
// sujeto de una corrida es el suyo (`subject_*`) y, si es de una issue que ya publicó su PR, también
// ese PR (`claimed_pr_id`). Una corrida nueva sobre un sujeto ocupado queda `queued`: espera a la
// dueña, no a un slot. Si la dueña es de dev y está `parked`, el carril de mantenimiento le pide
// prestado el sujeto y el worktree (`borrowed_from_run_id`) y se los devuelve al terminar. Una corrida
// también espera cupo en su carril (`lanes.ts`): nueva, queda `queued`; estacionada cuya decisión ya se
// resolvió, sigue `parked` sin decisión abierta hasta que haya cupo (así conserva su sujeto).

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
  /** La capacidad de cada carril, leída en cada decisión para que `system.setLanes` valga al instante. Sin ella ningún carril tiene tope. */
  laneCapacity?: () => LaneCapacity;
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

/**
 * Las corridas estacionadas cuya decisión bloqueante ya se resolvió: esperan que su sujeto vuelva o que
 * haya cupo en su carril, y `promoteQueued` las devuelve a `running`.
 */
const resumableParked = (db: Db): RunRow[] =>
  db
    .select()
    .from(runs)
    .where(
      and(
        eq(runs.status, "parked"),
        notExists(
          db
            .select({ id: decisions.id })
            .from(decisions)
            .where(and(eq(decisions.runId, runs.id), eq(decisions.status, "pending"), inArray(decisions.kind, ["gate", "needs_human"]))),
        ),
      ),
    )
    .all();

/** Si hay corridas que esperan sujeto o cupo (`promoteQueued` tiene algo que revisar). */
export const hasWaiting = (db: Db): boolean =>
  db.select({ id: runs.id }).from(runs).where(eq(runs.status, "queued")).limit(1).get() !== undefined || resumableParked(db).length > 0;

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

export function createSubjects({ handOverWorkspaces, laneCapacity }: SubjectsDeps) {
  /** Si el carril de `run` tiene un cupo libre (`lanes.ts`). */
  const hasLaneRoom = (db: Db, run: Pick<RunRow, "lane" | "projectId">): boolean => laneCapacity === undefined || hasRoom(db, laneCapacity(), run);

  /**
   * Una corrida hija de otra hereda el sujeto y el cupo de su raíz, y nunca espera. Una que no escribe
   * (`effects: "local"`) no espera un sujeto, pero sí un cupo.
   */
  function admit(db: Db, run: Pick<RunRow, "subjectType" | "subjectId" | "lane" | "writes" | "parentRunId" | "projectId">): Admission {
    if (run.parentRunId !== null) return { status: "running" };
    const owner = run.writes ? ownerOf(db, { type: run.subjectType, id: run.subjectId }) : undefined;
    const borrows = owner !== undefined && lendable(db, run, owner);
    if ((owner && !borrows) || !hasLaneRoom(db, run)) return { status: "queued" };
    return borrows ? { status: "running", lender: owner } : { status: "running" };
  }

  /** `run` ya quedó con `borrowed_from_run_id`: pasa el worktree de `lender` y lo anota en la línea de tiempo. */
  function lend(tx: Tx, run: RunRow, lender: RunRow): void {
    handOverWorkspaces?.(tx, lender.id, run.id);
    tx.emit({ type: "run.borrowed", origin: "core", ...scopeOf(run), payload: { runId: run.id, fromRunId: lender.id } });
  }

  /**
   * Las corridas que esperaban un sujeto o un cupo y ya lo tienen pasan a correr: primero las del carril de
   * mantenimiento (que nunca espera al dev) y, dentro de cada carril, las más antiguas, así una corrida
   * que vuelve de estacionada va antes que una nueva.
   */
  function promoteQueued(tx: Tx): void {
    const waiting = [...tx.db.select().from(runs).where(eq(runs.status, "queued")).all(), ...resumableParked(tx.db)].sort(
      (a, b) => Number(b.lane === "maintenance") - Number(a.lane === "maintenance") || a.id.localeCompare(b.id),
    );
    for (const run of waiting) {
      if (run.status === "parked") resume(tx, run);
      else start(tx, run);
    }
  }

  /** Una corrida `queued` pasa a correr si su sujeto está libre (o prestable) y su carril tiene cupo. */
  function start(tx: Tx, run: RunRow): void {
    const owner = run.writes ? ownerOf(tx.db, { type: run.subjectType, id: run.subjectId }) : undefined;
    if (owner && !lendable(tx.db, run, owner)) return;
    if (!hasLaneRoom(tx.db, run)) return;
    tx.db
      .update(runs)
      .set({ status: "running", borrowedFromRunId: owner?.id ?? null })
      .where(eq(runs.id, run.id))
      .run();
    tx.emit({ type: "run.status", origin: "core", ...scopeOf(run), payload: { from: "queued", to: "running" } });
    if (owner) lend(tx, run, owner);
  }

  /**
   * Una corrida estacionada con la decisión ya resuelta vuelve a la cola de su carril (`run.requeued`) en cuanto
   * su sujeto no está prestado y hay cupo.
   */
  function resume(tx: Tx, run: RunRow): void {
    if (loanOf(tx.db, run.id) || !hasLaneRoom(tx.db, run)) return;
    const resolved = tx.db
      .select({ id: decisions.id })
      .from(decisions)
      .where(and(eq(decisions.runId, run.id), inArray(decisions.kind, ["gate", "needs_human"])))
      .orderBy(desc(decisions.id))
      .get();
    tx.db.update(runs).set({ status: "running", parkReason: null }).where(eq(runs.id, run.id)).run();
    tx.emit({ type: "run.requeued", origin: "core", ...scopeOf(run), payload: { decisionId: resolved?.id, reason: run.parkReason } });
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

  /** `borrower` devuelve el worktree; la dueña, si su decisión se resolvió mientras tanto, la retoma `promoteQueued`. */
  function giveBack(tx: Tx, borrower: RunRow, lenderId: RunId): void {
    handOverWorkspaces?.(tx, borrower.id, lenderId);
    tx.emit({ type: "run.returned", origin: "core", ...scopeOf(borrower), payload: { runId: borrower.id, fromRunId: lenderId } });
  }

  return { admit, lend, promoteQueued, ended, hasLaneRoom };
}

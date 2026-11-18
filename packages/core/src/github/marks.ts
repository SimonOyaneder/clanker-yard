import type { EventType, RunId } from "@clanker/api";
import { and, desc, eq } from "drizzle-orm";
import type { PrRow } from "./pr-cache";
import { runs, watchMarks } from "../store/schema";
import type { StoreDb, Tx } from "../store/store";

// `watch_marks`: insertar es emitir (`docs/design.html#d-ops`, "Watch: eventos y qué disparan").

/** Los eventos de un PR que Watch emite; el `kind` de su marca es el tipo del evento. */
export type PrEventType = Extract<
  EventType,
  | "pr.botReview"
  | "pr.ci"
  | "pr.conflict"
  | "pr.baseConflict"
  | "pr.comment"
  | "pr.merged"
  | "pr.base_rewritten"
  | "pr.human"
  | "pr.approvedWithComments"
  | "pr.mergeReady"
  | "pr.mergeFailed"
>;

/** La marca que no es un evento: la punta que Watch ya evaluó de un PR. */
const HEAD = "head";
/** Las marcas de `approvalEpoch`: estuvo aprobado en la época `n`, y dejó de estarlo. */
const APPROVED = "approved";
const UNAPPROVED = "unapproved";

/** Inserta las marcas que faltan. Devuelve las claves nuevas, en el orden recibido. */
export function recordMarks(tx: Tx, prId: string, kind: string, keys: readonly string[], at: number): string[] {
  return keys.filter(
    (key) => tx.db.insert(watchMarks).values({ prId, kind, key, createdAt: at }).onConflictDoNothing().returning({ id: watchMarks.id }).get() !== undefined,
  );
}

/** La última punta que Watch evaluó de un PR; `undefined` si nunca lo había visto. */
export function lastEvaluatedHead(db: StoreDb, prId: string): string | undefined {
  return db
    .select({ key: watchMarks.key })
    .from(watchMarks)
    .where(and(eq(watchMarks.prId, prId), eq(watchMarks.kind, HEAD)))
    .orderBy(desc(watchMarks.id))
    .get()?.key;
}

export const markHead = (tx: Tx, prId: string, sha: string, at: number) => recordMarks(tx, prId, HEAD, [sha], at);

/**
 * La aprobación de hoy del PR, numerada: sube cada vez que el PR la perdía (pidieron cambios, la
 * descartaron) y se vuelve a aprobar, que es cuando un aprobado con comentarios es otro hecho. Se llama en cada evaluación de
 * un PR abierto, con si hoy está aprobado.
 */
export function approvalEpoch(tx: Tx, prId: string, approved: boolean, at: number): number {
  const marks = (kind: string) => tx.db.select({ key: watchMarks.key }).from(watchMarks).where(and(eq(watchMarks.prId, prId), eq(watchMarks.kind, kind))).all();
  const epoch = marks(UNAPPROVED).length;
  if (approved) recordMarks(tx, prId, APPROVED, [String(epoch)], at);
  else if (marks(APPROVED).some(({ key }) => key === String(epoch))) recordMarks(tx, prId, UNAPPROVED, [String(epoch)], at);
  return epoch;
}

export interface PrEventInput {
  type: PrEventType;
  /** Las claves de dedupe de lo que este evento anuncia; una marca nueva basta para emitir. */
  keys: readonly string[];
  /** El payload según las claves que de verdad eran nuevas. */
  payload(fresh: string[]): Record<string, unknown>;
  /** La corrida que lo provoca, si la hay (el restack). */
  runId?: RunId;
  /**
   * Emite también en la primera lectura del PR, que por defecto solo siembra las marcas: lo que sigue
   * pendiente aunque el PR exista desde antes (conflicto, council, merge, aprobado con comentarios). Los
   * comentarios de humanos (`pr.human`) y lo ya mergeado se siembran callados: ya pasaron.
   */
  emitOnFirstRead?: boolean;
}

/**
 * Anota las claves del evento y, si alguna era nueva, lo emite sobre el PR (con el proyecto de la corrida
 * que lo abrió). Devuelve las claves nuevas: vacío significa que el evento ya había salido.
 */
export function emitOnce(tx: Tx, pr: PrRow, { type, keys, payload, runId }: PrEventInput, at: number): string[] {
  const fresh = recordMarks(tx, pr.id, type, keys, at);
  if (fresh.length === 0) return fresh;
  const projectId = pr.runId ? tx.db.select({ id: runs.projectId }).from(runs).where(eq(runs.id, pr.runId)).get()?.id : undefined;
  tx.emit({
    type,
    origin: "watch",
    ...(projectId && { projectId }),
    ...(runId && { runId }),
    subject: { type: "pr", id: pr.id },
    payload: payload(fresh),
  });
  return fresh;
}

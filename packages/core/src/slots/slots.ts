import { setTimeout as sleep } from "node:timers/promises";
import type { Lane, RunId } from "@clanker/api";
import { and, eq, isNotNull, isNull, lt, or, sql } from "drizzle-orm";
import { slots } from "../store/schema";
import type { Store, Tx } from "../store/store";
import { LEASE_TTL_MS, StaleLeaseError } from "../workspaces/workspaces";

/** Cuánto espera `acquire` antes de volver a mirar si se liberó un slot de su pool. */
const RETRY_MS = 1000;

/** Tamaño de cada pool: `dev` usa los slots 1..dev y `maintenance` los dev+1..dev+maintenance. */
export interface SlotPools {
  dev: number;
  maintenance: number;
}

export interface SlotRequest {
  repoId: string;
  /** De qué pool sale el slot: el mantenimiento nunca usa ni espera slots de dev. */
  lane: Lane;
  /** Quién lo tiene. `repos.testRecipe` no es una corrida y pasa un id propio. */
  runId: RunId;
  pools: SlotPools;
  /** Se prefiere el slot que este worktree ya preparó, para no repetir `setup.slot`. */
  workspaceId?: string;
}

/** Un slot tomado. Lo que dice de su preparación decide si hay que correr `setup.slot`. */
export interface SlotLease {
  repoId: string;
  idx: number;
  lane: Lane;
  runId: RunId;
  fencingToken: number;
  /** El worktree que lo preparó; `null` si nunca se preparó o su estado ya no se sabe. */
  workspaceId: string | null;
  /** El hash de `setup.slotKey` con el que se preparó. */
  setupHash: string | null;
  /** Un `setup.slot` anterior se cortó a medias. */
  dirty: boolean;
  /** Se aborta si el lease se perdió: quien corre con el slot debe detenerse. */
  lost: AbortSignal;
}

export interface SlotPrepared {
  workspaceId: string | null;
  setupHash: string | null;
  /** El entorno de la receta para este slot, ya renderizado. */
  env: Record<string, string>;
}

export interface Slots {
  /** Toma un slot libre del pool de `lane`, o `undefined` si ese pool está lleno. Otro pool no cuenta. */
  tryAcquire(request: SlotRequest): SlotLease | undefined;
  /** Como `tryAcquire`, pero espera a que se libere uno; abortar `signal` lanza su razón. */
  acquire(request: SlotRequest, signal?: AbortSignal): Promise<SlotLease>;
  /** `setup.slot` va a empezar: hasta `finishSetup` el slot queda `dirty`. */
  startSetup(lease: SlotLease): void;
  /** `setup.slot` terminó bien: el slot queda limpio y preparado así. */
  finishSetup(lease: SlotLease, prepared: SlotPrepared): void;
  /** Suelta el slot. No hace nada si el token ya no es el vigente. */
  release(lease: SlotLease): void;
  /**
   * Al bootear: ningún slot tiene dueño vivo (el core que los tenía murió), así que se sueltan todos.
   * Los pasos que se reabren toman el suyo de nuevo. Devuelve cuántos soltó.
   */
  recover(): number;
  /** Renueva ya los leases que este core mantiene (el reloj saltó). */
  extendLeases(): void;
}

export interface SlotsOptions {
  store: Store;
  leaseTtlMs?: number;
  retryMs?: number;
  now?: () => number;
}

export function createSlots({ store, leaseTtlMs = LEASE_TTL_MS, retryMs = RETRY_MS, now = Date.now }: SlotsOptions): Slots {
  const heartbeats = new Map<string, { timer: NodeJS.Timeout; lease: SlotLease }>();
  const beatKey = (l: Pick<SlotLease, "repoId" | "idx" | "fencingToken">) => `${l.repoId}:${l.idx}:${l.fencingToken}`;

  const mine = (l: Pick<SlotLease, "repoId" | "idx" | "fencingToken">) =>
    and(eq(slots.repoId, l.repoId), eq(slots.idx, l.idx), eq(slots.fencingToken, l.fencingToken));

  const slotId = (repoId: string, idx: number) => `${repoId}#${idx}`;

  /** Crea los slots que faltan y deja cada uno libre en el pool que dicen los tamaños; sobrantes libres se borran. */
  function syncPools({ db }: Tx, repoId: string, pools: SlotPools) {
    const t = now();
    const free = or(isNull(slots.holderRunId), lt(slots.leaseUntil, t));
    const total = pools.dev + pools.maintenance;
    for (let idx = 1; idx <= total; idx++) {
      const reservedFor: Lane = idx <= pools.dev ? "dev" : "maintenance";
      db.insert(slots)
        .values({ repoId, idx, env: {}, reservedFor, fencingToken: 0 })
        .onConflictDoUpdate({
          target: [slots.repoId, slots.idx],
          set: { reservedFor },
          setWhere: and(sql`${slots.reservedFor} != ${reservedFor}`, free),
        })
        .run();
    }
    db.delete(slots).where(and(eq(slots.repoId, repoId), sql`${slots.idx} > ${total}`, free)).run();
  }

  function tryAcquire({ repoId, lane, runId, pools, workspaceId }: SlotRequest): SlotLease | undefined {
    const claimed = store.tx((tx) => {
      syncPools(tx, repoId, pools);
      const t = now();
      const candidates = tx.db
        .select()
        .from(slots)
        .where(
          and(
            eq(slots.repoId, repoId),
            eq(slots.reservedFor, lane),
            sql`${slots.idx} <= ${pools.dev + pools.maintenance}`,
            or(isNull(slots.holderRunId), lt(slots.leaseUntil, t)),
          ),
        )
        .orderBy(slots.idx)
        .all();
      const prepared = (row: (typeof candidates)[number]) => workspaceId !== undefined && row.workspaceId === workspaceId;
      const row = candidates.find(prepared) ?? candidates[0];
      if (!row) return undefined;

      const taken = tx.db
        .update(slots)
        .set({ holderRunId: runId, leaseUntil: t + leaseTtlMs, fencingToken: sql`${slots.fencingToken} + 1` })
        .where(and(eq(slots.repoId, repoId), eq(slots.idx, row.idx)))
        .returning()
        .get()!;
      if (row.holderRunId) {
        tx.emit({
          type: "lease.expired",
          origin: "core",
          runId: row.holderRunId,
          payload: { resource: "slot", id: slotId(repoId, row.idx), runId: row.holderRunId, token: row.fencingToken },
        });
      }
      tx.emit({
        type: "lease.acquired",
        origin: "core",
        runId,
        payload: { resource: "slot", id: slotId(repoId, row.idx), runId, token: taken.fencingToken },
      });
      return taken;
    });
    if (!claimed) return undefined;

    const lost = new AbortController();
    const lease: SlotLease = {
      repoId,
      idx: claimed.idx,
      lane,
      runId,
      fencingToken: claimed.fencingToken,
      workspaceId: claimed.workspaceId,
      setupHash: claimed.setupHash,
      dirty: claimed.dirty,
      lost: lost.signal,
    };
    startHeartbeat(lease, lost);
    return lease;
  }

  function renew(lease: SlotLease): boolean {
    return (
      store.tx(({ db }) =>
        db
          .update(slots)
          .set({ leaseUntil: now() + leaseTtlMs })
          .where(and(mine(lease), eq(slots.holderRunId, lease.runId)))
          .returning({ idx: slots.idx })
          .get(),
      ) !== undefined
    );
  }

  function startHeartbeat(lease: SlotLease, lost: AbortController) {
    const timer = setInterval(() => {
      try {
        if (renew(lease)) return;
        lost.abort();
      } catch (error) {
        // Un throw desde el timer tumbaría el proceso (la base ya cerrada al apagar): sin renovar, el lease se perdió.
        lost.abort(error);
      }
      stopHeartbeat(lease);
    }, leaseTtlMs / 3);
    timer.unref();
    heartbeats.set(beatKey(lease), { timer, lease });
  }

  function stopHeartbeat(lease: SlotLease) {
    clearInterval(heartbeats.get(beatKey(lease))?.timer);
    heartbeats.delete(beatKey(lease));
  }

  function update(lease: SlotLease, set: Partial<typeof slots.$inferInsert>) {
    const updated = store.tx(({ db }) => db.update(slots).set(set).where(mine(lease)).returning({ idx: slots.idx }).get());
    if (!updated) {
      throw new StaleLeaseError(
        `El lease del slot ${lease.idx} de ${lease.repoId} (token ${lease.fencingToken}) ya no es el vigente: ` +
          "otra corrida lo tomó. No se tocó nada.",
      );
    }
  }

  return {
    tryAcquire,
    async acquire(request, signal) {
      for (;;) {
        signal?.throwIfAborted();
        const lease = tryAcquire(request);
        if (lease) return lease;
        await sleep(retryMs, undefined, { signal }).catch(() => undefined);
      }
    },
    startSetup(lease) {
      update(lease, { dirty: true });
    },
    finishSetup(lease, { workspaceId, setupHash, env }) {
      update(lease, { dirty: false, workspaceId, setupHash, env });
    },
    release(lease) {
      stopHeartbeat(lease);
      store.tx(({ db, emit }) => {
        const released = db
          .update(slots)
          .set({ holderRunId: null, leaseUntil: null })
          .where(mine(lease))
          .returning({ idx: slots.idx })
          .get();
        if (released) {
          emit({
            type: "lease.released",
            origin: "core",
            runId: lease.runId,
            payload: { resource: "slot", id: slotId(lease.repoId, lease.idx), token: lease.fencingToken },
          });
        }
      });
    },
    recover() {
      return store.tx(({ db, emit }) => {
        const held = db.select().from(slots).where(isNotNull(slots.holderRunId)).all();
        db.update(slots).set({ holderRunId: null, leaseUntil: null }).where(isNotNull(slots.holderRunId)).run();
        for (const row of held) {
          emit({
            type: "lease.expired",
            origin: "core",
            runId: row.holderRunId!,
            payload: { resource: "slot", id: slotId(row.repoId, row.idx), runId: row.holderRunId, token: row.fencingToken },
          });
        }
        return held.length;
      });
    },
    extendLeases() {
      for (const { lease } of heartbeats.values()) renew(lease);
    },
  };
}

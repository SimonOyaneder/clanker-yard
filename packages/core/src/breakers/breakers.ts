import type { DecisionId } from "@clanker/api";
import { eq } from "drizzle-orm";
import { closeDecision, openDecision } from "../decisions/decisions";
import { meta } from "../store/schema";
import type { Store, Tx } from "../store/store";

// Circuit breakers por causa (`docs/design.html#d-ops`, "Circuit breaker por causa"): un error de entorno
// abre el breaker de su ámbito y solo eso se pausa. Se reintenta con una prueba barata y se cierra solo.

export const GITHUB_SCOPE = "github";
export const repoScope = (repoId: string): string => `repo:${repoId}`;
export const runtimeScope = (runtime: string): string => `runtime:${runtime}`;

/** Por qué se abrió, para la alerta y para quien lea el evento. */
export type BreakerCause = "quota_exhausted" | "login_expired" | "connection_lost" | "rate_limited" | "environment";

/** Los minutos entre una prueba y la siguiente: 1, 5, 15 y 30, y después cada 30. */
const BACKOFF_MS = [1, 5, 15, 30].map((minutes) => minutes * 60_000);

/** `setTimeout` no acepta más que esto; un reset más lejano se re-agenda al despertar. */
const MAX_TIMER_MS = 2 ** 31 - 1;

const META_KEY = "breakers";

export interface OpenBreaker {
  scope: string;
  cause: BreakerCause;
  reason: string;
  /** ms epoch */
  openedAt: number;
  /** Las pruebas que fallaron desde que abrió. */
  probes: number;
  /** ms epoch de la próxima prueba. */
  nextProbeAt: number;
  /** La alerta de la bandeja, que se cierra con el breaker. */
  decisionId: DecisionId;
}

export interface Breakers {
  /** Por qué está abierto el breaker de `scope`, o `undefined` si no lo está. */
  open(scope: string): string | undefined;
  /**
   * Abre el breaker de `scope` (`breaker.opened` y una alerta en la bandeja). Con `resetsAt` (la cuota se
   * reinicia a esa hora) la primera prueba es ahí; si no, al minuto. Si ya estaba abierto no hace nada:
   * el backoff sigue donde iba.
   */
  trip(input: { scope: string; cause: BreakerCause; reason: string; resetsAt?: number }): void;
  list(): OpenBreaker[];
  /** Retoma los breakers que dejó un corte y empieza a escuchar las conexiones y la cuota de GitHub. */
  start(): void;
  close(): void;
}

export interface BreakersOptions {
  store: Store;
  /** El runtime con que corren los agentes: la conexión de Claude solo abre su breaker si es `claude-sdk`. */
  runtime: string;
  /**
   * La prueba barata de un ámbito: `undefined` si la causa se fue, o por qué sigue. Si lanza cuenta como
   * fallida. Una prueba que reconecta o prueba cosas puede emitir eventos: mientras corre se ignoran los de su ámbito.
   */
  probe(scope: string): Promise<string | undefined>;
  /** El nombre legible de un ámbito para la alerta (por defecto el propio ámbito). */
  label?(scope: string): string;
  now?: () => number;
}

export function createBreakers({ store, runtime, probe, label = (scope) => scope, now = Date.now }: BreakersOptions): Breakers {
  const entries = new Map<string, OpenBreaker>();
  const timers = new Map<string, NodeJS.Timeout>();
  const probing = new Set<string>();
  let unsubscribe: (() => void) | undefined;
  let closed = false;

  /** La conexión de la que depende cada ámbito global. */
  const scopeOfProvider = (provider: unknown): string | undefined =>
    provider === "github" ? GITHUB_SCOPE : provider === "claude" && runtime === "claude-sdk" ? runtimeScope(runtime) : undefined;

  /** Guarda lo que sobrevive a un corte, en la misma transacción que el cambio. */
  function persist(tx: Tx): void {
    const value = JSON.stringify([...entries.values()]);
    tx.db.insert(meta).values({ key: META_KEY, value }).onConflictDoUpdate({ target: meta.key, set: { value } }).run();
  }

  function schedule(entry: OpenBreaker): void {
    clearTimeout(timers.get(entry.scope));
    if (closed) return;
    const delay = Math.min(Math.max(entry.nextProbeAt - now(), 0), MAX_TIMER_MS);
    // Un callback de timer nunca lanza: tumbaría el core.
    const timer = setTimeout(() => {
      timers.delete(entry.scope);
      if (now() < entry.nextProbeAt) return schedule(entry);
      void attempt(entry.scope);
    }, delay);
    timer.unref();
    timers.set(entry.scope, timer);
  }

  async function attempt(scope: string): Promise<void> {
    if (probing.has(scope) || !entries.has(scope)) return;
    probing.add(scope);
    let failure: string | undefined;
    try {
      failure = await probe(scope);
    } catch (error) {
      failure = error instanceof Error ? error.message : String(error);
    } finally {
      probing.delete(scope);
    }
    const entry = entries.get(scope);
    if (!entry || closed) return;
    try {
      if (failure === undefined) return shut(entry);
      entry.probes++;
      entry.reason = failure;
      entry.nextProbeAt = now() + BACKOFF_MS[Math.min(entry.probes, BACKOFF_MS.length - 1)]!;
      store.tx((tx) => persist(tx));
      schedule(entry);
    } catch (error) {
      store.tx((tx) => tx.emit({ type: "error", origin: "core", payload: { scope: "breakers.probe", message: `${scope}: ${String(error)}` } }));
      schedule(entry);
    }
  }

  function shut(entry: OpenBreaker): void {
    clearTimeout(timers.get(entry.scope));
    timers.delete(entry.scope);
    entries.delete(entry.scope);
    store.tx((tx) => {
      tx.emit({
        type: "breaker.closed",
        origin: "core",
        payload: { scope: entry.scope, cause: entry.cause, openedAt: entry.openedAt, probes: entry.probes },
      });
      closeDecision(tx, entry.decisionId, { status: "superseded", by: "core" });
      persist(tx);
    });
  }

  function trip({ scope, cause, reason, resetsAt }: { scope: string; cause: BreakerCause; reason: string; resetsAt?: number }): void {
    if (entries.has(scope) || closed) return;
    const at = now();
    const nextProbeAt = resetsAt !== undefined && resetsAt > at ? resetsAt : at + BACKOFF_MS[0]!;
    store.tx((tx) => {
      const decision = openDecision(tx, {
        kind: "alert",
        title: `Pausado: ${label(scope)}`,
        body:
          `${reason}\n\nSolo se pausa lo que depende de esto; lo demás sigue. ` +
          `Se vuelve a probar a las ${new Date(nextProbeAt).toISOString()} y se reanuda solo cuando la causa se va.`,
      });
      const entry: OpenBreaker = { scope, cause, reason, openedAt: at, probes: 0, nextProbeAt, decisionId: decision.id };
      // Antes del evento: quien escucha `breaker.opened` ya ve el breaker abierto.
      entries.set(scope, entry);
      tx.emit({ type: "breaker.opened", origin: "core", payload: { scope, cause, reason, retryAt: nextProbeAt } });
      persist(tx);
    });
    schedule(entries.get(scope)!);
  }

  function onEvent({ type, payload }: { type: string; payload: Record<string, unknown> }): void {
    if (type === "sync.rate_limited") {
      const resetAt = typeof payload.resetAt === "number" ? payload.resetAt : undefined;
      trip({
        scope: GITHUB_SCOPE,
        cause: "rate_limited",
        reason: "GitHub cortó las requests por cuota.",
        ...(resetAt === undefined ? {} : { resetsAt: resetAt }),
      });
      return;
    }
    const scope = scopeOfProvider(payload.provider);
    if (scope === undefined) return;
    const { status, account } = payload;
    if (status === "expired" || status === "revoked") {
      trip({ scope, cause: "connection_lost", reason: `La conexión de ${String(payload.provider)} (${String(account)}) quedó ${String(status)}: reconéctala.` });
    } else if (entries.has(scope) && !probing.has(scope)) {
      // Reconectar la causa: se prueba ya, sin esperar al backoff.
      void attempt(scope);
    }
  }

  return {
    open: (scope) => entries.get(scope)?.reason,
    trip,
    list: () => [...entries.values()],

    start() {
      const saved = store.db.select().from(meta).where(eq(meta.key, META_KEY)).get();
      for (const entry of saved ? (JSON.parse(saved.value) as OpenBreaker[]) : []) {
        entries.set(entry.scope, entry);
        schedule(entry);
      }
      unsubscribe = store.events.subscribe(onEvent, { types: ["connection.changed", "sync.rate_limited"] });
    },

    close() {
      closed = true;
      unsubscribe?.();
      for (const timer of timers.values()) clearTimeout(timer);
      timers.clear();
    },
  };
}

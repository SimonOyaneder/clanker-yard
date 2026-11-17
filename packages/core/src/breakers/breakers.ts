import { BreakerCause, DecisionId, RepoId, type ConnectionProvider, type EventOf } from "@clanker/api";
import { CLAUDE_RUNTIME_ID } from "../agents/claude/models";
import { closeDecision, openDecision } from "../decisions/decisions";
import { EnvironmentError } from "../flows/catalog";
import { createErrorReporter, type ErrorReporter } from "../errors/reporter";
import { meta } from "../store/schema";
import { readMetaJson } from "../store/meta-json";
import type { Store, Tx } from "../store/store";
import * as z from "zod";
import { messageOf } from "../errors/format";

// Circuit breakers por causa (`docs/design.html#d-ops`, "Circuit breaker por causa"): un error de entorno
// abre el breaker de su ámbito y solo eso se pausa. Se reintenta con una prueba barata y se cierra solo.

export const GITHUB_SCOPE = "github";
/** El prefijo del ámbito de un repo: `repo:<id>`. */
export const REPO_SCOPE_PREFIX = "repo:";
export const repoScope = (repoId: RepoId): string => `${REPO_SCOPE_PREFIX}${repoId}`;
/** El repo de un ámbito `repo:<id>`, si lo es y el id es válido. */
export function repoOfScope(scope: string): RepoId | undefined {
  if (!scope.startsWith(REPO_SCOPE_PREFIX)) return undefined;
  const parsed = RepoId.safeParse(scope.slice(REPO_SCOPE_PREFIX.length));
  return parsed.success ? parsed.data : undefined;
}
export const runtimeScope = (runtime: string): string => `runtime:${runtime}`;

/**
 * GitHub rechazó el token de `account` al hablar con el remoto (fetch o push). La conexión ya quedó revocada y eso abre
 * el breaker `github`: es un error del entorno, no del paso, así que el paso espera a que se reconecte en vez de fallar.
 * `what` dice para qué hacía falta (`pushear cla-1`, `traer <repo>`).
 */
export function githubUnauthorized(account: string, what: string): EnvironmentError {
  return new EnvironmentError(GITHUB_SCOPE, `GitHub rechazó el token de ${account} al ${what}: la conexión quedó revocada, reconéctala.`);
}

export type { BreakerCause };

/** Los minutos entre una prueba y la siguiente: 1, 5, 15 y 30, y después cada 30. */
const BACKOFF_MS = [1, 5, 15, 30].map((minutes) => minutes * 60_000);

/** `setTimeout` no acepta más que esto; un reset más lejano se re-agenda al despertar. */
const MAX_TIMER_MS = 2 ** 31 - 1;

const META_KEY = "breakers";

/** Lo que se guarda en `meta` de cada breaker abierto, para retomarlo tras un corte. */
const OpenBreakerSchema = z.object({
  scope: z.string(),
  cause: BreakerCause,
  reason: z.string(),
  openedAt: z.number(),
  probes: z.int().nonnegative(),
  nextProbeAt: z.number(),
  decisionId: DecisionId,
});

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
  openReason(scope: string): string | undefined;
  /**
   * Abre el breaker de `scope` (`breaker.opened` y una alerta en la bandeja). Con `resetsAt` (la cuota se
   * reinicia a esa hora) la primera prueba es ahí; si no, al minuto. Si ya estaba abierto no hace nada:
   * el backoff sigue donde iba.
   */
  trip(input: { scope: string; cause: BreakerCause; reason: string; resetsAt?: number }): void;
  /** Los abiertos, con el nombre legible de su ámbito (`label`). */
  list(): (OpenBreaker & { label: string })[];
  /** Retoma los breakers que dejó un corte y empieza a escuchar las conexiones y la cuota de GitHub. */
  start(): void;
  close(): void;
}

export interface BreakersOptions {
  store: Store;
  /** Los runtimes que el core tiene registrados: la conexión de Claude abre el breaker de `claude-sdk` si está entre ellos. */
  runtimes: readonly string[];
  /**
   * La prueba barata de un ámbito: `undefined` si la causa se fue, o por qué sigue. Si lanza cuenta como
   * fallida. Una prueba que reconecta o prueba cosas puede emitir eventos: mientras corre se ignoran los de su ámbito.
   */
  probe(scope: string): Promise<string | undefined>;
  /** El nombre legible de un ámbito para la alerta (por defecto el propio ámbito). */
  label?(scope: string): string;
  now?: () => number;
  /** Los ms entre una prueba y la siguiente, la última repetida; por defecto 1, 5, 15 y 30 min. Un test lo acorta. */
  backoffMs?: readonly number[];
  /** Dónde se anota una prueba que no se pudo registrar; por defecto uno propio sobre `store`. */
  errors?: ErrorReporter;
}

export function createBreakers({ store, runtimes, probe, label = (scope) => scope, now = Date.now, backoffMs = BACKOFF_MS, errors = createErrorReporter(store) }: BreakersOptions): Breakers {
  const entries = new Map<string, OpenBreaker>();
  const timers = new Map<string, NodeJS.Timeout>();
  const probing = new Set<string>();
  let unsubscribe: (() => void) | undefined;
  let closed = false;

  /** La conexión de la que depende cada ámbito global. */
  const scopeOfProvider = (provider: ConnectionProvider): string | undefined =>
    provider === "github" ? GITHUB_SCOPE : provider === "claude" && runtimes.includes(CLAUDE_RUNTIME_ID) ? runtimeScope(CLAUDE_RUNTIME_ID) : undefined;

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
      failure = messageOf(error);
    } finally {
      probing.delete(scope);
    }
    const entry = entries.get(scope);
    if (!entry || closed) return;
    try {
      if (failure === undefined) return shut(entry);
      entry.probes++;
      entry.reason = failure;
      entry.nextProbeAt = now() + backoffMs[Math.min(entry.probes, backoffMs.length - 1)]!;
      store.tx((tx) => persist(tx));
      schedule(entry);
    } catch (error) {
      errors.report(`breakers.probe ${scope}`, error);
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
    const nextProbeAt = resetsAt !== undefined && resetsAt > at ? resetsAt : at + backoffMs[0]!;
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

  function onEvent(event: EventOf<"connection.changed" | "sync.rate_limited">): void {
    if (event.type === "sync.rate_limited") {
      trip({ scope: GITHUB_SCOPE, cause: "rate_limited", reason: "GitHub cortó las requests por cuota.", resetsAt: event.payload.resetAt });
      return;
    }
    const { provider, account, status } = event.payload;
    const scope = scopeOfProvider(provider);
    if (scope === undefined) return;
    if (status === "expired" || status === "revoked") {
      trip({ scope, cause: "connection_lost", reason: `La conexión de ${provider} (${account}) quedó ${status}: reconéctala.` });
    } else if (entries.has(scope) && !probing.has(scope)) {
      // Reconectar la causa: se prueba ya, sin esperar al backoff.
      void attempt(scope);
    }
  }

  return {
    openReason: (scope) => entries.get(scope)?.reason,
    trip,
    list: () => [...entries.values()].map((entry) => ({ ...entry, label: label(entry.scope) })),

    start() {
      for (const entry of readMetaJson(store.db, META_KEY, z.array(OpenBreakerSchema)) ?? []) {
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

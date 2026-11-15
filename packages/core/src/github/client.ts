import { Octokit } from "@octokit/core";
import { RequestError } from "@octokit/request-error";
import type { Store } from "../store/store";
import { syncCursors } from "../store/schema";

/**
 * De dónde sale el token de GitHub. Al core le da lo mismo: en la fase 1 es un PAT pegado en la app
 * y después será el token de una GitHub App.
 */
export interface GitHubTokenSource {
  kind: "pat" | "app";
  token(): Promise<string>;
  /**
   * Consigue un token nuevo cuando GitHub rechaza el actual (el token de una GitHub App vive 8 h).
   * Un PAT no lo tiene: vence en una fecha fija y se rota a mano.
   */
  refresh?(): Promise<void>;
}

/** Dónde hablar con GitHub; en tests, un servidor local. */
export interface GitHubApiOptions {
  baseUrl?: string;
  fetch?: typeof fetch;
}

export interface GitHubClientOptions extends GitHubApiOptions {
  tokens: GitHubTokenSource;
  /** Si viene, la cuota que GitHub informa en cada respuesta queda en `sync_cursors`. */
  quota?: { store: Store; account: string };
}

export type GitHubClient = Octokit;

/** La clave de `sync_cursors` con la cuota de un recurso (`core`, `graphql`, `search`...) de una cuenta. */
export const rateKey = (account: string, resource: string): string => `rate:github:${account}:${resource}`;

/** `true` si GitHub rechazó la request por cuota (primaria o secundaria), no por permisos. */
export function isRateLimited(error: unknown): error is RequestError {
  return error instanceof RequestError && rateLimitReset(error.status, error.response?.headers) !== undefined;
}

/**
 * El único punto por donde sale una request a GitHub. Pone el token de `tokens` en cada una, reintenta
 * una vez con `refresh` si GitHub responde 401 y, con `quota`, registra la cuota en `sync_cursors`
 * y emite `sync.rate_limited` cuando GitHub corta. Las requests de un cliente (una cuenta) salen en
 * serie, nunca en paralelo, como pide GitHub ("Best practices for using the REST API"). El segundo entre
 * escrituras lo guardan las acciones que escriben en ráfaga (`pr-feedback.ts`).
 */
export function createGitHubClient({ tokens, quota, baseUrl, fetch }: GitHubClientOptions): GitHubClient {
  const octokit = new Octokit({ baseUrl, request: { fetch } });
  const inSeries = createSeries();

  octokit.hook.wrap("request", async (request, options) => {
    options.headers.authorization = `bearer ${await tokens.token()}`;
    try {
      return await request(options);
    } catch (error) {
      if (!(error instanceof RequestError) || error.status !== 401 || !tokens.refresh) throw error;
      await tokens.refresh();
      options.headers.authorization = `bearer ${await tokens.token()}`;
      return request(options);
    }
  });

  // Último en registrarse = más externo: el turno cubre también el reintento tras el 401.
  octokit.hook.wrap("request", (request, options) => inSeries(async () => request(options)));

  if (quota) {
    octokit.hook.after("request", (response) => recordQuota(quota, response.status, response.headers, response.data));
    octokit.hook.error("request", (error) => {
      if (error instanceof RequestError && error.response) {
        recordQuota(quota, error.status, error.response.headers);
      }
      throw error;
    });
  }
  return octokit;
}

/** Una cola: cada tarea espera a que termine la anterior, falle o no. */
function createSeries() {
  let tail: Promise<unknown> = Promise.resolve();
  return <T>(task: () => Promise<T>): Promise<T> => {
    const result = tail.then(task);
    tail = result.catch(() => undefined);
    return result;
  };
}

type Headers = Record<string, string | number | undefined>;

function recordQuota(
  { store, account }: { store: Store; account: string },
  status: number,
  headers: Headers,
  body?: unknown,
) {
  const remaining = numberHeader(headers["x-ratelimit-remaining"]);
  const reset = numberHeader(headers["x-ratelimit-reset"]);
  const limit = numberHeader(headers["x-ratelimit-limit"]);
  const limitedUntil = rateLimitReset(status, headers, body);
  if (remaining === undefined && limitedUntil === undefined) return;
  store.tx((tx) => {
    if (remaining !== undefined && reset !== undefined) {
      const key = rateKey(account, String(headers["x-ratelimit-resource"] ?? "core"));
      const values = { checkedAt: Date.now(), rateRemaining: remaining, resetAt: reset * 1000, rateLimit: limit ?? null };
      tx.db
        .insert(syncCursors)
        .values({ key, ...values })
        .onConflictDoUpdate({ target: syncCursors.key, set: values })
        .run();
    }
    if (limitedUntil !== undefined) {
      tx.emit({
        type: "sync.rate_limited",
        origin: "core",
        payload: { provider: "github", account, resetAt: limitedUntil },
      });
    }
  });
}

/**
 * Cuándo se puede volver a pedir (ms epoch) si la respuesta es un corte por cuota, o `undefined`.
 * Un 403/429 con la cuota primaria en 0 espera al reset; uno con `retry-after` es la cuota
 * secundaria y espera esos segundos (docs: "Rate limits for the REST API"). GraphQL responde igual pero
 * también con un 200 y `errors` en el body (docs: "Rate limits and query limits for the GraphQL API"):
 * un 200 con `errors` solo es un corte si trae `retry-after` o la cuota primaria en 0.
 */
function rateLimitReset(status: number, headers: Headers = {}, body?: unknown): number | undefined {
  if (status !== 403 && status !== 429 && !(status === 200 && hasGraphqlErrors(body))) return undefined;
  const retryAfter = numberHeader(headers["retry-after"]);
  if (retryAfter !== undefined) return Date.now() + retryAfter * 1000;
  const reset = numberHeader(headers["x-ratelimit-reset"]);
  if (numberHeader(headers["x-ratelimit-remaining"]) === 0 && reset !== undefined) return reset * 1000;
  return undefined;
}

function hasGraphqlErrors(body: unknown): boolean {
  const errors = (body as { errors?: unknown } | null | undefined)?.errors;
  return Array.isArray(errors) && errors.length > 0;
}

function numberHeader(value: string | number | undefined): number | undefined {
  if (value === undefined || value === "") return undefined;
  const n = Number(value);
  return Number.isFinite(n) ? n : undefined;
}

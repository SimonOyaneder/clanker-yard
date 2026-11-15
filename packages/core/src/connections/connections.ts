import { query as sdkQuery } from "@anthropic-ai/claude-agent-sdk";
import type { ClaudeMode, ClaudeStatus, Connection, ConnectionProvider, Origin } from "@clanker/api";
import { and, asc, eq, ne } from "drizzle-orm";
import { apiKeyCredentials, subscriptionCredentials, type ClaudeCredentials } from "../agents/claude/credentials";
import type { QueryFn } from "../agents/claude/claude-runtime";
import { probeClaude, type ExecFn } from "../agents/claude/probe";
import { createGitHubClient, type GitHubApiOptions, type GitHubClient } from "../github/client";
import { validatePat } from "../github/pat";
import { startLinearLogin } from "../linear/login";
import {
  fetchWorkspaceKey,
  LINEAR_ENDPOINTS,
  LINEAR_REFRESH_TTL_MS,
  LinearAuthError,
  LinearSession,
  refreshTokens,
  type LinearEndpoints,
  type LinearTokens,
} from "../linear/oauth";
import type { Secrets } from "../secrets/secrets";
import { connections } from "../store/schema";
import type { Store } from "../store/store";

export interface ConnectInput {
  provider: ConnectionProvider;
  account: string;
  scopes: string[];
  token: string;
  /** ms epoch; omítelo si el token no vence. */
  expiresAt?: number;
}

/** Con cuántos días de margen una conexión avisa que su token está por vencer. */
export const EXPIRY_WARNING_DAYS = 7;
const EXPIRY_WARNING_MS = EXPIRY_WARNING_DAYS * 24 * 60 * 60 * 1000;

/** Puerto del loopback que recibe el redirect de Linear; el redirect URI de la OAuth app lo incluye. */
export const LINEAR_REDIRECT_PORT = 48721;
/** Cuánto espera `linearAuth` a que el usuario apruebe en el navegador. */
export const LINEAR_LOGIN_TIMEOUT_MS = 5 * 60 * 1000;
/** Un access token de Linear con menos margen que este se refresca antes de entregarse. */
export const LINEAR_REFRESH_MARGIN_MS = 5 * 60 * 1000;

export interface LinearOptions {
  /** El client_id de la OAuth app de Linear. Sin él `linearAuth` no puede iniciar. */
  clientId?: string;
  /** Default `LINEAR_REDIRECT_PORT`; 0 elige un puerto libre (tests). */
  redirectPort?: number;
  loginTimeoutMs?: number;
  /** Dónde está Linear; en tests, un servidor local. */
  endpoints?: LinearEndpoints;
}

/** Lo que `linearAuth` le da a quien lo llama: el link para el navegador y el aviso de que terminó. */
export interface LinearLogin {
  url: string;
  /** La cuenta conectada, o `LinearAuthError` si el usuario no aprobó, venció el plazo o se canceló. */
  done: Promise<Connection>;
}

/** Lo que `probeClaude` y `claudeCredentials` usan del sistema; en tests, stubs. */
export interface ClaudeOptions {
  /** Default `process.env`: de aquí salen el `PATH` donde buscar `claude` y lo que hereda su entorno. */
  baseEnv?: Record<string, string | undefined>;
  /** Default el `query` del Agent SDK. */
  query?: QueryFn;
  /** Default `execFile`: corre `claude --version` y `claude auth status`. */
  exec?: ExecFn;
}

/** El modo `api-key` de Claude se guarda con esta cuenta y su clave en `Secrets`; la suscripción no guarda nada. */
const CLAUDE_API_KEY_ACCOUNT = "api-key" satisfies ClaudeMode;

/** Claude no está listo para conectarse (pidió probar una API key que no hay, o Anthropic la rechazó). */
export class ClaudeSetupError extends Error {}

export interface ConnectionsOptions {
  /** Dónde está GitHub; en tests, un servidor local. */
  github?: GitHubApiOptions;
  linear?: LinearOptions;
  claude?: ClaudeOptions;
  /** Reloj en ms epoch, para el vencimiento. */
  now?: () => number;
}

export interface Connections {
  /**
   * Guarda el token en `Secrets` y la cuenta en la base. Si la cuenta ya estaba conectada, reemplaza
   * token, scopes y vencimiento y la deja `active`. Emite `connection.changed`. Linear no entra por
   * aquí: su token rota y se conecta con `linearAuth`.
   */
  connect(input: ConnectInput, origin: Origin): Promise<Connection>;
  /**
   * Valida un fine-grained PAT de GitHub y lo conecta con la cuenta a la que pertenece (`GitHubPatError`
   * si no sirve, sin guardar nada). Los permisos verificados quedan como `scopes`. Emite
   * `connection.changed`.
   */
  setPat(token: string, origin: Origin): Promise<Connection>;
  /**
   * Inicia el login de Linear con OAuth y PKCE: levanta el loopback del redirect y devuelve el `url` que
   * el usuario abre en el navegador (el core no lo abre). Al aprobar, guarda los tokens en `Secrets`, conecta
   * la cuenta (el workspace del token) y emite `connection.changed`; `done` entrega esa cuenta. Un
   * `linearAuth` nuevo cancela el que siga pendiente. Lanza `LinearAuthError` si falta el `client_id` o el
   * puerto del loopback está ocupado.
   */
  linearAuth(origin: Origin): Promise<LinearLogin>;
  /**
   * Prueba Claude (`probeClaude`: `claude` instalado, versión, login, plan y uso con una llamada mínima)
   * con `mode`, por defecto el activo (`claudeCredentials`). Si el resultado es concluyente deja la cuenta
   * `claude` conectada (`ready`, `quota_exhausted`), `expired` (login) o `revoked` (key rechazada) y emite
   * `connection.changed`; `not_installed`, `outdated` y `error` no tocan la base. Lanza `ClaudeSetupError`
   * si pide `api-key` sin tener una guardada.
   */
  testClaude(mode: ClaudeMode | undefined, origin: Origin): Promise<ClaudeStatus>;
  /**
   * Guarda la API key de Anthropic en `Secrets` y deja la cuenta `claude/api-key` activa: desde entonces
   * `claudeCredentials` la usa. Antes la prueba; si Anthropic la rechaza o no se pudo probar lanza
   * `ClaudeSetupError` sin guardar nada. Volver a la suscripción es `disconnect("claude", "api-key")`.
   */
  setClaudeApiKey(key: string, origin: Origin): Promise<Connection>;
  /**
   * La credencial que usa cada run de Claude: la API key si hay una guardada (cualquiera sea su estado: el
   * run falla con un mensaje claro en vez de gastar la suscripción sin avisar) y si no, el login de la
   * suscripción.
   */
  claudeCredentials(): Promise<ClaudeCredentials>;
  /**
   * El cliente de GitHub de una cuenta, el único que habla con la API: pone su token en cada request y
   * registra la cuota en `sync_cursors`. Lanza si la cuenta no está conectada.
   */
  githubClient(account: string): GitHubClient;
  /**
   * Las cuentas conectadas, sin tokens. Un token vencido sale `expired`; `expiresSoon` marca los que
   * vencen en `EXPIRY_WARNING_DAYS`.
   */
  list(): Connection[];
  /**
   * Marca la cuenta como `revoked` (GitHub rechazó su token con un 401) y emite `connection.changed`.
   * Reconectarla con `connect` la deja `active`. No hace nada si no está conectada o ya estaba revocada.
   */
  markRevoked(provider: ConnectionProvider, account: string, origin: Origin): void;
  /**
   * El token de una cuenta, solo para el core. Lanza si la cuenta no está conectada. El de Linear se
   * refresca solo si le quedan menos de `LINEAR_REFRESH_MARGIN_MS`; si Linear rechaza el refresh, deja la
   * cuenta `revoked` (`connection.changed`) y lanza `LinearAuthError`, y mientras siga revocada lanza sin
   * llamar a Linear. Un fallo transitorio (red, 5xx) lanza sin cambiar el estado. Si `Secrets` no puede
   * guardar los tokens rotados, los usa desde memoria y reintenta guardarlos en el próximo uso.
   */
  token(provider: ConnectionProvider, account: string): Promise<string>;
  /**
   * Borra el token y la cuenta y emite `connection.changed`. No hace nada si no estaba conectada. Con
   * Linear, espera a que termine un refresh en vuelo.
   */
  disconnect(provider: ConnectionProvider, account: string, origin: Origin): Promise<void>;
}

export function createConnections(
  store: Store,
  secrets: Secrets,
  { github = {}, linear = {}, claude = {}, now = Date.now }: ConnectionsOptions = {},
): Connections {
  const githubClients = new Map<string, GitHubClient>();
  const endpoints = linear.endpoints ?? LINEAR_ENDPOINTS;
  const linearRefreshes = new Map<string, Promise<string>>();
  const linearLocks = new Map<string, Promise<unknown>>();
  /** Tokens que Linear ya rotó y `Secrets` no pudo guardar: valen más que los del almacén, que Linear invalidó. */
  const unsavedLinear = new Map<string, LinearSession>();
  let pendingLogin: { cancel(reason: string): Promise<void> } | undefined;

  function find(provider: ConnectionProvider, account: string) {
    return store.db
      .select()
      .from(connections)
      .where(and(eq(connections.provider, provider), eq(connections.account, account)))
      .get();
  }

  /** Guarda el secreto, la cuenta y el evento. `secret` es lo que `token()` sabe leer de ese proveedor. */
  async function save(
    input: { provider: ConnectionProvider; account: string; scopes: string[]; secret: string; expiresAt?: number },
    origin: Origin,
  ): Promise<Connection> {
    const { provider, account, scopes, secret, expiresAt } = input;
    const secretRef = find(provider, account)?.secretRef ?? `connection:${provider}:${account}`;
    // El token primero: si la escritura en la base falla queda un secreto sin cuenta, que el
    // próximo `connect` de la misma cuenta pisa. Al revés quedaría una cuenta sin token.
    await secrets.set(secretRef, secret);
    return writeActive({ provider, account, scopes, secretRef, expiresAt }, origin);
  }

  /** La fila `active` (crea o reemplaza) y su evento. `secretRef` vacío: la cuenta no guarda ningún secreto. */
  function writeActive(
    input: { provider: ConnectionProvider; account: string; scopes: string[]; secretRef: string; expiresAt?: number },
    origin: Origin,
  ): Connection {
    const { provider, account, scopes, secretRef, expiresAt } = input;
    store.tx((tx) => {
      const values = {
        scopes,
        status: "active" as const,
        secretRef,
        expiresAt: expiresAt ?? null,
      };
      tx.db
        .insert(connections)
        .values({ provider, account, ...values })
        .onConflictDoUpdate({ target: [connections.provider, connections.account], set: values })
        .run();
      tx.emit({
        type: "connection.changed",
        origin,
        payload: { provider, account, status: "active" },
      });
    });
    return toConnection(find(provider, account)!, now());
  }

  /** Cambia el estado de una cuenta conectada y emite el evento; no hace nada si ya lo tenía. */
  function setStatus(provider: ConnectionProvider, account: string, status: "expired" | "revoked", origin: Origin) {
    store.tx((tx) => {
      const changed = tx.db
        .update(connections)
        .set({ status })
        .where(
          and(eq(connections.provider, provider), eq(connections.account, account), ne(connections.status, status)),
        )
        .returning({ account: connections.account })
        .get();
      if (changed) {
        tx.emit({ type: "connection.changed", origin, payload: { provider, account, status } });
      }
    });
  }

  const claudeEnv = claude.baseEnv ?? process.env;

  function probe(credentials: ClaudeCredentials): Promise<ClaudeStatus> {
    return probeClaude({
      credentials,
      baseEnv: claudeEnv,
      query: claude.query ?? sdkQuery,
      ...(claude.exec === undefined ? {} : { exec: claude.exec }),
    });
  }

  async function credentialsFor(mode: ClaudeMode): Promise<ClaudeCredentials> {
    if (mode === "subscription") return subscriptionCredentials({ env: claudeEnv });
    if (!find("claude", CLAUDE_API_KEY_ACCOUNT)) {
      throw new ClaudeSetupError("No hay una API key de Claude guardada: guárdala con setClaudeApiKey.");
    }
    return apiKeyCredentials(await self.token("claude", CLAUDE_API_KEY_ACCOUNT), { env: claudeEnv });
  }

  function linearConfig() {
    if (!linear.clientId) {
      throw new LinearAuthError(
        "Falta el client_id de la OAuth app de Linear: regístrala en Linear y configúralo en el core (docs en AGENTS.md, Secretos y conexiones).",
      );
    }
    return { endpoints, clientId: linear.clientId };
  }

  async function readLinearSession(secretRef: string): Promise<LinearSession> {
    const raw = await secrets.get(secretRef);
    const parsed = raw === undefined ? undefined : LinearSession.safeParse(safeJson(raw));
    if (!parsed?.success) {
      throw new Error(
        "Falta o está dañado el token de Linear en el almacén de secretos: desconecta la cuenta y vuelve a conectarla.",
      );
    }
    return parsed.data;
  }

  function toSession(tokens: LinearTokens): LinearSession {
    const { accessToken, refreshToken, accessExpiresAt } = tokens;
    return { accessToken, refreshToken, accessExpiresAt };
  }

  /**
   * Lo que escribe o borra los tokens de una cuenta de Linear va de a uno: un refresh que termina
   * después de un `disconnect` volvería a escribir el secreto de una cuenta que ya no existe.
   */
  function withLinearLock<T>(account: string, fn: () => Promise<T>): Promise<T> {
    const result = (linearLocks.get(account) ?? Promise.resolve()).then(fn);
    const tail = result.catch(() => undefined);
    linearLocks.set(account, tail);
    void tail.then(() => {
      if (linearLocks.get(account) === tail) linearLocks.delete(account);
    });
    return result;
  }

  /** La sesión vigente: la que no se pudo guardar si la hay (y se reintenta guardarla), si no la del almacén. */
  async function linearSession(account: string, secretRef: string): Promise<LinearSession> {
    if (unsavedLinear.has(account)) {
      await withLinearLock(account, async () => {
        const unsaved = unsavedLinear.get(account);
        if (unsaved) await persistLinear(account, secretRef, unsaved);
      });
    }
    return unsavedLinear.get(account) ?? readLinearSession(secretRef);
  }

  /**
   * Guarda los tokens rotados. Si `Secrets` falla, Linear ya invalidó el refresh token anterior: los
   * nuevos quedan en memoria (`unsavedLinear`) y el próximo `token()` vuelve a intentar guardarlos.
   */
  async function persistLinear(account: string, secretRef: string, session: LinearSession): Promise<void> {
    try {
      await secrets.set(secretRef, JSON.stringify(session));
      unsavedLinear.delete(account);
    } catch (error) {
      unsavedLinear.set(account, session);
      console.error(`No se pudieron guardar los tokens nuevos de Linear "${account}"; se reintenta en el próximo uso:`, error);
    }
  }

  /** Un solo refresh por cuenta a la vez: el refresh token rota, usar el viejo dos veces lo pierde. */
  function refreshLinear(account: string): Promise<string> {
    let refresh = linearRefreshes.get(account);
    if (!refresh) {
      refresh = withLinearLock(account, () => doRefreshLinear(account)).finally(() => linearRefreshes.delete(account));
      linearRefreshes.set(account, refresh);
    }
    return refresh;
  }

  async function doRefreshLinear(account: string): Promise<string> {
    const row = find("linear", account);
    if (!row) throw new Error(`La cuenta de Linear "${account}" se desconectó.`);
    // Otro refresh pudo terminar mientras este esperaba su turno.
    const session = unsavedLinear.get(account) ?? (await readLinearSession(row.secretRef));
    if (session.accessExpiresAt - now() > LINEAR_REFRESH_MARGIN_MS) return session.accessToken;

    const { clientId } = linearConfig();
    let tokens: LinearTokens;
    try {
      tokens = await refreshTokens(endpoints, { clientId, refreshToken: session.refreshToken }, now());
    } catch (error) {
      if (error instanceof LinearAuthError) self.markRevoked("linear", account, "core");
      throw error;
    }
    await persistLinear(account, row.secretRef, toSession(tokens));
    store.db
      .update(connections)
      .set({ expiresAt: now() + LINEAR_REFRESH_TTL_MS })
      .where(and(eq(connections.provider, "linear"), eq(connections.account, account)))
      .run();
    return tokens.accessToken;
  }

  async function finishLinearLogin(tokens: LinearTokens, origin: Origin): Promise<Connection> {
    const account = await fetchWorkspaceKey(endpoints, tokens.accessToken);
    unsavedLinear.delete(account);
    return save(
      {
        provider: "linear",
        account,
        scopes: tokens.scopes,
        secret: JSON.stringify(toSession(tokens)),
        expiresAt: now() + LINEAR_REFRESH_TTL_MS,
      },
      origin,
    );
  }

  const self: Connections = {
    async connect({ provider, account, scopes, token, expiresAt }, origin) {
      if (account === "" || token === "") {
        throw new Error(`Conectar ${provider} necesita una cuenta y un token no vacíos.`);
      }
      if (provider === "linear") {
        throw new Error("Linear se conecta con linearAuth: su token se refresca y no se pega.");
      }
      if (provider === "claude") {
        throw new Error("Claude se conecta con testClaude (suscripción) o setClaudeApiKey (API key).");
      }
      return save({ provider, account, scopes, secret: token, expiresAt }, origin);
    },

    async setPat(token, origin) {
      const { login, permissions, expiresAt } = await validatePat(token, github);
      return self.connect(
        { provider: "github", account: login, scopes: permissions, token, expiresAt },
        origin,
      );
    },

    async linearAuth(origin) {
      const { clientId } = linearConfig();
      await pendingLogin?.cancel("Se inició otra conexión con Linear.");
      const login = await startLinearLogin(
        {
          endpoints,
          clientId,
          port: linear.redirectPort ?? LINEAR_REDIRECT_PORT,
          timeoutMs: linear.loginTimeoutMs ?? LINEAR_LOGIN_TIMEOUT_MS,
          now,
        },
        (tokens) => finishLinearLogin(tokens, origin),
      );
      pendingLogin = login;
      const forget = () => {
        if (pendingLogin === login) pendingLogin = undefined;
      };
      login.done.then(forget, forget);
      return { url: login.url, done: login.done };
    },

    async testClaude(requested, origin) {
      const mode = requested ?? (find("claude", CLAUDE_API_KEY_ACCOUNT) ? "api-key" : "subscription");
      const status = await probe(await credentialsFor(mode));
      if (status.state === "ready" || status.state === "quota_exhausted") {
        writeActive(
          {
            provider: "claude",
            account: mode,
            scopes: status.plan === undefined ? [] : [`plan:${status.plan}`],
            secretRef: find("claude", mode)?.secretRef ?? "",
          },
          origin,
        );
      } else if (status.state === "login_required" || status.state === "login_expired") {
        setStatus("claude", mode, "expired", origin);
      } else if (status.state === "key_rejected") {
        setStatus("claude", mode, "revoked", origin);
      }
      return status;
    },

    async setClaudeApiKey(key, origin) {
      if (key === "") throw new ClaudeSetupError("La API key de Claude no puede estar vacía.");
      const status = await probe(apiKeyCredentials(key, { env: claudeEnv }));
      if (status.state !== "ready" && status.state !== "quota_exhausted") {
        throw new ClaudeSetupError(status.message ?? "No pude probar la API key de Claude.");
      }
      return save(
        { provider: "claude", account: CLAUDE_API_KEY_ACCOUNT, scopes: [], secret: key },
        origin,
      );
    },

    claudeCredentials() {
      return credentialsFor(find("claude", CLAUDE_API_KEY_ACCOUNT) ? "api-key" : "subscription");
    },

    githubClient(account) {
      if (!find("github", account)) {
        throw new Error(`No hay una cuenta github conectada como "${account}": conéctala primero.`);
      }
      let client = githubClients.get(account);
      if (!client) {
        client = createGitHubClient({
          ...github,
          tokens: { kind: "pat", token: () => self.token("github", account) },
          quota: { store, account },
        });
        githubClients.set(account, client);
      }
      return client;
    },

    list() {
      const at = now();
      return store.db
        .select()
        .from(connections)
        .orderBy(asc(connections.provider), asc(connections.account))
        .all()
        .map((row) => toConnection(row, at));
    },

    markRevoked(provider, account, origin) {
      setStatus(provider, account, "revoked", origin);
    },

    async token(provider, account) {
      const row = find(provider, account);
      if (!row) {
        throw new Error(`No hay una cuenta ${provider} conectada como "${account}": conéctala primero.`);
      }
      if (provider === "linear") {
        if (row.status === "revoked") {
          throw new LinearAuthError(
            `La conexión con Linear "${account}" fue revocada: vuelve a conectarla.`,
          );
        }
        const session = await linearSession(account, row.secretRef);
        if (session.accessExpiresAt - now() > LINEAR_REFRESH_MARGIN_MS) return session.accessToken;
        return refreshLinear(account);
      }
      if (row.secretRef === "") {
        throw new Error(`La cuenta ${provider} "${account}" no guarda ningún token: lo lee el programa que la usa.`);
      }
      const token = await secrets.get(row.secretRef);
      if (token === undefined) {
        throw new Error(
          `Falta el token de ${provider} "${account}" en el almacén de secretos: desconecta la cuenta y vuelve a conectarla.`,
        );
      }
      return token;
    },

    async disconnect(provider, account, origin) {
      if (provider === "linear") {
        // Después de un refresh en vuelo, no antes: si no, escribiría el secreto recién borrado.
        return withLinearLock(account, async () => {
          await remove(provider, account, origin);
          unsavedLinear.delete(account);
        });
      }
      return remove(provider, account, origin);
    },
  };

  async function remove(provider: ConnectionProvider, account: string, origin: Origin): Promise<void> {
    const row = find(provider, account);
    if (!row) return;
    // El token primero: si falla, la cuenta sigue a la vista y se puede reintentar. Al revés
    // quedaría un token vivo en el almacén sin que nadie lo vea.
    if (row.secretRef !== "") await secrets.delete(row.secretRef);
    if (provider === "github") githubClients.delete(account);
    store.tx((tx) => {
      tx.db
        .delete(connections)
        .where(and(eq(connections.provider, provider), eq(connections.account, account)))
        .run();
      tx.emit({
        type: "connection.changed",
        origin,
        payload: { provider, account, status: "disconnected" },
      });
    });
  }

  return self;
}

/** Sin `secretRef` a propósito: es un detalle del core, la API no lo necesita. */
function toConnection(row: typeof connections.$inferSelect, now: number): Connection {
  const expired = row.expiresAt !== null && row.expiresAt <= now;
  const expiresSoon =
    row.status === "active" && row.expiresAt !== null && !expired && row.expiresAt - now <= EXPIRY_WARNING_MS;
  return {
    provider: row.provider,
    account: row.account,
    scopes: row.scopes,
    status: expired && row.status === "active" ? "expired" : row.status,
    ...(row.expiresAt === null ? {} : { expiresAt: row.expiresAt }),
    ...(expiresSoon ? { expiresSoon } : {}),
  };
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

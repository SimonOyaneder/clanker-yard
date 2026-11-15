import type { Connection, ConnectionProvider, Origin } from "@clanker/api";
import { and, asc, eq, ne } from "drizzle-orm";
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

export interface ConnectionsOptions {
  /** Dónde está GitHub; en tests, un servidor local. */
  github?: GitHubApiOptions;
  linear?: LinearOptions;
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
   * llamar a Linear. Un fallo transitorio (red, 5xx) lanza sin cambiar el estado.
   */
  token(provider: ConnectionProvider, account: string): Promise<string>;
  /** Borra el token y la cuenta y emite `connection.changed`. No hace nada si no estaba conectada. */
  disconnect(provider: ConnectionProvider, account: string, origin: Origin): Promise<void>;
}

export function createConnections(
  store: Store,
  secrets: Secrets,
  { github = {}, linear = {}, now = Date.now }: ConnectionsOptions = {},
): Connections {
  const githubClients = new Map<string, GitHubClient>();
  const endpoints = linear.endpoints ?? LINEAR_ENDPOINTS;
  const linearRefreshes = new Map<string, Promise<string>>();
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

  /** Un solo refresh por cuenta a la vez: el refresh token rota, usar el viejo dos veces lo pierde. */
  function refreshLinear(account: string): Promise<string> {
    let refresh = linearRefreshes.get(account);
    if (!refresh) {
      refresh = doRefreshLinear(account).finally(() => linearRefreshes.delete(account));
      linearRefreshes.set(account, refresh);
    }
    return refresh;
  }

  async function doRefreshLinear(account: string): Promise<string> {
    const row = find("linear", account)!;
    // Otro refresh pudo terminar mientras este esperaba su turno.
    const session = await readLinearSession(row.secretRef);
    if (session.accessExpiresAt - now() > LINEAR_REFRESH_MARGIN_MS) return session.accessToken;

    const { clientId } = linearConfig();
    let tokens: LinearTokens;
    try {
      tokens = await refreshTokens(endpoints, { clientId, refreshToken: session.refreshToken }, now());
    } catch (error) {
      if (error instanceof LinearAuthError) self.markRevoked("linear", account, "core");
      throw error;
    }
    await secrets.set(row.secretRef, JSON.stringify(toSession(tokens)));
    store.db
      .update(connections)
      .set({ expiresAt: now() + LINEAR_REFRESH_TTL_MS })
      .where(and(eq(connections.provider, "linear"), eq(connections.account, account)))
      .run();
    return tokens.accessToken;
  }

  async function finishLinearLogin(tokens: LinearTokens, origin: Origin): Promise<Connection> {
    const account = await fetchWorkspaceKey(endpoints, tokens.accessToken);
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
      store.tx((tx) => {
        const revoked = tx.db
          .update(connections)
          .set({ status: "revoked" })
          .where(
            and(
              eq(connections.provider, provider),
              eq(connections.account, account),
              ne(connections.status, "revoked"),
            ),
          )
          .returning({ account: connections.account })
          .get();
        if (revoked) {
          tx.emit({
            type: "connection.changed",
            origin,
            payload: { provider, account, status: "revoked" },
          });
        }
      });
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
        const session = await readLinearSession(row.secretRef);
        if (session.accessExpiresAt - now() > LINEAR_REFRESH_MARGIN_MS) return session.accessToken;
        return refreshLinear(account);
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
      const row = find(provider, account);
      if (!row) return;
      // El token primero: si falla, la cuenta sigue a la vista y se puede reintentar. Al revés
      // quedaría un token vivo en el almacén sin que nadie lo vea.
      await secrets.delete(row.secretRef);
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
    },
  };
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

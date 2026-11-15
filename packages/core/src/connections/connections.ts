import { query as sdkQuery } from "@anthropic-ai/claude-agent-sdk";
import type { ClaudeMode, ClaudeStatus, Connection, ConnectionProvider, GitHubAuth, GitHubDeviceFlow, GitHubInstallations, LoginFailure, Origin } from "@clanker/api";
import { and, asc, eq, ne } from "drizzle-orm";
import { apiKeyCredentials, subscriptionCredentials, type ClaudeCredentials } from "../agents/claude/credentials";
import type { QueryFn } from "../agents/claude/claude-runtime";
import { probeClaude, type ExecFn } from "../agents/claude/probe";
import { createGitHubClient, type GitHubApiOptions, type GitHubClient } from "../github/client";
import {
  GITHUB_OAUTH_ENDPOINTS,
  GitHubAuthError,
  pollDeviceToken,
  refreshAppTokens,
  requestDeviceCode,
  type DeviceCode,
  type GitHubAppTokens,
  type GitHubOAuthEndpoints,
} from "../github/device-flow";
import { validatePat } from "../github/pat";
import { startLinearLogin } from "../linear/login";
import {
  fetchWorkspaceKey,
  LINEAR_ENDPOINTS,
  LINEAR_REFRESH_TTL_MS,
  LinearAuthError,
  refreshTokens,
  type LinearEndpoints,
  type LinearTokens,
} from "../linear/oauth";
import type { Secrets } from "../secrets/secrets";
import { connections } from "../store/schema";
import type { Store } from "../store/store";
import { OAuthSession } from "./oauth-session";

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
/** Lo mismo para el token de usuario de la GitHub App (vive 8 h). */
export const GITHUB_REFRESH_MARGIN_MS = 5 * 60 * 1000;

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

/** La GitHub App del device flow (`docs/github-app.md`). */
export interface GitHubAppOptions {
  /** El Client ID de la App (no el App ID). Sin él `startDeviceFlow` no puede iniciar. */
  clientId: string;
  /** El nombre corto de la App en github.com (`github.com/apps/<slug>`); con él `githubInstallations` da el link para instalarla. */
  slug?: string;
  /** Dónde está el OAuth de GitHub; en tests, un servidor local. */
  endpoints?: GitHubOAuthEndpoints;
  /** Espera entre sondeos; en tests, un reloj falso. Default `setTimeout` (sin mantener vivo el proceso). */
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
}

export interface ConnectionsOptions {
  /** Dónde está GitHub; en tests, un servidor local. */
  github?: GitHubApiOptions;
  githubApp?: GitHubAppOptions;
  linear?: LinearOptions;
  claude?: ClaudeOptions;
  /** Reloj en ms epoch, para el vencimiento. */
  now?: () => number;
}

export interface Connections {
  /**
   * Guarda el token en `Secrets` y la cuenta en la base. Si la cuenta ya estaba conectada, reemplaza
   * token, scopes y vencimiento y la deja `active`. Emite `connection.changed`. GitHub queda con
   * `auth: "pat"`, incluso si la cuenta estaba conectada con la App. Linear no entra por aquí: su token
   * rota y se conecta con `linearAuth`.
   */
  connect(input: ConnectInput, origin: Origin): Promise<Connection>;
  /**
   * Valida un fine-grained PAT de GitHub y lo conecta con la cuenta a la que pertenece (`GitHubPatError`
   * si no sirve, sin guardar nada). Los permisos verificados quedan como `scopes`. Emite
   * `connection.changed`.
   */
  setPat(token: string, origin: Origin): Promise<Connection>;
  /**
   * Inicia el device flow de la GitHub App (`docs/github-app.md`): pide el código a GitHub y lo devuelve
   * para que el usuario lo escriba en `verificationUri` (el core no abre nada). En segundo plano sondea el
   * token respetando `interval` y `slow_down`; al aprobar, pregunta de quién es el token, guarda la sesión
   * (access token de 8 h y refresh token que rota) en `Secrets`, conecta la cuenta con `auth: "app"` y emite
   * `connection.changed`. Si el usuario cancela, el código vence o GitHub rechaza algo, la cuenta no cambia
   * y se emite `connection.login_failed` (`provider`, `reason` y `message`). Un `startDeviceFlow` nuevo cancela
   * el que siga pendiente. Lanza `GitHubAuthError` si falta el `client_id` o GitHub rechaza el inicio (device flow
   * sin habilitar, `client_id` incorrecto).
   */
  startDeviceFlow(origin: Origin): Promise<GitHubDeviceFlow>;
  /**
   * Cuántas instalaciones de la GitHub App ve el token de la cuenta de GitHub conectada con la App
   * (`GET /user/installations`). Con cero, conectar funcionó pero ningún repo es visible hasta que se
   * instale (`docs/github-app.md`). Lanza si GitHub no está conectado con la App o GitHub falla.
   */
  githubInstallations(): Promise<GitHubInstallations>;
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
   * registra la cuota en `sync_cursors`. Con `auth: "app"`, un 401 refresca el token y reintenta una vez.
   * Lanza si la cuenta no está conectada.
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
   * Un run real encontró el login de Claude vencido (con API key, la key rechazada): deja
   * `claude/subscription` en `expired` o `claude/api-key` en `revoked`, y emite `connection.changed`, como
   * si el usuario hubiera corrido `testClaude`. No hace nada si esa cuenta no está conectada.
   */
  markClaudeLoginLost(origin: Origin): void;
  /**
   * El token de una cuenta, solo para el core. Lanza si la cuenta no está conectada. El de Linear y el de
   * una GitHub App (`auth: "app"`) se refrescan solos si les quedan menos de `LINEAR_REFRESH_MARGIN_MS` /
   * `GITHUB_REFRESH_MARGIN_MS`, con un solo refresh en vuelo por cuenta; si el proveedor rechaza el refresh,
   * deja la cuenta `revoked` (`connection.changed`, que abre el breaker `github`) y lanza `LinearAuthError`
   * o `GitHubAuthError`, y mientras siga revocada lanza sin llamar al proveedor. Un fallo transitorio (red,
   * 5xx) lanza sin cambiar el estado. Si `Secrets` no puede guardar los tokens rotados, los usa desde
   * memoria y reintenta guardarlos en el próximo uso.
   */
  token(provider: ConnectionProvider, account: string): Promise<string>;
  /**
   * Borra el token y la cuenta y emite `connection.changed`. No hace nada si no estaba conectada. Con
   * Linear y GitHub, espera a que termine un refresh en vuelo.
   */
  disconnect(provider: ConnectionProvider, account: string, origin: Origin): Promise<void>;
}

/** Los proveedores cuyo access token vence y cuyo refresh token rota; GitHub solo con `auth: "app"`. */
type RotatingProvider = "linear" | "github";

const ROTATING = {
  linear: { label: "Linear", margin: LINEAR_REFRESH_MARGIN_MS, Rejection: LinearAuthError },
  github: { label: "GitHub", margin: GITHUB_REFRESH_MARGIN_MS, Rejection: GitHubAuthError },
} as const;

/** Lo que un refresh entrega: la sesión nueva y cuándo vence su refresh token (ms epoch). */
interface Refreshed {
  session: OAuthSession;
  refreshExpiresAt: number;
}

function revokedMessage(provider: RotatingProvider, account: string): string {
  return `La conexión con ${ROTATING[provider].label} "${account}" fue revocada: vuelve a conectarla.`;
}

function defaultSleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) return reject(signal.reason);
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    // Un device flow esperando no debe mantener vivo al core que se apaga.
    timer.unref();
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal.reason);
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

export function createConnections(
  store: Store,
  secrets: Secrets,
  { github = {}, githubApp, linear = {}, claude = {}, now = Date.now }: ConnectionsOptions = {},
): Connections {
  const githubClients = new Map<string, GitHubClient>();
  const endpoints = linear.endpoints ?? LINEAR_ENDPOINTS;
  const refreshes = new Map<string, Promise<string>>();
  const locks = new Map<string, Promise<unknown>>();
  /** Tokens que el proveedor ya rotó y `Secrets` no pudo guardar: valen más que los del almacén, que ya invalidó. */
  const unsaved = new Map<string, OAuthSession>();
  let pendingLogin: { cancel(reason: string): Promise<void> } | undefined;
  let pendingDeviceFlow: AbortController | undefined;

  function find(provider: ConnectionProvider, account: string) {
    return store.db
      .select()
      .from(connections)
      .where(and(eq(connections.provider, provider), eq(connections.account, account)))
      .get();
  }

  /** Guarda el secreto, la cuenta y el evento. `secret` es lo que `token()` sabe leer de ese proveedor. */
  function save(
    input: {
      provider: ConnectionProvider;
      account: string;
      scopes: string[];
      secret: string;
      expiresAt?: number;
      auth?: GitHubAuth;
    },
    origin: Origin,
  ): Promise<Connection> {
    const { provider, account, scopes, secret, expiresAt, auth } = input;
    return withLock(sessionKey(provider, account), async () => {
      const secretRef = find(provider, account)?.secretRef ?? `connection:${provider}:${account}`;
      // El token primero: si la escritura en la base falla queda un secreto sin cuenta, que el
      // próximo `connect` de la misma cuenta pisa. Al revés quedaría una cuenta sin token.
      await secrets.set(secretRef, secret);
      // Los tokens que no se pudieron guardar eran de la credencial anterior.
      unsaved.delete(sessionKey(provider, account));
      if (provider === "github") githubClients.delete(account);
      return writeActive({ provider, account, scopes, secretRef, expiresAt, auth }, origin);
    });
  }

  /** La fila `active` (crea o reemplaza) y su evento. `secretRef` vacío: la cuenta no guarda ningún secreto. */
  function writeActive(
    input: {
      provider: ConnectionProvider;
      account: string;
      scopes: string[];
      secretRef: string;
      expiresAt?: number;
      auth?: GitHubAuth;
    },
    origin: Origin,
  ): Connection {
    const { provider, account, scopes, secretRef, expiresAt, auth } = input;
    store.tx((tx) => {
      const values = {
        scopes,
        status: "active" as const,
        secretRef,
        expiresAt: expiresAt ?? null,
        auth: auth ?? null,
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
        `Falta el client_id de la OAuth app de Linear. Regístrala (AGENTS.md, "Paso manual pendiente") y ponlo en config.json de la carpeta de datos de Clanker Yard (en macOS, ~/Library/Application Support/Clanker Yard) como { "linear": { "clientId": "..." } }, o en la variable CLANKER_LINEAR_CLIENT_ID; luego reinicia el core.`,
      );
    }
    return { endpoints, clientId: linear.clientId };
  }

  function githubAppConfig() {
    if (!githubApp?.clientId) {
      throw new GitHubAuthError(
        `Falta el client_id de la GitHub App. Regístrala (docs/github-app.md) y ponlo en config.json de la carpeta de datos de Clanker Yard (en macOS, ~/Library/Application Support/Clanker Yard) como { "githubApp": { "clientId": "Iv..." } }, o en la variable CLANKER_GITHUB_APP_CLIENT_ID; luego reinicia el core.`,
      );
    }
    return { clientId: githubApp.clientId, endpoints: githubApp.endpoints ?? GITHUB_OAUTH_ENDPOINTS };
  }

  const sessionKey = (provider: ConnectionProvider, account: string) => `${provider}:${account}`;

  /**
   * Cómo se refresca cada proveedor. La configuración que falta lanza al pedirlo, antes de llamar al
   * proveedor: no es un rechazo del refresh token y no deja la cuenta revocada.
   */
  function refresher(provider: RotatingProvider): (refreshToken: string) => Promise<Refreshed> {
    if (provider === "linear") {
      const { clientId } = linearConfig();
      return async (refreshToken) => {
        const at = now();
        const tokens = await refreshTokens(endpoints, { clientId, refreshToken }, at);
        return { session: toSession(tokens), refreshExpiresAt: at + LINEAR_REFRESH_TTL_MS };
      };
    }
    const { clientId, endpoints: oauth } = githubAppConfig();
    return async (refreshToken) => {
      const tokens = await refreshAppTokens(oauth, { clientId, refreshToken }, now());
      return { session: toSession(tokens), refreshExpiresAt: tokens.refreshExpiresAt };
    };
  }

  async function readSession(provider: RotatingProvider, secretRef: string): Promise<OAuthSession> {
    const raw = await secrets.get(secretRef);
    const parsed = raw === undefined ? undefined : OAuthSession.safeParse(safeJson(raw));
    if (!parsed?.success) {
      throw new Error(
        `Falta o está dañado el token de ${ROTATING[provider].label} en el almacén de secretos: desconecta la cuenta y vuelve a conectarla.`,
      );
    }
    return parsed.data;
  }

  function toSession({ accessToken, refreshToken, accessExpiresAt }: OAuthSession): OAuthSession {
    return { accessToken, refreshToken, accessExpiresAt };
  }

  /**
   * Lo que escribe o borra los tokens de una cuenta va de a uno: un refresh que termina después de un
   * `disconnect` (o de reconectar con otro tipo de credencial) volvería a escribir el secreto de una cuenta
   * que ya no es esa.
   */
  function withLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const result = (locks.get(key) ?? Promise.resolve()).then(fn);
    const tail = result.catch(() => undefined);
    locks.set(key, tail);
    void tail.then(() => {
      if (locks.get(key) === tail) locks.delete(key);
    });
    return result;
  }

  /** La sesión vigente: la que no se pudo guardar si la hay (y se reintenta guardarla), si no la del almacén. */
  async function currentSession(provider: RotatingProvider, account: string, secretRef: string): Promise<OAuthSession> {
    const key = sessionKey(provider, account);
    if (unsaved.has(key)) {
      await withLock(key, async () => {
        const pending = unsaved.get(key);
        if (pending) await persist(key, secretRef, pending);
      });
    }
    return unsaved.get(key) ?? readSession(provider, secretRef);
  }

  /**
   * Guarda los tokens rotados. Si `Secrets` falla, el proveedor ya invalidó el refresh token anterior: los
   * nuevos quedan en memoria (`unsaved`) y el próximo `token()` vuelve a intentar guardarlos.
   */
  async function persist(key: string, secretRef: string, session: OAuthSession): Promise<void> {
    try {
      await secrets.set(secretRef, JSON.stringify(session));
      unsaved.delete(key);
    } catch (error) {
      unsaved.set(key, session);
      console.error(`No se pudieron guardar los tokens nuevos de ${key}; se reintenta en el próximo uso:`, error);
    }
  }

  /**
   * Un solo refresh por cuenta a la vez: el refresh token rota, usar el viejo dos veces lo pierde. Quien
   * llega con uno en vuelo recibe su resultado. `force` refresca aunque al access token le quede vida (GitHub
   * lo rechazó con un 401).
   */
  function refresh(provider: RotatingProvider, account: string, force: boolean): Promise<string> {
    const key = sessionKey(provider, account);
    let inFlight = refreshes.get(key);
    if (!inFlight) {
      inFlight = withLock(key, () => doRefresh(provider, account, force)).finally(() => refreshes.delete(key));
      refreshes.set(key, inFlight);
    }
    return inFlight;
  }

  async function doRefresh(provider: RotatingProvider, account: string, force: boolean): Promise<string> {
    const { label, Rejection } = ROTATING[provider];
    const key = sessionKey(provider, account);
    const row = find(provider, account);
    if (!row || (provider === "github" && row.auth !== "app")) {
      throw new Error(`La cuenta de ${label} "${account}" se desconectó o cambió de credencial.`);
    }
    if (row.status === "revoked") throw new Rejection(revokedMessage(provider, account));
    // Otro refresh pudo terminar mientras este esperaba su turno.
    const session = unsaved.get(key) ?? (await readSession(provider, row.secretRef));
    if (!force && session.accessExpiresAt - now() > ROTATING[provider].margin) return session.accessToken;
    const exchange = refresher(provider);

    let next: Refreshed;
    try {
      next = await exchange(session.refreshToken);
    } catch (error) {
      if (error instanceof Rejection) self.markRevoked(provider, account, "core");
      throw error;
    }
    await persist(key, row.secretRef, next.session);
    store.db
      .update(connections)
      .set({ expiresAt: next.refreshExpiresAt })
      .where(and(eq(connections.provider, provider), eq(connections.account, account)))
      .run();
    return next.session.accessToken;
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

  async function finishAppLogin(tokens: GitHubAppTokens, flow: AbortSignal, origin: Origin): Promise<Connection> {
    const user = await createGitHubClient({ ...github, tokens: { kind: "app", token: async () => tokens.accessToken } }).request("GET /user");
    // Si se inició otro device flow mientras se preguntaba quién es, este ya no conecta nada.
    if (flow.aborted) throw flow.reason;
    return save(
      {
        provider: "github",
        account: user.data.login,
        scopes: [],
        secret: JSON.stringify(toSession(tokens)),
        expiresAt: tokens.refreshExpiresAt,
        auth: "app",
      },
      origin,
    );
  }

  function reportDeviceFlowFailure(error: unknown, origin: Origin) {
    const message = error instanceof Error ? error.message : String(error);
    const reason: LoginFailure = error instanceof GitHubAuthError && error.reason !== "rejected" ? error.reason : "failed";
    store.tx((tx) => tx.emit({ type: "connection.login_failed", origin, payload: { provider: "github", reason, message } }));
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
      return save({ provider, account, scopes, secret: token, expiresAt, ...(provider === "github" ? { auth: "pat" as const } : {}) }, origin);
    },

    async setPat(token, origin) {
      const { login, permissions, expiresAt } = await validatePat(token, github);
      return self.connect(
        { provider: "github", account: login, scopes: permissions, token, expiresAt },
        origin,
      );
    },

    async startDeviceFlow(origin) {
      const { clientId, endpoints: oauth } = githubAppConfig();
      pendingDeviceFlow?.abort(new GitHubAuthError("Se inició otra conexión con la GitHub App."));
      const flow = new AbortController();
      pendingDeviceFlow = flow;
      const forget = () => {
        if (pendingDeviceFlow === flow) pendingDeviceFlow = undefined;
      };
      let code: DeviceCode;
      try {
        code = await requestDeviceCode(oauth, clientId, now(), flow.signal);
      } catch (error) {
        forget();
        throw error;
      }
      // Nadie espera este sondeo: su resultado llega como `connection.changed`, y un fallo como evento `error`.
      void pollDeviceToken({ endpoints: oauth, clientId, code, now, sleep: githubApp?.sleep ?? defaultSleep, signal: flow.signal })
        .then((tokens) => finishAppLogin(tokens, flow.signal, origin))
        .catch((error: unknown) => {
          if (!flow.signal.aborted) reportDeviceFlowFailure(error, origin);
        })
        .finally(forget);
      return { userCode: code.userCode, verificationUri: code.verificationUri, expiresIn: Math.round((code.expiresAt - now()) / 1000) };
    },

    async githubInstallations() {
      const row = store.db.select().from(connections).where(eq(connections.provider, "github")).get();
      if (row?.auth !== "app") throw new GitHubAuthError("GitHub no está conectado con la GitHub App: conéctala primero.");
      const { data } = await self.githubClient(row.account).request("GET /user/installations", { per_page: 1 });
      const slug = githubApp?.slug;
      return { count: data.total_count, ...(slug ? { installUrl: `https://github.com/apps/${slug}/installations/new` } : {}) };
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
      const row = find("github", account);
      if (!row) {
        throw new Error(`No hay una cuenta github conectada como "${account}": conéctala primero.`);
      }
      let client = githubClients.get(account);
      if (!client) {
        const token = () => self.token("github", account);
        client = createGitHubClient({
          ...github,
          tokens:
            row.auth === "app"
              ? { kind: "app", token, refresh: async () => void (await refresh("github", account, true)) }
              : { kind: "pat", token },
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

    markClaudeLoginLost(origin) {
      if (find("claude", CLAUDE_API_KEY_ACCOUNT)) setStatus("claude", CLAUDE_API_KEY_ACCOUNT, "revoked", origin);
      else setStatus("claude", "subscription", "expired", origin);
    },

    async token(provider, account) {
      const row = find(provider, account);
      if (!row) {
        throw new Error(`No hay una cuenta ${provider} conectada como "${account}": conéctala primero.`);
      }
      if (provider === "linear" || (provider === "github" && row.auth === "app")) {
        if (row.status === "revoked") throw new ROTATING[provider].Rejection(revokedMessage(provider, account));
        const session = await currentSession(provider, account, row.secretRef);
        if (session.accessExpiresAt - now() > ROTATING[provider].margin) return session.accessToken;
        return refresh(provider, account, false);
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
      if (provider === "linear" || provider === "github") {
        // Después de un refresh en vuelo, no antes: si no, escribiría el secreto recién borrado.
        const key = sessionKey(provider, account);
        return withLock(key, async () => {
          await remove(provider, account, origin);
          unsaved.delete(key);
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
    ...(row.auth === null ? {} : { auth: row.auth }),
  };
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

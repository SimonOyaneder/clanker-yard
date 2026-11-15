import type { Connection, ConnectionProvider, Origin } from "@clanker/api";
import { and, asc, eq, ne } from "drizzle-orm";
import { createGitHubClient, type GitHubApiOptions, type GitHubClient } from "../github/client";
import { validatePat } from "../github/pat";
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

export interface ConnectionsOptions {
  /** Dónde está GitHub; en tests, un servidor local. */
  github?: GitHubApiOptions;
  /** Reloj en ms epoch, para el vencimiento. */
  now?: () => number;
}

export interface Connections {
  /**
   * Guarda el token en `Secrets` y la cuenta en la base. Si la cuenta ya estaba conectada, reemplaza
   * token, scopes y vencimiento y la deja `active`. Emite `connection.changed`.
   */
  connect(input: ConnectInput, origin: Origin): Promise<Connection>;
  /**
   * Valida un fine-grained PAT de GitHub y lo conecta con la cuenta a la que pertenece (`GitHubPatError`
   * si no sirve, sin guardar nada). Los permisos verificados quedan como `scopes`. Emite
   * `connection.changed`.
   */
  setPat(token: string, origin: Origin): Promise<Connection>;
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
  /** El token de una cuenta, solo para el core. Lanza si la cuenta no está conectada. */
  token(provider: ConnectionProvider, account: string): Promise<string>;
  /** Borra el token y la cuenta y emite `connection.changed`. No hace nada si no estaba conectada. */
  disconnect(provider: ConnectionProvider, account: string, origin: Origin): Promise<void>;
}

export function createConnections(
  store: Store,
  secrets: Secrets,
  { github = {}, now = Date.now }: ConnectionsOptions = {},
): Connections {
  const githubClients = new Map<string, GitHubClient>();

  function find(provider: ConnectionProvider, account: string) {
    return store.db
      .select()
      .from(connections)
      .where(and(eq(connections.provider, provider), eq(connections.account, account)))
      .get();
  }

  const self: Connections = {
    async connect({ provider, account, scopes, token, expiresAt }, origin) {
      if (account === "" || token === "") {
        throw new Error(`Conectar ${provider} necesita una cuenta y un token no vacíos.`);
      }
      const secretRef = find(provider, account)?.secretRef ?? `connection:${provider}:${account}`;
      // El token primero: si la escritura en la base falla queda un secreto sin cuenta, que el
      // próximo `connect` de la misma cuenta pisa. Al revés quedaría una cuenta sin token.
      await secrets.set(secretRef, token);
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
    },

    async setPat(token, origin) {
      const { login, permissions, expiresAt } = await validatePat(token, github);
      return self.connect(
        { provider: "github", account: login, scopes: permissions, token, expiresAt },
        origin,
      );
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

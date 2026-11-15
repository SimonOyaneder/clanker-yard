import type { Connection, ConnectionProvider, Origin } from "@clanker/api";
import { and, asc, eq } from "drizzle-orm";
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

export interface Connections {
  /**
   * Guarda el token en `Secrets` y la cuenta en la base. Si la cuenta ya estaba conectada, reemplaza
   * token, scopes y vencimiento y la deja `active`. Emite `connection.changed`.
   */
  connect(input: ConnectInput, origin: Origin): Promise<Connection>;
  /** Las cuentas conectadas, sin tokens. */
  list(): Connection[];
  /** El token de una cuenta, solo para el core. Lanza si la cuenta no está conectada. */
  token(provider: ConnectionProvider, account: string): Promise<string>;
  /** Borra el token y la cuenta y emite `connection.changed`. No hace nada si no estaba conectada. */
  disconnect(provider: ConnectionProvider, account: string, origin: Origin): Promise<void>;
}

export function createConnections(store: Store, secrets: Secrets): Connections {
  function find(provider: ConnectionProvider, account: string) {
    return store.db
      .select()
      .from(connections)
      .where(and(eq(connections.provider, provider), eq(connections.account, account)))
      .get();
  }

  return {
    async connect({ provider, account, scopes, token, expiresAt }, origin) {
      if (account === "" || token === "") {
        throw new Error(`Conectar ${provider} necesita una cuenta y un token no vacíos.`);
      }
      const secretRef = find(provider, account)?.secretRef ?? `connection:${provider}:${account}`;
      // El token primero: si la escritura en la base falla queda un secreto sin cuenta, que el
      // próximo `connect` de la misma cuenta pisa. Al revés quedaría una cuenta sin token.
      await secrets.set(secretRef, token);
      const connection: Connection = {
        provider,
        account,
        scopes,
        status: "active",
        ...(expiresAt === undefined ? {} : { expiresAt }),
      };
      store.tx((tx) => {
        const values = {
          scopes,
          status: connection.status,
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
          payload: { provider, account, status: connection.status },
        });
      });
      return connection;
    },

    list() {
      return store.db
        .select()
        .from(connections)
        .orderBy(asc(connections.provider), asc(connections.account))
        .all()
        .map(toConnection);
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
}

/** Sin `secretRef` a propósito: es un detalle del core, la API no lo necesita. */
function toConnection(row: typeof connections.$inferSelect): Connection {
  return {
    provider: row.provider,
    account: row.account,
    scopes: row.scopes,
    status: row.status,
    ...(row.expiresAt === null ? {} : { expiresAt: row.expiresAt }),
  };
}

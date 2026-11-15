import { createORPCClient } from "@orpc/client";
import { RPCLink } from "@orpc/client/fetch";
import type { ContractRouterClient } from "@orpc/contract";
import type { Contract } from "./contract";
import { UI_KEY_HEADER, type ClientOrigin } from "./domain";

export type Client = ContractRouterClient<Contract>;

/**
 * Cliente tipado del core. `url` es el endpoint `/rpc`; `token` y `origin` viajan en cada request.
 * `uiKey` (la llave de la app) es lo que el core exige para aceptar el origin `ui`.
 */
export function createClient(opts: { url: string; token: string; origin: ClientOrigin; uiKey?: string }): Client {
  const link = new RPCLink({
    url: opts.url,
    headers: {
      authorization: `Bearer ${opts.token}`,
      "x-clanker-origin": opts.origin,
      ...(opts.uiKey !== undefined && { [UI_KEY_HEADER]: opts.uiKey }),
    },
  });
  return createORPCClient(link);
}

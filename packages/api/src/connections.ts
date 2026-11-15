import * as z from "zod";

/** Quién emite el token: GitHub (PAT en la fase 1, GitHub App después) y Linear (OAuth). */
export const ConnectionProvider = z.enum(["github", "linear"]);
export type ConnectionProvider = z.infer<typeof ConnectionProvider>;

export const ConnectionStatus = z.enum(["active", "expired", "revoked"]);
export type ConnectionStatus = z.infer<typeof ConnectionStatus>;

/**
 * Una cuenta conectada a un proveedor, tal como la ven la UI y la CLI. El token nunca viaja por la
 * API: vive en el core detrás de `Secrets` y esta forma no tiene dónde llevarlo.
 */
export const Connection = z.object({
  provider: ConnectionProvider,
  account: z.string().min(1),
  scopes: z.array(z.string()),
  status: ConnectionStatus,
  /** ms epoch; ausente si el token no vence. */
  expiresAt: z.int().nonnegative().optional(),
});
export type Connection = z.infer<typeof Connection>;

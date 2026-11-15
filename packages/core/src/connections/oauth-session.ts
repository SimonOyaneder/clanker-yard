import * as z from "zod";

/**
 * Lo que `Secrets` guarda de una cuenta cuyo access token vence (Linear, GitHub App): el refresh token
 * rota con cada refresh, así que va junto al access token y se guardan siempre a la vez.
 */
export const OAuthSession = z.object({
  accessToken: z.string().min(1),
  refreshToken: z.string().min(1),
  /** ms epoch. */
  accessExpiresAt: z.int(),
});
export type OAuthSession = z.infer<typeof OAuthSession>;

import * as z from "zod";

/**
 * Quién emite el token: GitHub (PAT en la fase 1, GitHub App después), Linear (OAuth) y Claude (el
 * login del `claude` instalado, o una API key). La cuenta de Claude es su modo (`ClaudeMode`).
 */
export const ConnectionProvider = z.enum(["github", "linear", "claude", "codex"]);
export type ConnectionProvider = z.infer<typeof ConnectionProvider>;

/** Cómo se conectó GitHub: con un PAT classic pegado a mano o con el device flow de la GitHub App. */
export const GitHubAuth = z.enum(["pat", "app"]);
export type GitHubAuth = z.infer<typeof GitHubAuth>;

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
  /** `true` solo si sigue activa y el token vence en 7 días o menos: la UI avisa para rotarlo. */
  expiresSoon: z.boolean().optional(),
  /** Solo en GitHub. Con `app`, `expiresAt` es el vencimiento del refresh token, que el core renueva solo. */
  auth: GitHubAuth.optional(),
});
export type Connection = z.infer<typeof Connection>;

/**
 * Cómo crear el PAT classic de GitHub: un link que abre el formulario con la descripción y los scopes
 * ya marcados, y la misma lista de scopes para marcarlos a mano si el link no sirve.
 */
export const GitHubPatForm = z.object({
  url: z.url(),
  scopes: z.array(z.string()),
});
export type GitHubPatForm = z.infer<typeof GitHubPatForm>;

/**
 * El código que el usuario escribe en `verificationUri` para aprobar la GitHub App (device flow). La
 * cuenta aparece sola, con un `connection.changed`, cuando aprueba.
 */
export const GitHubDeviceFlow = z.object({
  userCode: z.string().min(1),
  verificationUri: z.url(),
  /** Segundos que dura el código desde que se emitió; después hay que iniciar de nuevo. Relativo: el reloj de la ventana puede no coincidir con el del core. */
  expiresIn: z.int().positive(),
});
export type GitHubDeviceFlow = z.infer<typeof GitHubDeviceFlow>;

/**
 * Por qué terminó mal un login (`connection.login_failed`): `denied` es que el usuario canceló en el
 * proveedor, `expired` que el código o el plazo venció sin aprobarse, `failed` cualquier otra cosa.
 */
export const LoginFailure = z.enum(["denied", "expired", "failed"]);
export type LoginFailure = z.infer<typeof LoginFailure>;

/**
 * Si la GitHub App está instalada para la cuenta conectada. Sin instalación el token de usuario conecta
 * bien pero no ve ningún repo.
 */
export const GitHubInstallations = z.object({
  count: z.int().nonnegative(),
  /** Dónde instalar la App; solo si el core sabe cómo se llama (`githubApp.slug`). */
  installUrl: z.url().optional(),
});
export type GitHubInstallations = z.infer<typeof GitHubInstallations>;

/** Con qué credencial corre Claude: el login de suscripción de quien instaló la app, o una API key. */
export const ClaudeMode = z.enum(["subscription", "api-key"]);
export type ClaudeMode = z.infer<typeof ClaudeMode>;

export const ClaudeState = z.enum([
  "ready",
  "not_installed",
  "outdated",
  "login_required",
  "login_expired",
  "key_rejected",
  "quota_exhausted",
  "error",
]);
export type ClaudeState = z.infer<typeof ClaudeState>;

/** Una ventana de la cuota de la suscripción (5 horas o 7 días). */
export const ClaudeUsageWindow = z.object({
  /** 0 a 1. */
  utilization: z.number().min(0),
  /** ms epoch. */
  resetsAt: z.int().nonnegative().optional(),
});
export type ClaudeUsageWindow = z.infer<typeof ClaudeUsageWindow>;

/** Lo que `connections.testClaude` averiguó: qué hay instalado, quién paga, el plan y cuánto va usado. */
export const ClaudeStatus = z.object({
  mode: ClaudeMode,
  state: ClaudeState,
  /** Qué hacer cuando `state` no es `ready` o `quota_exhausted`; en `quota_exhausted`, cuándo se reinicia. */
  message: z.string().optional(),
  /** El `claude` detectado (suscripción). */
  executable: z.string().optional(),
  version: z.string().optional(),
  /** `subscriptionType` del login (`pro`, `max`, `team`...); sin él con API key. */
  plan: z.string().optional(),
  /** Solo con suscripción y si la respuesta trajo el evento de límites. */
  usage: z.object({ fiveHour: ClaudeUsageWindow.optional(), sevenDay: ClaudeUsageWindow.optional() }).optional(),
  /** ms epoch en que se reinicia la cuota, con `quota_exhausted`. */
  resetsAt: z.int().nonnegative().optional(),
});
export type ClaudeStatus = z.infer<typeof ClaudeStatus>;

export const CodexState = z.enum([
  "ready",
  "not_installed",
  "outdated",
  "login_required",
  "login_expired",
  "quota_exhausted",
  "error",
]);
export type CodexState = z.infer<typeof CodexState>;

export const CodexStatus = z.object({
  state: CodexState,
  message: z.string().optional(),
  executable: z.string().optional(),
  version: z.string().optional(),
  plan: z.string().optional(),
  usage: z.object({
    windows: z.array(z.object({
      id: z.string(),
      label: z.string().optional(),
      windowMins: z.number().nullable(),
      usedPercent: z.number(),
      resetsAt: z.int().nonnegative().optional(),
    })),
    credits: z.object({
      hasCredits: z.boolean(),
      unlimited: z.boolean(),
      balance: z.string().nullable(),
    }).optional(),
  }).optional(),
  resetsAt: z.int().nonnegative().optional(),
});
export type CodexStatus = z.infer<typeof CodexStatus>;

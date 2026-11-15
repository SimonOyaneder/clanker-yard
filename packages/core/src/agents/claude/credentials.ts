import { accessSync, constants, realpathSync } from "node:fs";
import { delimiter, join } from "node:path";

/**
 * El enchufe de credenciales del adapter de Claude (`docs/claude-subscription.md`). Ninguna fábrica
 * lee ni guarda el login de la suscripción: lo lee el `claude` que se lanza, sin modificar.
 */
export interface ClaudeCredentials {
  /** `claude` sin modificar con el que el usuario inició sesión. Sin él se usa el que trae el SDK. */
  executable: string | undefined;
  /** Variables de credencial que se suman al entorno del agente. Con suscripción, ninguna. */
  env(): Record<string, string>;
  /** Qué credencial gasta el run; el adapter exige que `system:init` lo confirme. */
  mode: "subscription" | "api-key";
}

export interface SubscriptionOptions {
  /** Ruta del `claude` a lanzar. Por defecto el primero del `PATH`. */
  executable?: string;
  env?: Record<string, string | undefined>;
}

/** El login del usuario: el binario lo lee solo (Keychain en macOS). */
export function subscriptionCredentials(options: SubscriptionOptions = {}): ClaudeCredentials {
  return {
    executable: options.executable ?? findClaude(options.env ?? process.env),
    env: () => ({}),
    mode: "subscription",
  };
}

/** Alternativa explícita: la key la guarda quien llama en el almacén seguro, nunca este módulo. */
export function apiKeyCredentials(
  apiKey: string,
  options: SubscriptionOptions = {},
): ClaudeCredentials {
  return {
    executable: options.executable ?? findClaude(options.env ?? process.env),
    env: () => ({ ANTHROPIC_API_KEY: apiKey }),
    mode: "api-key",
  };
}

/** El `claude` del `PATH`, con los symlinks resueltos (`~/.local/bin/claude` apunta a la versión instalada). */
export function findClaude(env: Record<string, string | undefined>): string | undefined {
  for (const dir of (env.PATH ?? "").split(delimiter)) {
    if (dir === "") continue;
    const candidate = join(dir, "claude");
    try {
      accessSync(candidate, constants.X_OK);
      return realpathSync(candidate);
    } catch {
      // no está en este directorio
    }
  }
  return undefined;
}

/**
 * Dónde viven los tokens (PAT de GitHub, OAuth de Linear...). Solo el core la usa: la base guarda
 * la `ref` y nada más, y los tokens no llegan a la UI ni al entorno de los agentes.
 *
 * Nunca guarda el token OAuth de la suscripción de Claude: el binario de Claude Code lee su propio
 * login (`docs/claude-subscription.md`).
 */
export interface Secrets {
  /** `undefined` si no hay nada guardado bajo `ref`. */
  get(ref: string): Promise<string | undefined>;
  /** Crea o reemplaza el valor de `ref`. */
  set(ref: string, value: string): Promise<void>;
  /** Borrar una `ref` que no existe no es un error. */
  delete(ref: string): Promise<void>;
}

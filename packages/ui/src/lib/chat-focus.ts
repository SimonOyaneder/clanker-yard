/**
 * "Chatear sobre este PR" abre la vista del PR con el chat enfocado: quien la pide deja aquí el PR, y la vista lo da por
 * atendido recién cuando el composer quedó con el foco (la vista puede montarse más de una vez al navegar). Así ni la ruta
 * ni los props de la app cargan con un flag de un solo uso.
 */
let pending: string | null = null

export function requestChatFocus(prId: string): void {
  pending = prId
}

/** Si alguien pidió abrir este PR con el chat enfocado y todavía no se atendió. */
export function wantsChatFocus(prId: string): boolean {
  return pending === prId
}

export function chatFocusDone(prId: string): void {
  if (pending === prId) pending = null
}

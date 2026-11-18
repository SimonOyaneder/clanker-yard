/**
 * "Chatear sobre este PR" abre la vista del PR con el chat enfocado: quien la pide deja aquí el PR y la vista, al
 * montarse, lo toma una sola vez. Así ni la ruta ni los props de la app cargan con un flag de un solo uso.
 */
let pending: string | null = null

export function requestChatFocus(prId: string): void {
  pending = prId
}

/** `true` (una vez) si alguien pidió abrir este PR con el chat enfocado. */
export function takeChatFocus(prId: string): boolean {
  if (pending !== prId) return false
  pending = null
  return true
}

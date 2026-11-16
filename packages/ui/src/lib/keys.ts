/** Donde se escribe: un atajo de una tecla no aplica con el foco ahí. */
const EDITABLE = "input, textarea, select, [contenteditable='true']"

/** Lo que se abre encima de una vista (diálogo, menú, lista de opciones) y se queda con el teclado. */
const OVERLAY = '[role="dialog"], [role="menu"], [role="listbox"]'

/**
 * Si el foco del evento está en un campo donde se escribe, o dentro de algo de `extra` (`"[role='dialog']"`, para
 * un atajo que no debe correr con el foco en un diálogo): ahí la tecla es texto, no un atajo.
 */
export function isTypingTarget(target: EventTarget | null, extra: readonly string[] = []): boolean {
  return target instanceof Element && target.closest([EDITABLE, ...extra].join(", ")) !== null
}

/** Si hay un diálogo, menú o lista abierta: los atajos de la vista de abajo no compiten con ella. */
export function overlayOpen(): boolean {
  return document.querySelector(OVERLAY) !== null
}

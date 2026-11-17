// Los errores que se le muestran a quien llamó a la API, con el mensaje tal cual: `toApiError` (`server/router.ts`)
// los traduce por su base. Un error de dominio nuevo extiende uno de estos; uno que no, llega como un 500 sin mensaje
// y la vista no puede decir qué hacer.

/** Lo pedido no existe (una corrida, un proyecto, un PR...). */
export class NotFoundError extends Error {}

/** Lo pedido no se puede hacer así: el mensaje dice qué cambiar. */
export class BadRequestError extends Error {}

/** Solo lo puede hacer una persona desde la app (origin `ui`): lo que publica con su identidad o entra a los briefs sin otra revisión. */
export class UiOnlyError extends Error {}

/** Lanza `UiOnlyError` con `message` (por qué y dónde hacerlo) si `origin` no es la app. */
export function requireUiOrigin(origin: string, message: string): void {
  if (origin !== "ui") throw new UiOnlyError(message);
}

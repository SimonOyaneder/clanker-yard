import { ORPCError, os } from "@orpc/server";
import { BadRequestError, NotFoundError, UiOnlyError } from "../errors/domain";

/**
 * Un error del dominio como error de la API, con su mensaje: lo que no existe (`NOT_FOUND`), un pedido que no se
 * puede hacer así (`BAD_REQUEST`) y lo que solo pide una persona desde la app (`FORBIDDEN`). El resto es un bug del
 * core y sale como un 500 sin detalle.
 */
export function toApiError(error: unknown): unknown {
  if (error instanceof NotFoundError) return new ORPCError("NOT_FOUND", { message: error.message, cause: error });
  if (error instanceof BadRequestError) return new ORPCError("BAD_REQUEST", { message: error.message, cause: error });
  if (error instanceof UiOnlyError) return new ORPCError("FORBIDDEN", { message: error.message, cause: error });
  return error;
}

/** El middleware de los routers del core: todo handler traduce sus errores con `toApiError`. */
export const mapApiErrors = os.middleware(async ({ next }) => {
  try {
    return await next();
  } catch (error) {
    throw toApiError(error);
  }
});

import { PermanentActionError } from "../flows/catalog";
import type { Workspaces, WorkspaceRef } from "../workspaces/workspaces";

/**
 * `workspaces.push` con sus outcomes vueltos lo que una acción debe lanzar: un lease rechazado (alguien
 * más pusheó) no se arregla reintentando, y un 401 sí puede (reconectando la cuenta), así que ese
 * lanza con su backoff.
 */
export async function pushOrThrow(
  workspaces: Workspaces,
  ws: WorkspaceRef,
  account: string,
  { council }: { council: boolean },
): Promise<void> {
  const outcome = await workspaces.push(ws, { council });
  if (outcome === "lease-rejected") {
    throw new PermanentActionError(`${ws.branch} ya no está donde el core la dejó en el remoto: alguien más pusheó.`);
  }
  if (outcome === "unauthorized") {
    throw new Error(`GitHub rechazó el token de ${account}: reconecta la cuenta para pushear ${ws.branch}.`);
  }
}

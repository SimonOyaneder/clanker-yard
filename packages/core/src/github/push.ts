import type { PrRef } from "@clanker/api";
import { and, eq } from "drizzle-orm";
import { PermanentActionError } from "../flows/catalog";
import { pullRequests, workspaces as workspacesTable } from "../store/schema";
import type { Store } from "../store/store";
import type { RepoConfig, Workspaces, WorkspaceRef } from "../workspaces/workspaces";

/** Qué iba a hacer la acción con el PR, para los mensajes de `ownedOpenPr`. */
export interface PrPurpose {
  /** Lo que no se puede sin remoto: `"pushear"`. */
  needsRemote: string;
  /** Lo que falta sin un PR abierto pusheado: `"no hay a qué pushear fixups"`. */
  missing: string;
  /** Lo que no se le hace a un PR que el sistema no abrió: `"no se le pushean fixups"`. */
  notOwned: string;
}

/**
 * El PR abierto de la branch del workspace, tal como lo registró `pr.publish`, con el remoto de su repo
 * y lo último que el core pusheó. Lanza `PermanentActionError` si el workspace no existe, el repo no tiene
 * remoto, no hay un PR abierto pusheado o el PR no lo abrió el sistema: Watch también deja en
 * `pull_requests` los PRs tuyos que el sistema no abrió, y esos nunca se reescriben ni se pushean.
 */
export function ownedOpenPr(
  deps: { store: Store; repoConfig: (repoId: string) => RepoConfig },
  ws: { workspaceId: string; branch: string },
  purpose: PrPurpose,
): { remote: NonNullable<RepoConfig["remote"]>; ref: PrRef; remoteSha: string } {
  const row = deps.store.db.select().from(workspacesTable).where(eq(workspacesTable.id, ws.workspaceId)).get();
  if (!row) throw new PermanentActionError(`No existe el workspace ${ws.workspaceId}.`);
  const { remote } = deps.repoConfig(row.repoId);
  if (!remote) throw new PermanentActionError(`El repo ${row.repoId} no tiene remoto configurado: no se puede ${purpose.needsRemote}.`);
  const pull = deps.store.db
    .select()
    .from(pullRequests)
    .where(and(eq(pullRequests.repoId, row.repoId), eq(pullRequests.headRef, ws.branch), eq(pullRequests.state, "open")))
    .get();
  if (!pull || !row.remoteSha) throw new PermanentActionError(`${ws.branch} no tiene un PR abierto pusheado: ${purpose.missing}.`);
  if (!pull.owned) throw new PermanentActionError(`El PR #${pull.number} de ${remote.repo} no lo abrió Clanker Yard: ${purpose.notOwned}.`);
  return { remote, ref: { account: remote.account, repo: remote.repo, number: pull.number }, remoteSha: row.remoteSha };
}

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

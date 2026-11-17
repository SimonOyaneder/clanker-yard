import type { PrRef } from "@clanker/api";
import type { Connections } from "../connections/connections";

/**
 * Comenta en la conversación del PR con el token de su cuenta. Un 401 ya deja la conexión `revoked` en el
 * cliente (`onUnauthorized`) y el error sigue su camino.
 */
export async function commentOnPr(connections: Pick<Connections, "githubClient">, ref: PrRef, body: string): Promise<void> {
  const [owner, repo] = ref.repo.split("/") as [string, string];
  await connections.githubClient(ref.account).request("POST /repos/{owner}/{repo}/issues/{issue_number}/comments", { owner, repo, issue_number: ref.number, body });
}

import type { PrRef } from "@clanker/api";
import { RequestError } from "@octokit/request-error";
import type { Connections } from "../connections/connections";

/**
 * Comenta en la conversación del PR con el token de su cuenta. Un 401 deja la conexión `revoked` y el error
 * sigue su camino.
 */
export async function commentOnPr(connections: Pick<Connections, "githubClient" | "markRevoked">, ref: PrRef, body: string): Promise<void> {
  const [owner, repo] = ref.repo.split("/") as [string, string];
  try {
    await connections.githubClient(ref.account).request("POST /repos/{owner}/{repo}/issues/{issue_number}/comments", { owner, repo, issue_number: ref.number, body });
  } catch (error) {
    if (error instanceof RequestError && error.status === 401) connections.markRevoked("github", ref.account, "core");
    throw error;
  }
}

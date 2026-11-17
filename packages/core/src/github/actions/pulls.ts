import type { RunId } from "@clanker/api";
import { RequestError } from "@octokit/request-error";
import * as z from "zod";
import { openDecision } from "../../decisions/decisions";
import { messageOf } from "../../errors/format";
import type { Store } from "../../store/store";
import type { GitHubClient } from "../client";

// Lo que `pr.publish` y `pr.promote` le piden a la API REST de GitHub sobre un PR: buscar el abierto de una branch,
// abrirlo y asignarlo.

/** Lo que la acción lee de un PR de la API REST. */
export const Pull = z.object({
  number: z.int().positive(),
  node_id: z.string(),
  html_url: z.string(),
  state: z.enum(["open", "closed"]),
  draft: z.boolean(),
  head: z.object({ sha: z.string() }),
});
export type Pull = z.infer<typeof Pull>;

/**
 * Asigna el PR a la cuenta con que se publicó. Un fallo (p. ej. sin permiso) no tumba la publicación: queda una nota
 * en la Bandeja. Un 401 sí lo relanza, para que el flujo del 401 de `pr.publish` marque la conexión revocada.
 */
export async function assignOrNote(store: Store, client: GitHubClient, runId: RunId, pr: { owner: string; repo: string; number: number; assignee: string }): Promise<void> {
  try {
    await client.request("POST /repos/{owner}/{repo}/issues/{issue_number}/assignees", {
      owner: pr.owner,
      repo: pr.repo,
      issue_number: pr.number,
      assignees: [pr.assignee],
    });
  } catch (error) {
    if (error instanceof RequestError && error.status === 401) throw error;
    const why = messageOf(error);
    store.tx((tx) =>
      openDecision(tx, {
        kind: "note",
        title: `${pr.owner}/${pr.repo}#${pr.number} quedó sin assignee`,
        body: `No se pudo asignar el PR a ${pr.assignee}: ${why}. La publicación siguió; asígnalo a mano si hace falta.`,
        runId,
      }),
    );
  }
}

export async function findOpenPull(client: GitHubClient, owner: string, repo: string, branch: string): Promise<Pull | undefined> {
  const { data } = await client.request("GET /repos/{owner}/{repo}/pulls", {
    owner,
    repo,
    head: `${owner}:${branch}`,
    state: "open",
  });
  return z.array(Pull).parse(data)[0];
}

export async function openPull(
  client: GitHubClient,
  owner: string,
  repo: string,
  pull: { title: string; body: string; head: string; base: string; draft: boolean },
): Promise<Pull> {
  const { data } = await client.request("POST /repos/{owner}/{repo}/pulls", { owner, repo, ...pull });
  return Pull.parse(data);
}

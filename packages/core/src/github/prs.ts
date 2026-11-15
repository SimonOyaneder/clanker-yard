import type { PrRef, PrState } from "@clanker/api";
import { RequestError } from "@octokit/request-error";
import type { Connections } from "../connections/connections";
import type { Packs } from "../packs/packs";
import { fetchPr } from "./pr-query";
import { buildPrState } from "./pr-state";

export interface Prs {
  /**
   * Lee el PR con GraphQL y lo normaliza con el pack de la org del repo (o los defaults neutros). Lanza
   * `PrNotFoundError` si no existe o la cuenta no lo ve. Si GitHub rechaza el token (401) deja la
   * conexión `revoked` y relanza el error.
   */
  get(ref: PrRef): Promise<PrState>;
}

export function createPrs({ connections, packs }: { connections: Connections; packs: Packs }): Prs {
  return {
    async get({ account, repo, number }) {
      // PrRef ya garantiza `owner/repo`.
      const [owner, name] = repo.split("/") as [string, string];
      try {
        const node = await fetchPr(connections.githubClient(account), { owner, name }, number);
        return buildPrState(node, { pack: packs.packFor({ githubOrg: owner }), viewer: account });
      } catch (error) {
        if (error instanceof RequestError && error.status === 401) connections.markRevoked("github", account, "core");
        throw error;
      }
    },
  };
}

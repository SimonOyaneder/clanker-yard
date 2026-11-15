import type { PrRef, PrState } from "@clanker/api";
import { RequestError } from "@octokit/request-error";
import type { Connections } from "../connections/connections";
import type { Packs } from "../packs/packs";
import type { MergeScope } from "./merge-scope";
import { fetchPr } from "./pr-query";
import { buildPrState } from "./pr-state";

export interface Prs {
  /**
   * Lee el PR con GraphQL y lo normaliza con el pack de la org del repo (o los defaults neutros), con su
   * `hold` y si la estrategia de merge del pack aplica al repo (`MergeScope`). Lanza
   * `PrNotFoundError` si no existe o la cuenta no lo ve. Si GitHub rechaza el token (401) deja la
   * conexión `revoked` y relanza el error.
   */
  get(ref: PrRef): Promise<PrState>;
}

export interface PrsDeps {
  connections: Connections;
  packs: Packs;
  /** El `hold` de cada PR y si la estrategia de merge aplica al repo. Sin él ningún PR está en hold y la estrategia aplica siempre. */
  merge?: MergeScope;
}

export function createPrs({ connections, packs, merge }: PrsDeps): Prs {
  return {
    async get({ account, repo, number }) {
      // PrRef ya garantiza `owner/repo`.
      const [owner, name] = repo.split("/") as [string, string];
      try {
        const node = await fetchPr(connections.githubClient(account), { owner, name }, number);
        const pack = packs.packFor({ githubOrg: owner });
        const ref = { account, repo, number };
        const mergeApplies = pack.mergeStrategy && merge ? await merge.applies(ref, pack.mergeStrategy) : true;
        return buildPrState(node, { pack, viewer: account, hold: merge?.hold(ref) ?? false, mergeApplies });
      } catch (error) {
        if (error instanceof RequestError && error.status === 401) connections.markRevoked("github", account, "core");
        throw error;
      }
    },
  };
}

import type { Store } from "@clanker/core";
import { seedPr } from "@clanker/core/testing";
import type { GitHubSim } from "./github-sim";

/** Las ramas de los padres ya están publicadas sobre main al comenzar el caso de restack. */
export function seedPublishedParents(store: Store, github: GitHubSim, branches: string[]): void {
  const parents = branches.map((head) => github.openPr({ head, title: `[${head}] cambio`, draft: true }).number);
  for (const pr of github.pulls()) {
    if (parents.includes(pr.number)) {
      seedPr(store, { repoId: "repo_r1", number: pr.number, nodeId: pr.node_id, headRef: pr.head.ref, headSha: pr.head.sha, isDraft: true });
    }
  }
}

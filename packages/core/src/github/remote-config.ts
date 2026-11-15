import type { Connections } from "../connections/connections";
import type { RepoConfig } from "../workspaces/workspaces";

/** La URL explícita de un repo de GitHub: el core nunca pushea al `origin` del checkout, que puede ser SSH. */
export const githubUrl = (repo: string): string => `https://github.com/${repo}.git`;

/**
 * Arma `RepoConfig.remote` para el repo `owner/name` de la columna `repos.remote`: su URL y la cuenta de
 * GitHub conectada que pushea y abre el PR (la de la org del repo si hay varias, si no la primera).
 * Sin una cuenta de GitHub conectada el repo no tiene remoto: no hay push, fetch ni PR hasta conectarla.
 */
export function githubRemote(
  connections: Pick<Connections, "list">,
  url: (repo: string) => string = githubUrl,
): (repo: string) => RepoConfig["remote"] {
  return (repo) => {
    const accounts = connections.list().filter((c) => c.provider === "github");
    const owner = repo.split("/")[0];
    const account = accounts.find((c) => c.account === owner) ?? accounts[0];
    return account && { url: url(repo), repo, account: account.account };
  };
}

import type { Connections } from "../connections/connections";
import type { RepoConfig } from "../workspaces/workspaces";
import { tryGit } from "./git";

/** Autor y committer de los commits que salen de un repo: la persona dueña del checkout. */
export interface GitIdentity {
  name: string;
  email: string;
}

/**
 * Resuelve quién firma los commits de un repo, una vez por repo (se cachea hasta que el core se reinicia).
 *
 * Sale de `git config user.name` y `user.email` en el checkout, que respeta la config local y la global como
 * si el usuario commiteara. Sin email (o sin nombre), de la cuenta de GitHub conectada del repo: su nombre (o su login) y el
 * noreply `<id>+<login>@users.noreply.github.com`, que GitHub siempre liga a la cuenta. Nunca hay una
 * identidad del sistema: sin ninguna de las dos fuentes lanza, con el modo de arreglarlo.
 */
export type GitIdentityOf = (repoId: string) => Promise<GitIdentity>;

export function createGitIdentityOf({
  repoConfig,
  connections,
}: {
  repoConfig: (repoId: string) => RepoConfig;
  connections: Pick<Connections, "githubClient">;
}): GitIdentityOf {
  const cache = new Map<string, Promise<GitIdentity>>();

  async function resolve(repoId: string): Promise<GitIdentity> {
    const cfg = repoConfig(repoId);
    const [email, name] = await Promise.all([tryGit(cfg.path, ["config", "user.email"]), tryGit(cfg.path, ["config", "user.name"])]);
    if (email && name) return { name, email };
    if (!cfg.remote) {
      throw new Error(`No hay identidad de git para ${cfg.path}: configura user.name y user.email en ese repo o conecta tu cuenta de GitHub.`);
    }
    const { data } = await connections.githubClient(cfg.remote.account).request("GET /user");
    return { name: name || data.name || data.login, email: email || `${data.id}+${data.login}@users.noreply.github.com` };
  }

  return (repoId) => {
    let identity = cache.get(repoId);
    if (!identity) {
      identity = resolve(repoId);
      cache.set(repoId, identity);
      // Un fallo (sin red, sin conexión) no se queda cacheado: el próximo commit lo reintenta.
      identity.catch(() => cache.delete(repoId));
    }
    return identity;
  };
}

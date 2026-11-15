import type { GitHubPatForm } from "@clanker/api";
import { RequestError } from "@octokit/request-error";
import { createGitHubClient, isRateLimited, type GitHubApiOptions, type GitHubClient } from "./client";

/** El token no sirve para Clanker Yard; el mensaje dice qué cambiar. */
export class GitHubPatError extends Error {
  override name = "GitHubPatError";
}

/**
 * Lo que Clanker Yard necesita de un fine-grained PAT (`docs/design.html#integraciones`). `write` en
 * contents (push), pull requests (abrir y editar PRs) e issues (los comentarios de un PR son
 * comentarios de issue); checks y commit statuses solo se leen (el CI de un PR mezcla check runs y
 * status contexts como el de merge-queue). `probe` es el endpoint de lectura con el que se verifica.
 */
const PERMISSIONS = [
  { name: "contents", label: "Contents", access: "write", probe: "GET /repos/{owner}/{repo}/commits" },
  { name: "pull_requests", label: "Pull requests", access: "write", probe: "GET /repos/{owner}/{repo}/pulls" },
  { name: "issues", label: "Issues", access: "write", probe: "GET /repos/{owner}/{repo}/issues" },
  { name: "checks", label: "Checks", access: "read", probe: "GET /repos/{owner}/{repo}/commits/{ref}/check-runs" },
  { name: "statuses", label: "Commit statuses", access: "read", probe: "GET /repos/{owner}/{repo}/commits/{ref}/status" },
] as const;

/**
 * El link abre el formulario de fine-grained PAT con nombre, vencimiento y permisos marcados (la
 * documentación de GitHub lo define como "URL template for pre-filling"; decisión #49). Se probó solo
 * contra la documentación, no contra github.com. La lista va aparte por si el link deja de servir.
 */
export function githubPatForm(): GitHubPatForm {
  const params = new URLSearchParams({
    name: "Clanker Yard",
    description: "Token de Clanker Yard",
    expires_in: "90",
  });
  for (const { name, access } of PERMISSIONS) params.set(name, access);
  return {
    url: `https://github.com/settings/personal-access-tokens/new?${params}`,
    permissions: PERMISSIONS.map(({ name, label, access }) => ({ name, label, access })),
  };
}

export interface ValidatedPat {
  login: string;
  /** ms epoch; ausente si el token no vence. */
  expiresAt?: number;
  /** Los permisos de `PERMISSIONS` que el token tiene, por nombre. */
  permissions: string[];
}

/**
 * Valida el token contra GitHub: de quién es, que vea repos y un check por permiso. Lanza
 * `GitHubPatError` si no sirve; cualquier otro error (red, 5xx, cuota agotada) sube tal cual.
 *
 * Un fine-grained PAT no lista sus permisos, así que cada uno se prueba con una lectura sobre un repo
 * visible: `403` es permiso faltante. Se prefiere un repo privado, porque en uno público las lecturas
 * pasan sin permiso y el check no distingue nada. Solo se prueba lectura: que `write` esté marcado no
 * se puede comprobar sin escribir.
 */
export async function validatePat(token: string, api: GitHubApiOptions): Promise<ValidatedPat> {
  const github = createGitHubClient({ tokens: { kind: "pat", token: async () => token }, ...api });

  const user = await request(() => github.request("GET /user"));
  const expiresAt = parseExpiration(user.headers["github-authentication-token-expiration"]?.toString());

  const repos = (await github.request("GET /user/repos", { per_page: 100, sort: "pushed" })).data;
  if (repos.length === 0) {
    throw new GitHubPatError(
      "El token no ve ningún repositorio. Al crearlo elige los repositorios (o todos) en \"Repository access\".",
    );
  }
  const repo = repos.find((r) => r.private) ?? repos[0]!;

  const checks = await Promise.all(
    PERMISSIONS.map(async ({ name, probe }) => ({
      name,
      granted: await canRead(github, probe, { owner: repo.owner.login, repo: repo.name, ref: repo.default_branch }),
    })),
  );
  const missing = PERMISSIONS.filter((_, i) => !checks[i]!.granted);
  if (missing.length > 0) {
    const list = missing.map((p) => `${p.label} (${p.access})`).join(", ");
    throw new GitHubPatError(
      `Al token le faltan permisos: ${list}. Crea uno con el formulario ya marcado: ${githubPatForm().url}`,
    );
  }

  return {
    login: user.data.login,
    ...(expiresAt === undefined ? {} : { expiresAt }),
    permissions: PERMISSIONS.map((p) => p.name),
  };
}

async function request<T>(call: () => Promise<T>): Promise<T> {
  try {
    return await call();
  } catch (error) {
    if (error instanceof RequestError && error.status === 401) {
      // GitHub responde lo mismo ("Bad credentials") para un token vencido, revocado o mal pegado.
      throw new GitHubPatError(
        "GitHub rechazó el token: es inválido, está vencido o fue revocado. Crea uno nuevo y vuelve a pegarlo.",
      );
    }
    throw error;
  }
}

async function canRead(
  github: GitHubClient,
  route: string,
  params: { owner: string; repo: string; ref: string },
): Promise<boolean> {
  try {
    await github.request(route, { ...params, per_page: 1 });
    return true;
  } catch (error) {
    if (!(error instanceof RequestError)) throw error;
    if (error.status === 403 && !isRateLimited(error)) return false;
    // Repo vacío (409), sin commits o checks para ese ref (404, 422): el endpoint dejó pasar el token.
    if ([404, 409, 422].includes(error.status)) return true;
    throw error;
  }
}

/** `github-authentication-token-expiration: 2026-12-01 10:00:00 UTC`; ausente si el token no vence. */
function parseExpiration(header: string | undefined): number | undefined {
  if (header === undefined) return undefined;
  const ms = Date.parse(header.replace(" UTC", "Z").replace(" ", "T"));
  if (Number.isNaN(ms)) {
    throw new Error(`GitHub informó un vencimiento que no se entiende: "${header}".`);
  }
  return ms;
}

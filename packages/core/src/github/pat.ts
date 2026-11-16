import type { GitHubPatForm } from "@clanker/api";
import { RequestError } from "@octokit/request-error";
import { createGitHubClient, isRateLimited, type GitHubApiOptions, type GitHubClient } from "./client";

/** El token no sirve para Clanker Yard; el mensaje dice qué cambiar. */
export class GitHubPatError extends Error {
  override name = "GitHubPatError";
}

/**
 * Lo que Clanker Yard necesita de GitHub: `write` en contents (push), pull requests (abrir y editar
 * PRs) e issues (los comentarios de un PR son comentarios de issue); checks y commit statuses solo se
 * leen (el CI de un PR mezcla check runs y status contexts como el de merge-queue). `probe` es el endpoint de
 * lectura con el que se verifica. La GitHub App pide estos mismos permisos (`docs/github-app.md`).
 */
export const PERMISSIONS = [
  { name: "contents", label: "Contents", access: "write", probe: "GET /repos/{owner}/{repo}/commits" },
  { name: "pull_requests", label: "Pull requests", access: "write", probe: "GET /repos/{owner}/{repo}/pulls" },
  { name: "issues", label: "Issues", access: "write", probe: "GET /repos/{owner}/{repo}/issues" },
  { name: "checks", label: "Checks", access: "read", probe: "GET /repos/{owner}/{repo}/commits/{ref}/check-runs" },
  { name: "statuses", label: "Commit statuses", access: "read", probe: "GET /repos/{owner}/{repo}/commits/{ref}/status" },
] as const;

/**
 * Un PAT classic con `repo`, no un fine-grained: GitHub no tiene el permiso "Checks" para los
 * fine-grained PAT, así que con uno la lectura de check runs de un repo privado da 403 y Clanker Yard
 * no puede ver el CI de GitHub Actions. El link abre el formulario de classic con descripción y scope
 * prellenados (`description` y `scopes`, separados por comas, son los parámetros de la URL de GitHub).
 */
const CLASSIC_SCOPE = "repo";
const CLASSIC_FORM_URL = `https://github.com/settings/tokens/new?description=Clanker%20Yard&scopes=${CLASSIC_SCOPE}`;

export function githubPatForm(): GitHubPatForm {
  return { url: CLASSIC_FORM_URL, scopes: [CLASSIC_SCOPE] };
}

export interface ValidatedPat {
  login: string;
  /** ms epoch; ausente si el token no vence. */
  expiresAt?: number;
  /** Los scopes del token (`repo`); vacío si es un fine-grained PAT, que no los tiene. */
  scopes: string[];
}

/**
 * Valida el token contra GitHub: de quién es, que vea repos y un check por permiso. Lanza
 * `GitHubPatError` si no sirve; cualquier otro error (red, 5xx, cuota agotada) sube tal cual.
 *
 * Un token classic informa sus scopes en `x-oauth-scopes` y debe tener `repo`; un fine-grained no manda
 * ese header. En ambos cada permiso de `PERMISSIONS` se prueba con una lectura sobre un repo visible:
 * `403` es permiso faltante. Se prefiere un repo privado, porque en uno público las lecturas
 * pasan sin permiso y el check no distingue nada. Solo se prueba lectura: que `write` esté marcado no
 * se puede comprobar sin escribir.
 */
export async function validatePat(token: string, api: GitHubApiOptions): Promise<ValidatedPat> {
  const github = createGitHubClient({ tokens: { kind: "pat", token: async () => token }, ...api });

  const user = await request(() => github.request("GET /user"));
  const scopesHeader = user.headers["x-oauth-scopes"]?.toString();
  const scopes = scopesHeader === undefined ? [] : scopesHeader.split(",").map((scope) => scope.trim()).filter(Boolean);
  if (scopesHeader !== undefined && !scopes.includes(CLASSIC_SCOPE)) {
    throw new GitHubPatError(
      `Al token le falta el scope \`${CLASSIC_SCOPE}\` (tiene: ${scopes.join(", ") || "ninguno"}). Crea uno con el formulario ya marcado: ${CLASSIC_FORM_URL}`,
    );
  }
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
  if (missing.length > 0 && scopesHeader === undefined) {
    throw new GitHubPatError(
      `Los fine-grained PAT no tienen el permiso Checks, que Clanker Yard necesita para leer el CI de los repos privados. Crea un token classic con el scope \`${CLASSIC_SCOPE}\`: ${CLASSIC_FORM_URL}`,
    );
  }
  if (missing.length > 0) {
    const list = missing.map((p) => p.label).join(", ");
    throw new GitHubPatError(
      `El token no puede leer ${list} del repo ${repo.full_name}. Si el repo es de una organización con SSO, autoriza el token en github.com/settings/tokens (Configure SSO).`,
    );
  }

  return {
    login: user.data.login,
    ...(expiresAt === undefined ? {} : { expiresAt }),
    scopes,
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

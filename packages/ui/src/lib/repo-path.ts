const OWNER_REPO = /^\/?[\w.-]+\/[\w.-]+$/
const GITHUB_URL = /^(https?:\/\/(www\.)?github\.com\/|git@github\.com:|ssh:\/\/git@github\.com\/|github\.com\/)/i

/** Si lo escrito es el `owner/repo` de GitHub (con o sin `/` delante) o una URL de GitHub, no la carpeta de un checkout. */
export function looksLikeGitHubRepo(input: string): boolean {
  const value = input.trim()
  return GITHUB_URL.test(value) || OWNER_REPO.test(value)
}

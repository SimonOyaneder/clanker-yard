import { readFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { messageOf } from "../errors/format";

/** Variable de entorno que pisa `githubApp.clientId` del archivo; sirve en dev y en tests. */
export const GITHUB_APP_CLIENT_ID_ENV = "CLANKER_GITHUB_APP_CLIENT_ID";

/** Variable de entorno que pisa `githubApp.slug` del archivo. */
export const GITHUB_APP_SLUG_ENV = "CLANKER_GITHUB_APP_SLUG";

/** Variable de entorno que pisa `linear.clientId` del archivo. */
export const LINEAR_CLIENT_ID_ENV = "CLANKER_LINEAR_CLIENT_ID";

const ClientId = z.strictObject({ clientId: z.string().trim().min(1) });
const GitHubApp = z.strictObject({ clientId: z.string().trim().min(1), slug: z.string().trim().min(1).optional() });

const ConfigFile = z.strictObject({
  githubApp: GitHubApp.optional(),
  linear: ClientId.optional(),
});

/** La configuración del core que el usuario escribe a mano (`docs/github-app.md`). */
export interface CoreConfig {
  /** El client_id de la GitHub App; sin él no se puede iniciar el device flow. */
  githubApp?: { clientId: string; slug?: string };
  /** El client_id de la OAuth app de Linear; sin él `connections` usa el que trae incluido. */
  linear?: { clientId: string };
}

/**
 * Lee `<dataDir>/config.json` y le aplica el entorno encima. El archivo existe porque una app lanzada
 * desde el Dock no hereda las variables de la terminal. Sin archivo, la config es la del entorno; un
 * archivo que no se entiende lanza con el motivo, porque ignorarlo dejaría la conexión sin configurar
 * sin avisar.
 */
export function readCoreConfig(dataDir: string, env: Record<string, string | undefined> = process.env): CoreConfig {
  const config = readConfigFile(join(dataDir, "config.json"));
  const githubApp = env[GITHUB_APP_CLIENT_ID_ENV]?.trim() || config.githubApp?.clientId;
  const slug = env[GITHUB_APP_SLUG_ENV]?.trim() || config.githubApp?.slug;
  const linear = env[LINEAR_CLIENT_ID_ENV]?.trim() || config.linear?.clientId;
  return {
    ...(githubApp ? { githubApp: { clientId: githubApp, ...(slug ? { slug } : {}) } } : {}),
    ...(linear ? { linear: { clientId: linear } } : {}),
  };
}

function readConfigFile(path: string): z.infer<typeof ConfigFile> {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw error;
  }
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch (error) {
    throw new Error(`${path} no es JSON válido: ${messageOf(error)}`, { cause: error });
  }
  const parsed = ConfigFile.safeParse(json);
  if (!parsed.success) {
    throw new Error(`${path} no tiene el formato esperado ({ "githubApp": { "clientId": "..." }, "linear": { "clientId": "..." } }): ${z.prettifyError(parsed.error)}`);
  }
  return parsed.data;
}

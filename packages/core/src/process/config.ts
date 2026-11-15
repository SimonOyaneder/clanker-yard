import { readFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";

/** Variable de entorno que pisa `githubApp.clientId` del archivo; sirve en dev y en tests. */
export const GITHUB_APP_CLIENT_ID_ENV = "CLANKER_GITHUB_APP_CLIENT_ID";

const ConfigFile = z
  .object({
    githubApp: z.object({ clientId: z.string().trim().min(1) }).strict().optional(),
  })
  .strict();

/** La configuración del core que el usuario escribe a mano (`docs/github-app.md`). */
export interface CoreConfig {
  /** El client_id de la GitHub App; sin él no se puede iniciar el device flow. */
  githubApp?: { clientId: string };
}

/**
 * Lee `<dataDir>/config.json` y le aplica el entorno encima. El archivo existe porque una app lanzada
 * desde el Dock no hereda las variables de la terminal. Sin archivo, la config es la del entorno; un
 * archivo que no se entiende lanza con el motivo, porque ignorarlo dejaría la conexión sin configurar
 * sin avisar.
 */
export function readCoreConfig(dataDir: string, env: Record<string, string | undefined> = process.env): CoreConfig {
  const config = readConfigFile(join(dataDir, "config.json"));
  const clientId = env[GITHUB_APP_CLIENT_ID_ENV]?.trim() || config.githubApp?.clientId;
  return clientId ? { githubApp: { clientId } } : {};
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
    throw new Error(`${path} no es JSON válido: ${(error as Error).message}`);
  }
  const parsed = ConfigFile.safeParse(json);
  if (!parsed.success) {
    throw new Error(`${path} no tiene el formato esperado ({ "githubApp": { "clientId": "..." } }): ${z.prettifyError(parsed.error)}`);
  }
  return parsed.data;
}

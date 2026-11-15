import path from "node:path";

/**
 * El `core/main.js` que lanza `ensureCore`. En la app empaquetada es un recurso (`extraResources`
 * en `electron-builder.yml`, fuera del asar porque `process.execPath` no ejecuta archivos de dentro);
 * en desarrollo, el bundle que deja `npm run build -w @clanker/core`. Las migraciones van en
 * `../migrations` al lado en los dos casos.
 */
export function coreEntry(app: { isPackaged: boolean; appPath: string; resourcesPath: string }): string {
  return app.isPackaged
    ? path.join(app.resourcesPath, "core/dist/main.js")
    : path.resolve(app.appPath, "../../packages/core/dist/main.js");
}

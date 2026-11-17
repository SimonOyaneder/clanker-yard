/**
 * Las variables `keys` de `source` que están definidas. Cada proceso que lanza el core (git, comandos de la receta,
 * agentes) hereda solo su propia lista blanca: el core puede traer `GH_TOKEN` y otros secretos de la shell que lanzó
 * la app.
 */
export function pickEnv(keys: readonly string[], source: Record<string, string | undefined> = process.env): Record<string, string> {
  const env: Record<string, string> = {};
  for (const key of keys) {
    const value = source[key];
    if (value !== undefined) env[key] = value;
  }
  return env;
}

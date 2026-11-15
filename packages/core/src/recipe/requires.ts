import type { Recipe } from "@clanker/api";

/**
 * Corre los `requires` de la receta (los servicios que el repo necesita vivos: Postgres, Redis...) y devuelve
 * el nombre de los que no responden. Se prueban todos para ver de una vez qué falta. `exec` devuelve el exit
 * del comando ya renderizado.
 */
export async function failedRequires(
  recipe: Pick<Recipe, "requires">,
  render: (template: string) => string,
  exec: (command: string) => Promise<number>,
): Promise<string[]> {
  const down: string[] = [];
  for (const { name, check } of recipe.requires) {
    if ((await exec(render(check))) !== 0) down.push(name);
  }
  return down;
}

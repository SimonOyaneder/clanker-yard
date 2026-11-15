import { RepoId, type DetectedRepo, type RecipeStatus, type Repo } from "@clanker/api";
import { asc, eq } from "drizzle-orm";
import { DefValidationError } from "../defs/defs";
import { readRecipe, RecipeSyntaxError } from "../recipe/recipe";
import { newId } from "../store/conventions";
import { repos } from "../store/schema";
import type { Store } from "../store/store";
import { findRepos, inspectRepo } from "./inspect";
import type { RepoConfig } from "./workspaces";

/** El repo que se pidió no está registrado. */
export class RepoNotFoundError extends Error {
  constructor(id: string) {
    super(`No existe el repo ${id}: regístralo con repos.add.`);
  }
}

/** El repo no se puede registrar: el mensaje dice por qué. */
export class InvalidRepoError extends Error {}

export interface Repos {
  /** Registra un checkout sin mirar git (para código y tests; la API usa `register`). El path es único. Devuelve el id que usan los flujos (`repo`). */
  add(repo: { name: string; path: string; defaultBranch?: string; remote?: string | null }): RepoId;
  /**
   * Registra el repo de `path`, que debe ser la raíz de un checkout de git: la branch por defecto y el
   * remoto de GitHub salen de él. Lanza `NotAGitRepoError` si no lo es e `InvalidRepoError` si ya está registrado.
   */
  register(path: string, name?: string): Promise<Repo>;
  get(id: string): Repo | undefined;
  /** Por nombre. */
  list(): Repo[];
  /** Los repos de git de `folder` con el estado de su receta, registrados o no. */
  detect(folder: string): Promise<DetectedRepo[]>;
  /** La configuración que Workspaces necesita de un repo. Lanza si el id no existe. */
  config(id: string): RepoConfig;
}

export function createRepos(store: Store): Repos {
  const byPath = (path: string) => store.db.select().from(repos).where(eq(repos.path, path)).get();

  const self: Repos = {
    add({ name, path, defaultBranch = "main", remote = null }) {
      const id = newId("repo");
      store.tx((tx) => tx.db.insert(repos).values({ id, name, path, defaultBranch, remote }).run());
      return id;
    },
    async register(path, name) {
      const info = await inspectRepo(path);
      if (byPath(info.path)) throw new InvalidRepoError(`${info.path} ya está registrado.`);
      const id = self.add({ ...info, name: name ?? info.name });
      return self.get(id)!;
    },
    get(id) {
      const repoId = RepoId.safeParse(id);
      return repoId.success ? store.db.select().from(repos).where(eq(repos.id, repoId.data)).get() : undefined;
    },
    list: () => store.db.select().from(repos).orderBy(asc(repos.name), asc(repos.id)).all(),
    async detect(folder) {
      return (await findRepos(folder)).map((info) => ({
        ...info,
        repoId: byPath(info.path)?.id ?? null,
        recipe: recipeStatus(info.path),
      }));
    },
    config(id) {
      const row = self.get(id);
      if (!row) throw new RepoNotFoundError(id);
      return { path: row.path, defaultBranch: row.defaultBranch };
    },
  };
  return self;
}

function recipeStatus(dir: string): RecipeStatus {
  try {
    return readRecipe(dir) === undefined ? { status: "missing" } : { status: "found" };
  } catch (error) {
    if (error instanceof DefValidationError || error instanceof RecipeSyntaxError) {
      return { status: "invalid", message: error.message };
    }
    throw error;
  }
}

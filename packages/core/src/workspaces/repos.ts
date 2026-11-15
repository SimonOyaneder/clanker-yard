import { eq } from "drizzle-orm";
import { newId } from "../store/conventions";
import { repos } from "../store/schema";
import type { Store } from "../store/store";
import type { RepoConfig } from "./workspaces";

export interface Repos {
  /** Registra un checkout de git. El path es único. Devuelve el id que usan los flujos (`repo`). */
  add(repo: { name: string; path: string; defaultBranch?: string }): string;
  /** La configuración que Workspaces necesita de un repo. Lanza si el id no existe. */
  config(id: string): RepoConfig;
}

export function createRepos(store: Store): Repos {
  return {
    add({ name, path, defaultBranch = "main" }) {
      const id = newId("repo");
      store.tx((tx) => tx.db.insert(repos).values({ id, name, path, defaultBranch }).run());
      return id;
    },
    config(id) {
      const row = store.db.select().from(repos).where(eq(repos.id, id)).get();
      if (!row) throw new Error(`No existe el repo ${id}: regístralo antes de lanzar un flujo que lo use.`);
      return { path: row.path, defaultBranch: row.defaultBranch };
    },
  };
}

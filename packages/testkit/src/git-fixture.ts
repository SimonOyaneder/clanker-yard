import { afterAll, beforeAll } from "vitest";
import { copyGitTemplate, tempGitRepo, type TempGitRepo, type TempGitRepoOptions } from "./git";

/** Registra una plantilla por suite. Cada llamada devuelve un repo privado que el caso limpia con cleanup(). */
export function gitFixture(options: TempGitRepoOptions): () => TempGitRepo {
  let template: TempGitRepo;
  beforeAll(() => {
    template = tempGitRepo(options);
  });
  afterAll(() => template?.cleanup());
  return () => copyGitTemplate(template);
}

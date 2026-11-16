import { expect, test } from "vitest"
import { looksLikeGitHubRepo } from "./repo-path"

test.each(["acme/api", "/acme/api", "https://github.com/acme/api", "git@github.com:acme/api.git", "github.com/acme/api"])(
  "%s parece el repo de GitHub",
  (input) => expect(looksLikeGitHubRepo(` ${input} `)).toBe(true),
)

test.each(["/Users/ana/code/api", "~/code/api", "/Users/ana/api", "api", ""])("%s parece una carpeta", (input) => expect(looksLikeGitHubRepo(input)).toBe(false))

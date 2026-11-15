import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { ContextSource } from "@clanker/api";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { createDefs, type Defs } from "../defs/defs";
import { createPacks, type Packs } from "../packs/packs";
import { openStore, type Store } from "../store/store";
import { createContextResolver, type ContextResolver, type ResolvedContext } from "./context";

let root: string;
let cwd: string;
let userDir: string;
let store: Store;
let defs: Defs;
let packs: Packs;
let resolver: ContextResolver;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "context-"));
  cwd = join(root, "worktree");
  userDir = join(root, "claude");
  await mkdir(cwd);
  await mkdir(userDir);
  store = openStore({ path: ":memory:" });
  defs = createDefs(store);
  packs = createPacks({ defs });
  resolver = createContextResolver({ defs, packs, remoteOf: (repoId) => (repoId === "repo_acme" ? "acme/app" : null), userDir });
});
afterEach(async () => {
  vi.unstubAllEnvs();
  store.close();
  await rm(root, { recursive: true, force: true });
});

const write = async (path: string, content: string) => {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, content);
};

const resolve = (sources: ContextSource[], extra: { role?: string; repoId?: string } = {}): Promise<ResolvedContext> =>
  resolver.resolve({ role: extra.role ?? "dev", sources, cwd, repoId: extra.repoId });

const saveContext = (slug: string, refs: string[], scope: "builtin" | "user" = "user") =>
  defs.save({ kind: "context", slug, scope, body: { refs }, source: "ui" });

describe("native", () => {
  test("pasa sources y skills tal cual, y varias fuentes native se juntan", async () => {
    const resolved = await resolve([
      { kind: "native", sources: ["user"], skills: ["commit"] },
      { kind: "native", sources: ["project"], skills: ["lint"] },
    ]);

    expect(resolved).toEqual({
      native: { sources: ["user", "project"], skills: ["commit", "lint"] },
      references: [],
      warnings: [],
    });
  });

  test('"all" gana sobre una lista', async () => {
    const resolved = await resolve([
      { kind: "native", sources: ["user"], skills: ["commit"] },
      { kind: "native", sources: ["user"], skills: "all" },
    ]);
    expect(resolved.native?.skills).toBe("all");
  });

  test("sin fuente native no hay native", async () => {
    expect((await resolve([])).native).toBeUndefined();
  });
});

describe("repo y file", () => {
  test("repo lee del worktree y file de una ruta absoluta, relativa al worktree o con ~/", async () => {
    await write(join(cwd, "AGENTS.md"), "reglas del repo");
    await write(join(cwd, "lore", "patterns.md"), "patrones");
    await write(join(root, "abs.md"), "absoluto");
    await write(join(root, "home", "nota.md"), "de la casa");
    vi.stubEnv("HOME", join(root, "home"));

    const resolved = await resolve([
      { kind: "repo", files: ["AGENTS.md"] },
      { kind: "file", path: "lore/patterns.md" },
      { kind: "file", path: join(root, "abs.md") },
      { kind: "file", path: "~/nota.md" },
    ]);

    expect(resolved.references).toEqual([
      { label: "AGENTS.md", content: "reglas del repo" },
      { label: "lore/patterns.md", content: "patrones" },
      { label: join(root, "abs.md"), content: "absoluto" },
      { label: "~/nota.md", content: "de la casa" },
    ]);
    expect(resolved.warnings).toEqual([]);
  });

  test("se lee del original en cada llamada, nunca una copia", async () => {
    await write(join(cwd, "AGENTS.md"), "v1");
    const sources: ContextSource[] = [{ kind: "repo", files: ["AGENTS.md"] }];

    const first = await resolver.resolve({ role: "dev", sources, cwd });
    await write(join(cwd, "AGENTS.md"), "v2");
    const second = await resolver.resolve({ role: "dev", sources, cwd });

    expect([first.references[0]?.content, second.references[0]?.content]).toEqual(["v1", "v2"]);
  });

  test("un archivo que falta es un aviso con la ruta y el resto del contexto sigue", async () => {
    await write(join(cwd, "AGENTS.md"), "reglas");

    const resolved = await resolve([{ kind: "repo", files: ["AGENTS.md", "lore/core_patterns.md"] }]);

    expect(resolved.references).toEqual([{ label: "AGENTS.md", content: "reglas" }]);
    expect(resolved.warnings).toEqual([
      `El rol "dev" pide el contexto "repo:lore/core_patterns.md" y no se pudo leer (${join(cwd, "lore/core_patterns.md")}): no existe. Corre sin él.`,
    ]);
  });

  test("un archivo que no se puede leer por otra causa también avisa", async () => {
    await mkdir(join(cwd, "AGENTS.md"));
    const resolved = await resolve([{ kind: "repo", files: ["AGENTS.md"] }]);
    expect(resolved.references).toEqual([]);
    expect(resolved.warnings).toEqual([expect.stringContaining("EISDIR")]);
  });

  test("el mismo archivo pedido dos veces entra una sola vez", async () => {
    await write(join(cwd, "AGENTS.md"), "reglas");
    saveContext("base", ["repo:AGENTS.md"]);

    const resolved = await resolve([
      { kind: "repo", files: ["AGENTS.md"] },
      { kind: "pack", id: "base" },
    ]);

    expect(resolved.references).toHaveLength(1);
  });
});

describe("pack (paquete de contexto)", () => {
  test("resuelve las referencias del paquete: skill, rule, repo y file", async () => {
    await write(join(userDir, "skills", "commit", "SKILL.md"), "# commit");
    await write(join(userDir, "rules", "git-safety.md"), "confirmar siempre");
    await write(join(cwd, "AGENTS.md"), "reglas");
    await write(join(root, "lore.md"), "lore");
    saveContext("commits", ["skill:commit", "rule:git-safety", "repo:AGENTS.md", `file:${join(root, "lore.md")}`]);

    const resolved = await resolve([{ kind: "pack", id: "commits" }]);

    expect(resolved.native).toEqual({ sources: ["user", "project"], skills: ["commit"] });
    expect(resolved.references).toEqual([
      { label: "rule:git-safety", content: "confirmar siempre" },
      { label: "AGENTS.md", content: "reglas" },
      { label: join(root, "lore.md"), content: "lore" },
    ]);
    expect(resolved.warnings).toEqual([]);
  });

  test("un paquete que no existe es un aviso y el rol corre sin él", async () => {
    const resolved = await resolve([{ kind: "pack", id: "lore" }]);

    expect(resolved).toEqual({
      references: [],
      warnings: ['El rol "dev" pide el paquete de contexto "lore" y no existe: corre sin él.'],
    });
  });

  test("gana el paquete del usuario sobre el builtin con el mismo slug", async () => {
    await write(join(cwd, "a.md"), "A");
    await write(join(cwd, "b.md"), "B");
    saveContext("x", ["repo:a.md"], "builtin");
    saveContext("x", ["repo:b.md"], "user");

    expect((await resolve([{ kind: "pack", id: "x" }])).references).toEqual([{ label: "b.md", content: "B" }]);
  });
});

describe("skill y rule", () => {
  test("una skill del usuario, una del repo y un comando existen; se piden por nombre a Claude", async () => {
    await write(join(userDir, "skills", "commit", "SKILL.md"), "# commit");
    await write(join(cwd, ".claude", "skills", "lint", "SKILL.md"), "# lint");
    await write(join(userDir, "commands", "deploy.md"), "# deploy");
    saveContext("tools", ["skill:commit", "skill:lint", "skill:deploy"]);

    const resolved = await resolve([{ kind: "native", sources: ["user", "project"], skills: ["review"] }, { kind: "pack", id: "tools" }]);

    expect(resolved.native).toEqual({ sources: ["user", "project"], skills: ["review", "commit", "lint", "deploy"] });
    expect(resolved.warnings).toEqual([]);
  });

  test("con native en all las skills pedidas no cambian la lista", async () => {
    await write(join(userDir, "skills", "commit", "SKILL.md"), "# commit");
    saveContext("tools", ["skill:commit"]);

    const resolved = await resolve([{ kind: "native", sources: ["user"], skills: "all" }, { kind: "pack", id: "tools" }]);

    expect(resolved.native?.skills).toBe("all");
  });

  test("una skill que falta (o fuera de las sources del rol) avisa y no se pide", async () => {
    await write(join(userDir, "skills", "commit", "SKILL.md"), "# commit");
    saveContext("tools", ["skill:commit", "skill:nope"]);

    const resolved = await resolve([{ kind: "native", sources: ["project"], skills: [] }, { kind: "pack", id: "tools" }]);

    expect(resolved.native?.skills).toEqual([]);
    expect(resolved.warnings).toEqual([
      expect.stringContaining('la skill "commit"'),
      expect.stringContaining('la skill "nope"'),
    ]);
  });

  test("una regla del repo gana a la del usuario, y una que falta avisa", async () => {
    await write(join(userDir, "rules", "style.md"), "del usuario");
    await write(join(cwd, ".claude", "rules", "style.md"), "del repo");
    await write(join(userDir, "rules", "solo-usuario.md"), "solo usuario");
    saveContext("rules", ["rule:style", "rule:solo-usuario", "rule:nope"]);

    const resolved = await resolve([{ kind: "pack", id: "rules" }]);

    expect(resolved.references).toEqual([
      { label: "rule:style", content: "del repo" },
      { label: "rule:solo-usuario", content: "solo usuario" },
    ]);
    expect(resolved.warnings).toEqual([expect.stringContaining('"rule:nope"')]);
  });
});

describe("conventions.context del pack de la org", () => {
  beforeEach(async () => {
    const dir = join(root, "pack-acme");
    await write(
      join(dir, "pack.json"),
      JSON.stringify({
        id: "acme",
        version: 1,
        activate: { githubOrgs: ["acme"] },
        conventions: { context: { committer: ["skill:commit", "rule:git-safety"], "*": ["repo:AGENTS.md"] } },
      }),
    );
    await packs.load(dir);
    await write(join(userDir, "skills", "commit", "SKILL.md"), "# commit");
    await write(join(userDir, "rules", "git-safety.md"), "confirmar siempre");
    await write(join(cwd, "AGENTS.md"), "reglas");
  });

  test("el rol recibe lo de * y lo suyo, sin duplicar lo que ya pedía", async () => {
    const sources: ContextSource[] = [{ kind: "repo", files: ["AGENTS.md"] }];

    const committer = await resolve(sources, { role: "committer", repoId: "repo_acme" });
    const dev = await resolve(sources, { role: "dev", repoId: "repo_acme" });

    expect(committer.native?.skills).toEqual(["commit"]);
    expect(committer.references).toEqual([
      { label: "AGENTS.md", content: "reglas" },
      { label: "rule:git-safety", content: "confirmar siempre" },
    ]);
    expect(dev.native).toBeUndefined();
    expect(dev.references).toEqual([{ label: "AGENTS.md", content: "reglas" }]);
  });

  test("un repo de otra org, o sin repo, no recibe el pack", async () => {
    expect((await resolve([], { role: "committer", repoId: "repo_otra" })).references).toEqual([]);
    expect((await resolve([], { role: "committer" })).references).toEqual([]);
  });
});

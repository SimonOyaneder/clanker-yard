import { describe, expect, test } from "vitest";
import { Recipe, renderTemplate, templateVariables, type TemplateVars } from "./index";

// La receta de ejemplo de `docs/design.html#d-ops`.
const api = {
  version: 1,
  requires: [{ name: "Postgres", check: "pg_isready -h localhost -p 54321" }],
  slots: { dev: 3, maintenance: 2 },
  worktreeDir: null,
  env: {
    API_ENV: "SANDBOX",
    DATABASE_URL: "postgres://postgres:password@localhost:54321/api_dev_cy{{slot}}",
    REDIS_URL: "redis://localhost:63791/{{slot+10}}",
  },
  wrap: "doppler run --config dev --preserve-env={{envKeys}} --",
  setup: {
    worktree: ["bundle install --quiet"],
    slot: ["bin/rails db:drop db:create db:schema:load"],
    slotKey: ["db/structure.sql"],
    guard: { run: "bin/rails runner 'print 1'", expect: "api_dev_cy{{slot}}" },
  },
  commands: { test: "bundle exec rspec {{files}}", lint: "bundle exec rubocop {{files}}", typecheck: "bundle exec srb tc" },
  checks: ["typecheck", "lint", "test"],
  afterRebase: ["bundle exec packwerk update-todo"],
};

function issuesOf(recipe: unknown): string[] {
  const parsed = Recipe.safeParse(recipe);
  if (parsed.success) return [];
  return parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`);
}

describe("Recipe", () => {
  test("acepta la receta del diseño", () => {
    expect(Recipe.safeParse(api).success).toBe(true);
  });

  test("solo version es obligatoria: el resto tiene valores por defecto", () => {
    expect(Recipe.parse({ version: 1 })).toEqual({
      version: 1,
      requires: [],
      env: {},
      commands: {},
      checks: [],
      afterRebase: [],
    });
  });

  test("el error lleva la ruta del campo", () => {
    expect(issuesOf({ ...api, slots: { dev: 0, maintenance: 2 } })).toEqual([
      expect.stringMatching(/^slots\.dev: /),
    ]);
    expect(issuesOf({ ...api, setup: { ...api.setup, slot: [1] } })).toEqual([
      expect.stringMatching(/^setup\.slot\.0: /),
    ]);
    expect(issuesOf({ ...api, version: 2 })).toEqual([expect.stringMatching(/^version: /)]);
  });

  test("un check que no es un comando dice cuál y qué comandos hay", () => {
    expect(issuesOf({ ...api, checks: ["lint", "rspec"] })).toEqual([
      'checks.1: "rspec" no está en commands (test, lint, typecheck).',
    ]);
  });

  test("una variable fuera de la lista, o una expresión, se rechaza en el campo que la usa", () => {
    const withCommand = (test: string) => ({ ...api, commands: { ...api.commands, test } });
    expect(issuesOf(withCommand("rspec {{file}}"))).toEqual([expect.stringMatching(/^commands\.test: .*\{\{file\}\}/)]);
    expect(issuesOf(withCommand("rspec {{slot*2}}"))).toEqual([expect.stringMatching(/^commands\.test: .*\{\{slot\*2\}\}/)]);
    expect(issuesOf({ ...api, env: { A: "{{ branch }}", B: "{{nope}}" } })).toEqual([
      expect.stringMatching(/^env\.B: .*\{\{nope\}\}/),
    ]);
    expect(issuesOf({ ...api, wrap: "x {{worktree" })).toEqual([]);
  });

  test("rechaza claves que la receta no tiene y nombres de entorno inválidos", () => {
    expect(issuesOf({ ...api, extra: 1 })).toHaveLength(1);
    expect(issuesOf({ ...api, env: { "NOT-VALID": "x" } })).toHaveLength(1);
  });
});

const vars: TemplateVars = {
  slot: 2,
  worktree: "/data/worktrees/api/cla-1",
  branch: "cla-1-fix",
  files: ["app/a.rb", "spec/a_spec.rb"],
  envKeys: ["DATABASE_URL", "REDIS_URL"],
};

describe("renderTemplate", () => {
  test.each([
    ["api_dev_cy{{slot}}", "api_dev_cy2"],
    ["redis://localhost:63791/{{slot+10}}", "redis://localhost:63791/12"],
    ["{{ slot }}", "2"],
    ["cd {{worktree}} && git switch {{branch}}", "cd /data/worktrees/api/cla-1 && git switch cla-1-fix"],
    ["rspec {{files}}", "rspec app/a.rb spec/a_spec.rb"],
    ["doppler run --preserve-env={{envKeys}} --", "doppler run --preserve-env=DATABASE_URL,REDIS_URL --"],
    ["{{slot}}-{{slot}}", "2-2"],
  ])("%s", (template, expected) => {
    expect(renderTemplate(template, vars, { shell: true })).toBe(expected);
  });

  test("con shell escapa lo que no es seguro; sin shell, no", () => {
    const odd: TemplateVars = { ...vars, worktree: "/tmp/it's here", files: ["a b.rb", ""] };
    expect(renderTemplate("cd {{worktree}}; rspec {{files}}", odd, { shell: true })).toBe(
      `cd '/tmp/it'\\''s here'; rspec 'a b.rb' ''`,
    );
    expect(renderTemplate("{{worktree}}", odd, { shell: false })).toBe("/tmp/it's here");
  });

  test("sin slot, {{slot}} falla con un mensaje accionable", () => {
    expect(() => renderTemplate("x{{slot+1}}", { ...vars, slot: undefined }, { shell: true })).toThrow(
      /\{\{slot\+1\}\}.*no tiene slot/,
    );
    expect(renderTemplate("sin variables", { ...vars, slot: undefined }, { shell: true })).toBe("sin variables");
  });

  test("una variable desconocida lanza en vez de dejarse literal", () => {
    expect(() => renderTemplate("{{nope}}", vars, { shell: true })).toThrow(/\{\{nope\}\}/);
    expect(() => renderTemplate("{{slot + 1}}", vars, { shell: true })).toThrow(/sin expresiones/);
  });
});

describe("templateVariables", () => {
  test("lista cada variable una vez, en orden", () => {
    expect(templateVariables("{{slot}} {{files}} {{slot}} {{ branch }}")).toEqual(["slot", "files", "branch"]);
    expect(templateVariables("nada")).toEqual([]);
  });
});

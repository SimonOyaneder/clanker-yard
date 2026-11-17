import { NewProject, Profile, type ProjectConfig } from "@clanker/api";
import { afterEach, describe, expect, test } from "vitest";
import { createDefs } from "../defs/defs";
import { openStore, type Store } from "../store/store";
import { createRepos } from "../repos/repos";
import { createProjectConfigs } from "./config";
import { InvalidProjectError, ProjectNotFoundError, createProjects } from "./projects";

const open: Store[] = [];
afterEach(() => {
  for (const store of open.splice(0)) store.close();
});

/** Una máquina: sus repos registrados, un perfil `barato` y un proyecto de Linear sin configurar. */
function machine(registered: Record<string, string | null>, account = "acme") {
  const store = openStore({ path: ":memory:" });
  open.push(store);
  const defs = createDefs({ store });
  defs.register("profile", Profile);
  defs.save({ kind: "profile", slug: "barato", scope: "user", body: { roles: { dev: { model: "sonnet" } } }, source: "ui" });
  const repos = createRepos({ store });
  const ids = Object.fromEntries(Object.entries(registered).map(([name, remote]) => [name, repos.add({ name, path: `/work/${name}`, remote })]));
  const projects = createProjects({ store, defs });
  const project = projects.create(NewProject.parse({ slug: "p", name: "P", tracker: "linear", trackerRef: "team-1", trackerAccount: account }), "ui");
  return { projects, project, ids, configs: createProjectConfigs({ projects, repos, defs }), repos };
}

const origin = "ui" as const;

describe("exportar e importar la configuración de un proyecto", () => {
  test("lo exportado en una máquina se importa en otra con los repos por remoto", () => {
    const a = machine({ api: "acme/api", web: "acme/web" });
    a.projects.update(a.project.id, {
      repos: [{ repoId: a.ids.web!, labels: ["frontend"] }, { repoId: a.ids.api!, labels: [] }],
      statusMapping: { Blocked: "in_review" },
      defaultProfileId: "barato",
      parallel: 3,
      stackMode: "local",
      flowParams: { reviewRounds: 2 },
    }, origin);
    const exported = a.configs.export(a.project.id);
    expect(exported).toMatchObject({ trackerRef: "team-1", trackerAccount: "acme" })
    expect(exported.repos).toEqual([{ name: "web", remote: "acme/web", labels: ["frontend"] }, { name: "api", remote: "acme/api", labels: [] }]);

    // En la otra máquina el mismo repo vive en otra carpeta (otro id).
    const b = machine({ "web-checkout": "acme/web", api: "acme/api" }, "otro-workspace");
    const result = b.configs.import(b.project.id, JSON.parse(JSON.stringify(exported)), origin, { dryRun: false });

    expect(result).toMatchObject({ applied: true, errors: [], unmapped: [] });
    expect(b.projects.get(b.project.id)).toMatchObject({
      repos: [{ repoId: b.ids["web-checkout"], labels: ["frontend"] }, { repoId: b.ids.api, labels: [] }],
      statusMapping: { Blocked: "in_review" },
      defaultProfileId: "barato",
      parallel: 3,
      stackMode: "local",
      flowParams: { reviewRounds: 2 },
      // No viaja la identidad del proyecto: ni su proyecto del tracker ni su cuenta.
      slug: "p",
      trackerRef: "team-1",
      trackerAccount: "otro-workspace",
    });
  });

  test("dryRun dice qué cambia y qué no se pudo mapear sin escribir nada", () => {
    const a = machine({ api: "acme/api", web: "acme/web" });
    a.projects.update(a.project.id, { repos: [{ repoId: a.ids.api!, labels: ["be"] }, { repoId: a.ids.web!, labels: [] }], defaultProfileId: "barato", parallel: 2 }, origin);
    const config = { ...a.configs.export(a.project.id), defaultFlowId: "flujo-que-no-existe-aca" };
    const b = machine({ api: "acme/api" });

    const result = b.configs.import(b.project.id, config, origin, { dryRun: true });

    expect(result.applied).toBe(false);
    expect(result.unmapped).toEqual([
      { path: "repos.1", message: expect.stringContaining("acme/web no está registrado en esta máquina") },
      { path: "defaultFlowId", message: expect.stringContaining('no existe el flujo "flujo-que-no-existe-aca"') },
    ]);
    expect(result.changes.map((c) => c.path).sort()).toEqual(["defaultProfileId", "parallel", "repos"]);
    expect(result.changes.find((c) => c.path === "repos")).toMatchObject({ before: [], after: [{ repo: "api", labels: ["be"] }] });
    expect(b.projects.get(b.project.id)).toMatchObject({ repos: [], parallel: 1, defaultProfileId: null });
  });

  test("un archivo sin stackMode no lo cambia", () => {
    const b = machine({});
    b.projects.update(b.project.id, { stackMode: "local" }, origin);
    const config = { ...b.configs.export(b.project.id), stackMode: undefined, parallel: 2 };

    const result = b.configs.import(b.project.id, JSON.parse(JSON.stringify(config)), origin, { dryRun: false });

    expect(result.changes.map((c) => c.path)).toEqual(["parallel"]);
    expect(b.projects.get(b.project.id)).toMatchObject({ stackMode: "local", parallel: 2 });
  });

  test("lo omitido no frena el resto, y si ningún repo se encuentra la lista de repos no se toca", () => {
    const b = machine({ api: "acme/api" });
    b.projects.update(b.project.id, { repos: [{ repoId: b.ids.api!, labels: [] }] }, origin);
    const config: ProjectConfig = {
      clankerProjectConfig: 1,
      name: "otro",
      tracker: "linear",
      trackerRef: "otro",
      trackerAccount: null,
      defaultFlowId: null,
      defaultProfileId: null,
      repos: [{ name: "x", remote: "acme/x", labels: [] }],
      queueFilter: {},
      conventions: {},
      parallel: 4,
      stackOn: "ci_green",
      statusMapping: {},
      flowParams: {},
      maxCostUsd: null,
    };

    const result = b.configs.import(b.project.id, config, origin, { dryRun: false });

    expect(result.unmapped).toHaveLength(1);
    expect(b.projects.get(b.project.id)).toMatchObject({ parallel: 4, name: "P", repos: [{ repoId: b.ids.api }] });
  });

  test("valida todo antes de escribir: un archivo inválido o un label en dos repos no cambian nada", () => {
    const b = machine({ api: "acme/api", web: "acme/web" });
    const bad = { clankerProjectConfig: 1, name: "x", tracker: "linear", trackerRef: "t", parallel: 0, surprise: true };

    const dry = b.configs.import(b.project.id, bad, origin, { dryRun: true });
    expect(dry.applied).toBe(false);
    expect(dry.errors.map((e) => e.path).sort()).toEqual(["", "parallel"]);
    expect(() => b.configs.import(b.project.id, bad, origin, { dryRun: false })).toThrow(InvalidProjectError);

    const clash = { ...b.configs.export(b.project.id), parallel: 5, repos: [{ name: "api", remote: "acme/api", labels: ["x"] }, { name: "web", remote: "acme/web", labels: ["x"] }] };
    expect(b.configs.import(b.project.id, clash, origin, { dryRun: true }).errors).toEqual([
      { path: "repos.1.labels", message: expect.stringContaining('el label "x" manda a dos repos') },
    ]);
    expect(() => b.configs.import(b.project.id, clash, origin, { dryRun: false })).toThrow(/dos repos/);
    expect(b.projects.get(b.project.id)).toMatchObject({ parallel: 1, repos: [] });
  });

  test("un proyecto que no existe es ProjectNotFoundError", () => {
    const a = machine({});
    expect(() => a.configs.export("prj_00000000000000000000000001")).toThrow(ProjectNotFoundError);
  });
});

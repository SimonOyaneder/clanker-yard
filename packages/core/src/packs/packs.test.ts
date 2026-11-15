import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { ContextPackage, FlowDef, Role, type FlowDef as FlowDefType, type Role as RoleType } from "@clanker/api";
import { createDefs, type Defs } from "../defs/defs";
import { newId } from "../store/conventions";
import { openStore, type Store } from "../store/store";
import { createPacks, PackLoadError, type Packs } from "./packs";

const stores: Store[] = [];
const dirs: string[] = [];
afterEach(() => {
  for (const store of stores.splice(0)) store.close();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function setup(): { defs: Defs; packs: Packs } {
  const store = openStore({ path: ":memory:" });
  stores.push(store);
  const defs = createDefs(store);
  // Los kinds `flow` y `role` los registran Flows y Agents con estos mismos esquemas.
  defs.register("flow", FlowDef.omit({ version: true }));
  defs.register("role", Role);
  defs.register("context", ContextPackage);
  return { defs, packs: createPacks({ defs }) };
}

function flow(id: string): FlowDefType {
  return {
    schema: 1,
    id,
    name: id,
    trigger: { type: "manual" },
    start: "go",
    nodes: { go: { type: "action", action: "x.y", args: {}, on: { ok: "@done" } } },
  };
}

const role: RoleType = {
  prompt: "Revisas contra el lore.",
  context: [],
  modes: {
    review: { instructions: "Revisa.", report: { type: "object" }, outcomes: ["clean"], session: "new" },
  },
};

type Files = Record<string, unknown>;

/** Escribe una carpeta de pack; un `pack.json` que falta se arma con lo mínimo. */
function packDir(files: Files): string {
  const dir = mkdtempSync(join(tmpdir(), "clanker-pack-"));
  dirs.push(dir);
  for (const [name, content] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, name)), { recursive: true });
    writeFileSync(join(dir, name), typeof content === "string" ? content : JSON.stringify(content));
  }
  return dir;
}

const manifest = {
  id: "acme",
  version: 1,
  activate: { githubOrgs: ["acme-co"], trackerWorkspaces: ["acme"] },
  reviewBot: {
    logins: ["acme-review[bot]"],
    request: { type: "comment", body: "acme review" },
    lgtm: { reviewState: "APPROVED" },
  },
  flows: ["flows/techlead.json"],
  roles: ["roles/review-lore.json"],
};
const acme = (): Files => ({
  "pack.json": manifest,
  "flows/techlead.json": flow("techlead"),
  "roles/review-lore.json": role,
});

async function loadError(packs: Packs, dir: string): Promise<PackLoadError> {
  const error = await packs.load(dir).then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(error).toBeInstanceOf(PackLoadError);
  return error as PackLoadError;
}

describe("packFor", () => {
  test("un repo fuera del alcance recibe los defaults neutros", async () => {
    const { packs } = setup();
    await packs.load(packDir(acme()));

    expect(packs.packFor({ githubOrg: "otra-org" })).toEqual({
      id: null,
      actors: {},
      signals: [],
      conventions: {},
    });
    expect(packs.packFor({})).toMatchObject({ id: null });
  });

  test("sin ningún pack cargado todo es neutro", () => {
    const { packs } = setup();
    expect(packs.packFor({ githubOrg: "acme-co" })).toMatchObject({ id: null, signals: [] });
  });

  test("se activa por org de GitHub, workspace del tracker o proyecto, sin distinguir mayúsculas en nombres", async () => {
    const { packs } = setup();
    const project = newId("prj");
    await packs.load(
      packDir({
        ...acme(),
        "pack.json": { ...manifest, activate: { githubOrgs: ["Acme-Co"], trackerWorkspaces: ["acme"], projects: [project] } },
      }),
    );

    expect(packs.packFor({ githubOrg: "acme-co" }).id).toBe("acme");
    expect(packs.packFor({ trackerWorkspace: "ACME" }).id).toBe("acme");
    expect(packs.packFor({ projectId: project }).id).toBe("acme");
    expect(packs.packFor({ projectId: newId("prj") }).id).toBeNull();
    // Un repo fuera de la org no la activa por tener el workspace de otro.
    expect(packs.packFor({ githubOrg: "otra-org", trackerWorkspace: "otro" }).id).toBeNull();
  });

  test("entrega la configuración del pack, no solo su id", async () => {
    const { packs } = setup();
    await packs.load(packDir(acme()));

    const resolved = packs.packFor({ githubOrg: "acme-co" });

    expect(resolved.reviewBot?.logins).toEqual(["acme-review[bot]"]);
    expect(resolved).not.toHaveProperty("flows");
    expect(resolved).not.toHaveProperty("activate");
  });

  test("si dos packs cubren el alcance gana el de menor id", async () => {
    const { packs } = setup();
    await packs.load(packDir({ "pack.json": { ...manifest, id: "zeta", flows: [], roles: [] } }));
    await packs.load(packDir({ "pack.json": { ...manifest, id: "alfa", flows: [], roles: [] } }));

    expect(packs.packFor({ githubOrg: "acme-co" }).id).toBe("alfa");
  });
});

describe("load", () => {
  test("los flujos y roles del pack aparecen en defs.list con scope pack", async () => {
    const { defs, packs } = setup();

    await packs.load(packDir(acme()));

    expect(defs.list("flow").map((d) => [d.slug, d.scope, d.source])).toEqual([["techlead", "pack", "pack:acme@1"]]);
    expect(defs.list("role").map((d) => [d.slug, d.scope, d.source])).toEqual([["review-lore", "pack", "pack:acme@1"]]);
    expect(defs.list("pack").map((d) => [d.slug, d.scope])).toEqual([["acme", "pack"]]);
    expect(defs.resolve("flow", "techlead")?.scope).toBe("pack");
  });

  test("los paquetes de contexto del pack entran como defs context con scope pack, y se archivan si el pack los deja", async () => {
    const { defs, packs } = setup();
    const withContext = (version: number, contexts: string[]): Files => ({
      ...acme(),
      "pack.json": { ...manifest, version, contexts },
      "contexts/commits.json": { description: "cómo hago commits", refs: ["skill:commit", "rule:git-safety"] },
    });

    await packs.load(packDir(withContext(1, ["contexts/commits.json"])));
    expect(defs.list("context").map((d) => [d.slug, d.scope, d.source])).toEqual([["commits", "pack", "pack:acme@1"]]);
    expect(defs.resolve("context", "commits")?.body).toEqual({ description: "cómo hago commits", refs: ["skill:commit", "rule:git-safety"] });

    await packs.load(packDir(withContext(2, [])));
    expect(defs.resolve("context", "commits")).toBeUndefined();
  });

  test("un paquete de contexto con una referencia que no es de ningún tipo da error con su archivo", async () => {
    const { packs } = setup();
    const dir = packDir({
      ...acme(),
      "pack.json": { ...manifest, contexts: ["contexts/commits.json"] },
      "contexts/commits.json": { refs: ["commit"] },
    });

    const error = await loadError(packs, dir);

    expect(error.file).toBe("contexts/commits.json");
    expect(error.issues[0]?.path.join(".")).toBe("refs.0");
  });

  test("un flujo del usuario con el mismo id le gana al del pack", async () => {
    const { defs, packs } = setup();
    await packs.load(packDir(acme()));

    defs.save({ kind: "flow", slug: "techlead", scope: "user", body: flow("techlead"), source: "ui" });

    expect(defs.resolve("flow", "techlead")?.scope).toBe("user");
  });

  test("cargar dos veces el mismo contenido no crea versiones", async () => {
    const { defs, packs } = setup();
    const dir = packDir(acme());

    const first = await packs.load(dir);
    const again = await packs.load(dir);

    expect(first).toEqual({ id: "acme", version: 1, changed: true });
    expect(again).toEqual({ id: "acme", version: 1, changed: false });
    expect(defs.list("flow")[0]?.currentVersion).toBe(1);
  });

  test("un flujo que el pack deja de traer se archiva, y si vuelve se restaura", async () => {
    const { defs, packs } = setup();
    await packs.load(packDir(acme()));

    await packs.load(packDir({ ...acme(), "pack.json": { ...manifest, version: 2, flows: [] } }));
    expect(defs.list("flow")).toEqual([]);
    expect(defs.resolve("flow", "techlead")).toBeUndefined();

    const back = await packs.load(packDir({ ...acme(), "pack.json": { ...manifest, version: 3 } }));
    expect(back.changed).toBe(true);
    expect(defs.list("flow").map((d) => d.slug)).toEqual(["techlead"]);
    expect(defs.list("pack")[0]).toMatchObject({ currentVersion: 3 });
  });

  test("un pack inválido da error con la ruta y no guarda nada", async () => {
    const { defs, packs } = setup();
    const dir = packDir({
      ...acme(),
      "pack.json": { ...manifest, activate: { githubOrgs: [""] }, reviewBot: { logins: [] } },
    });

    const error = await loadError(packs, dir);

    expect(error.file).toBe("pack.json");
    expect(error.issues.map((i) => i.path.join("."))).toEqual(
      expect.arrayContaining(["activate.githubOrgs.0", "reviewBot.logins", "reviewBot.request"]),
    );
    expect(error.message).toContain("activate.githubOrgs.0");
    expect(defs.list("pack")).toEqual([]);
  });

  test("un flujo inválido da error con su archivo y su ruta, y el pack no queda a medias", async () => {
    const { defs, packs } = setup();
    const bad = flow("techlead");
    bad.nodes.go = { type: "action", action: "", args: {} };
    const dir = packDir({ ...acme(), "flows/techlead.json": bad });

    const error = await loadError(packs, dir);

    expect(error.file).toBe("flows/techlead.json");
    expect(error.issues.map((i) => i.path.join("."))).toEqual(["nodes.go.action"]);
    expect(defs.list("role")).toEqual([]);
    expect(defs.list("pack")).toEqual([]);
  });

  test.each([
    ["un pack.json que no es JSON", { "pack.json": "{ no" }, "pack.json"],
    ["un flujo listado que no existe", { ...acme(), "flows/techlead.json": undefined }, "flows/techlead.json"],
    ["un flujo cuyo id no es el de su archivo", { ...acme(), "flows/techlead.json": flow("otro") }, "flows/techlead.json"],
  ])("rechaza %s", async (_name, files, file) => {
    const { packs } = setup();
    const entries = Object.fromEntries(Object.entries(files).filter(([, v]) => v !== undefined));
    expect((await loadError(packs, packDir(entries))).file).toBe(file);
  });

  test("dos packs no pueden traer el mismo flujo", async () => {
    const { defs, packs } = setup();
    await packs.load(packDir(acme()));

    const error = await loadError(packs, packDir({ ...acme(), "pack.json": { ...manifest, id: "otro" } }));

    expect(error.file).toBe("roles/review-lore.json");
    expect(error.message).toContain('el role "review-lore" ya lo trae otro pack (pack:acme@1)');
    expect(defs.list("pack").map((d) => d.slug)).toEqual(["acme"]);
  });
});

describe("loadAll", () => {
  /** Una carpeta de packs instalados: una subcarpeta por pack. */
  function installed(packs: Record<string, Files>): string {
    const root = mkdtempSync(join(tmpdir(), "clanker-packs-"));
    dirs.push(root);
    for (const [name, files] of Object.entries(packs)) {
      for (const [file, content] of Object.entries(files)) {
        mkdirSync(dirname(join(root, name, file)), { recursive: true });
        writeFileSync(join(root, name, file), JSON.stringify(content));
      }
    }
    return root;
  }

  test("carga cada subcarpeta y deja la de un pack roto en errors sin impedir las demás", async () => {
    const { packs } = setup();
    const root = installed({
      acme: { "pack.json": { id: "acme", version: 1, activate: { githubOrgs: ["acme-co"] } } },
      roto: { "pack.json": { id: "roto", version: 1, activate: "no" } },
      zeta: { "pack.json": { id: "zeta", version: 1, activate: { githubOrgs: ["zeta-co"] } } },
    });

    const { errors } = await packs.loadAll(root);

    expect(errors).toHaveLength(1);
    expect(errors[0]).toBeInstanceOf(PackLoadError);
    expect(errors[0]!.dir).toBe(join(root, "roto"));
    expect(packs.packFor({ githubOrg: "acme-co" }).id).toBe("acme");
    expect(packs.packFor({ githubOrg: "zeta-co" }).id).toBe("zeta");
  });

  test("una carpeta de packs que no existe es no tener packs", async () => {
    const { packs } = setup();

    expect(await packs.loadAll(join(tmpdir(), "clanker-sin-packs-aqui"))).toEqual({ errors: [] });
  });
});

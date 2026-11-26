import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { GITHUB_APP_CLIENT_ID_ENV, GITHUB_APP_SLUG_ENV, LINEAR_CLIENT_ID_ENV, readCoreConfig } from "./config";

let dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
  dirs = [];
});

function dataDir(configJson?: string): string {
  const dir = mkdtempSync(join(tmpdir(), "clanker-config-"));
  dirs.push(dir);
  if (configJson !== undefined) writeFileSync(join(dir, "config.json"), configJson);
  return dir;
}

describe("readCoreConfig", () => {
  test("habilita review entrante solo en los repos configurados", () => {
    const incomingReview = { repos: ["octocat/api"], references: "~/review-rules" };
    expect(readCoreConfig(dataDir(JSON.stringify({ incomingReview })), {})).toEqual({ incomingReview });
    expect(() => readCoreConfig(dataDir('{"incomingReview":{"repos":["is:open"]}}'), {})).toThrow("incomingReview");
  });
  test("el client_id de la GitHub App sale de config.json", () => {
    const dir = dataDir(JSON.stringify({ githubApp: { clientId: "Iv23liFromFile" } }));
    expect(readCoreConfig(dir, {})).toEqual({ githubApp: { clientId: "Iv23liFromFile" } });
  });

  test("la variable de entorno pisa al archivo", () => {
    const dir = dataDir(JSON.stringify({ githubApp: { clientId: "Iv23liFromFile" } }));
    expect(readCoreConfig(dir, { [GITHUB_APP_CLIENT_ID_ENV]: " Iv23liFromEnv " })).toEqual({
      githubApp: { clientId: "Iv23liFromEnv" },
    });
  });

  test("sin archivo usa el entorno, y sin ninguno de los dos no hay client_id", () => {
    const dir = dataDir();
    expect(readCoreConfig(dir, { [GITHUB_APP_CLIENT_ID_ENV]: "Iv23liFromEnv" })).toEqual({
      githubApp: { clientId: "Iv23liFromEnv" },
    });
    expect(readCoreConfig(dir, {})).toEqual({});
    expect(readCoreConfig(dir, { [GITHUB_APP_CLIENT_ID_ENV]: "  " })).toEqual({});
  });

  test("el client_id de Linear sale de config.json, el entorno lo pisa y cada uno es independiente del de GitHub", () => {
    const dir = dataDir(JSON.stringify({ githubApp: { clientId: "Iv23liFromFile" }, linear: { clientId: "lin-file" } }));
    expect(readCoreConfig(dir, {})).toEqual({ githubApp: { clientId: "Iv23liFromFile" }, linear: { clientId: "lin-file" } });
    expect(readCoreConfig(dir, { [LINEAR_CLIENT_ID_ENV]: " lin-env " })).toEqual({
      githubApp: { clientId: "Iv23liFromFile" },
      linear: { clientId: "lin-env" },
    });
    expect(readCoreConfig(dataDir(), { [LINEAR_CLIENT_ID_ENV]: "lin-env" })).toEqual({ linear: { clientId: "lin-env" } });
    expect(readCoreConfig(dataDir(), { [LINEAR_CLIENT_ID_ENV]: " " })).toEqual({});
  });

  test("el slug de la GitHub App es opcional y el entorno lo pisa", () => {
    const dir = dataDir(JSON.stringify({ githubApp: { clientId: "Iv23liFromFile", slug: "clanker-yard" } }));
    expect(readCoreConfig(dir, {})).toEqual({ githubApp: { clientId: "Iv23liFromFile", slug: "clanker-yard" } });
    expect(readCoreConfig(dir, { [GITHUB_APP_SLUG_ENV]: " otro-nombre " })).toEqual({ githubApp: { clientId: "Iv23liFromFile", slug: "otro-nombre" } });
  });

  test("un archivo sin githubApp es una config vacía", () => {
    expect(readCoreConfig(dataDir("{}"), {})).toEqual({});
  });

  test.each([
    ["no es JSON", "{ githubApp", /config\.json no es JSON válido/],
    ["trae una clave desconocida (un typo no se ignora)", '{ "githubapp": {} }', /formato esperado/],
    ["tiene el clientId vacío", '{ "githubApp": { "clientId": " " } }', /formato esperado/],
    ["tiene un clientId que no es texto", '{ "githubApp": { "clientId": 7 } }', /formato esperado/],
    ["tiene el clientId de Linear vacío", '{ "linear": { "clientId": "" } }', /formato esperado/],
    ["trae una clave desconocida dentro de linear", '{ "linear": { "client_id": "x" } }', /formato esperado/],
  ])("un config.json que %s lanza con la ruta", (_name, content, message) => {
    const dir = dataDir(content);
    expect(() => readCoreConfig(dir, {})).toThrow(message);
    expect(() => readCoreConfig(dir, {})).toThrow(join(dir, "config.json"));
  });

  test("un config.json que es una carpeta no se confunde con uno ausente", () => {
    const dir = dataDir();
    mkdirSync(join(dir, "config.json"));
    expect(() => readCoreConfig(dir, {})).toThrow(/EISDIR/);
  });
});

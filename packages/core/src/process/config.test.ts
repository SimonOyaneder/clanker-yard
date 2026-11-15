import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { GITHUB_APP_CLIENT_ID_ENV, readCoreConfig } from "./config";

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

  test("un archivo sin githubApp es una config vacía", () => {
    expect(readCoreConfig(dataDir("{}"), {})).toEqual({});
  });

  test.each([
    ["no es JSON", "{ githubApp", /config\.json no es JSON válido/],
    ["trae una clave desconocida (un typo no se ignora)", '{ "githubapp": {} }', /formato esperado/],
    ["tiene el clientId vacío", '{ "githubApp": { "clientId": " " } }', /formato esperado/],
    ["tiene un clientId que no es texto", '{ "githubApp": { "clientId": 7 } }', /formato esperado/],
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

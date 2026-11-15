import { copyFileSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openStore } from "@clanker/core";
import { scenarios, type Scenario } from "./scenarios";

export interface TestHome {
  /** Carpeta que se pasa como `CLANKER_HOME`. */
  path: string;
  /** `clanker.db` dentro de `path`: lo que abre el core. */
  dbPath: string;
  /** Variables de entorno para lanzar el core o la app contra esta carpeta. */
  env: { CLANKER_HOME: string };
  /** Borra la carpeta. */
  cleanup(): void;
}

function createHome(): TestHome {
  const path = mkdtempSync(join(tmpdir(), "clanker-home-"));
  return {
    path,
    dbPath: join(path, "clanker.db"),
    env: { CLANKER_HOME: path },
    cleanup: () => rmSync(path, { recursive: true, force: true }),
  };
}

/** Migra y siembra la base del escenario en `dbPath`. Al cerrar queda un único archivo `.sqlite`. */
function writeScenario(scenario: Scenario, dbPath: string): void {
  const seed = scenarios[scenario];
  const store = openStore({ path: dbPath });
  try {
    seed(store);
  } finally {
    store.close();
  }
}

/** Un `CLANKER_HOME` temporal con la base sembrada por `scenario`. */
export function seedDb(scenario: Scenario): TestHome {
  const home = createHome();
  try {
    writeScenario(scenario, home.dbPath);
  } catch (error) {
    home.cleanup();
    throw error;
  }
  return home;
}

/** Un `CLANKER_HOME` temporal con una copia del `.sqlite` en `path`; el original no se toca. */
export function loadFixture(path: string): TestHome {
  const home = createHome();
  try {
    copyFileSync(path, home.dbPath);
  } catch (error) {
    home.cleanup();
    throw error;
  }
  return home;
}

/** Genera `<dir>/<escenario>.sqlite` con el schema vigente; así se regeneran las fixtures. */
export function writeFixture(scenario: Scenario, dir: string): string {
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `${scenario}.sqlite`);
  rmSync(path, { force: true });
  writeScenario(scenario, path);
  return path;
}

import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { scenarios, writeFixture, writeTechleadFixture, type Scenario } from "../src/index";

// Las fixtures no se versionan (*.sqlite está en .gitignore): se generan con el schema vigente.
const dir = fileURLToPath(new URL("../fixtures/db", import.meta.url));

for (const scenario of Object.keys(scenarios) as Scenario[]) {
  console.log(writeFixture(scenario, dir));
}

// El resultado de correr `de-issue-a-pr` de punta a punta con el fake (`src/techlead-scenario.ts`): una
// issue en done con su PR draft, sus pasos, costos y eventos.
console.log(await writeTechleadFixture(join(dir, "techlead-done.sqlite")));

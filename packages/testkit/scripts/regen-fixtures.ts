import { fileURLToPath } from "node:url";
import { scenarios, writeFixture, type Scenario } from "../src/index";

// Las fixtures no se versionan (*.sqlite está en .gitignore): se generan con el schema vigente.
const dir = fileURLToPath(new URL("../fixtures/db", import.meta.url));

for (const scenario of Object.keys(scenarios) as Scenario[]) {
  console.log(writeFixture(scenario, dir));
}

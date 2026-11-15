// Entrada del proceso del core (`docs/design.html#d-data`, "Proceso del core"). Se empaqueta como
// `dist/main.js` (`npm run build -w @clanker/core`) y la app lo lanza con `ensureCore`.
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { clankerDirs } from "@clanker/api/node";
import { runCore } from "./process/core";

const { values } = parseArgs({
  options: { "data-dir": { type: "string" }, "log-dir": { type: "string" } },
  strict: true,
});

const home = process.env.CLANKER_HOME;
const dataDir = values["data-dir"] ?? home;
if (!dataDir) {
  console.error("Falta --data-dir (o CLANKER_HOME): el core no adivina dónde guardar sus datos.");
  process.exit(2);
}

const result = await runCore({
  dataDir,
  logDir: values["log-dir"] ?? clankerDirs().logDir,
  migrationsFolder: fileURLToPath(new URL("../migrations", import.meta.url)),
  isolated: home !== undefined,
});
if (result === "running") process.exit(0);

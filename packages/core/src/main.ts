// Entrada del proceso del core (`docs/design.html#d-data`, "Proceso del core"). Se empaqueta como
// `dist/main.js` (`npm run build -w @clanker/core`) y la app lo lanza con `ensureCore`.
import { fileURLToPath } from "node:url";
import { text } from "node:stream/consumers";
import { parseArgs } from "node:util";
import { logDirFor } from "@clanker/api/node";
import { runCore } from "./daemon/core";

const { values } = parseArgs({
  options: { "data-dir": { type: "string" }, "log-dir": { type: "string" }, "ui-key-stdin": { type: "boolean" } },
  strict: true,
});

const home = process.env.CLANKER_HOME;
const dataDir = values["data-dir"] ?? home;
if (!dataDir) {
  console.error("Falta --data-dir (o CLANKER_HOME): el core no adivina dónde guardar sus datos.");
  process.exit(2);
}

// El hash de la llave de la app llega por stdin (`ensureCore`), nunca por argv ni env, que otro proceso puede leer.
const uiKeyHash = values["ui-key-stdin"] ? (await text(process.stdin)).trim() : undefined;
if (uiKeyHash !== undefined && !/^[0-9a-f]{64}$/.test(uiKeyHash)) {
  console.error("--ui-key-stdin espera por stdin el SHA-256 de la llave de la app, en hex.");
  process.exit(2);
}

const result = await runCore({
  uiKeyHash,
  dataDir,
  logDir: values["log-dir"] ?? logDirFor(dataDir),
  migrationsFolder: fileURLToPath(new URL("../migrations", import.meta.url)),
  factoryPacksDir: fileURLToPath(new URL("../packs", import.meta.url)),
  isolated: home !== undefined,
});
if (result === "running") process.exit(0);

// Paridad del import con el LoopSummary de Clanker Control contra una carpeta del clanker-loop real:
// `npm run verify:legacy-summary -w @clanker/core [-- <carpeta>]` (por defecto `~/.local/share/clanker-loop`).
// Importa a una base en memoria (la carpeta solo se lee, no se toca ningún `CLANKER_HOME`), imprime cada cifra de
// Control junto a la de Yard y sale con error si alguna no cuadra. Lo que difiere a propósito sale con `~` (ver `./summary-parity`).
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { compareWithControl, formatChecks, importInMemory } from "./summary-parity";

const from = resolve(process.argv[2] ?? join(homedir(), ".local/share/clanker-loop"));
const { store, dispose } = importInMemory(from);
try {
  const checks = compareWithControl(store, from);
  console.log(formatChecks(checks));
  const failed = checks.filter((c) => !c.ok);
  const total = (field: string, side: "control" | "yard") => checks.filter((c) => c.field === field).reduce((sum, c) => sum + Number(c[side]), 0);
  console.log(
    `\nTotal de los proyectos: Control ${total("issues (corridas)", "control")} issues y $${total("USD", "control").toFixed(2)}, Yard ${total("issues (corridas)", "yard")} y $${total("USD", "yard").toFixed(2)}.`,
  );
  console.log(`${from}: ${checks.length} cifras, ${checks.filter((c) => c.note).length} con diferencia explicada, ${failed.length} sin cuadrar.`);
  if (failed.length > 0) process.exitCode = 1;
} finally {
  dispose();
}

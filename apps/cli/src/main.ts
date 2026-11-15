import { readFileSync } from "node:fs";
import { clankerDirs, connectToCore } from "@clanker/api/node";
import { METRICS_COMPARE_USAGE, metricsCompare } from "./metrics-compare";

async function main(argv: string[]): Promise<string> {
  const [group, command, ...args] = argv;
  if (group !== "metrics" || command !== "compare") throw new Error(METRICS_COMPARE_USAGE);
  const core = await connectToCore(clankerDirs().dataDir, "cli");
  if (!core) throw new Error("No hay un core corriendo: abre Clanker Yard e inténtalo de nuevo.");
  return metricsCompare(args, { client: core.client, readFile: (path) => readFileSync(path, "utf8") });
}

main(process.argv.slice(2)).then(
  (out) => console.log(out),
  (error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  },
);

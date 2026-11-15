import { readFileSync } from "node:fs";
import { runCli } from "./cli";
import { connectCore } from "./core-client";

const interrupt = new AbortController();
// Un segundo Ctrl+C mata el proceso aunque el comando no escuche la señal.
process.on("SIGINT", () => (interrupt.signal.aborted ? process.exit(130) : interrupt.abort()));

let client: ReturnType<typeof connectCore> | undefined;

runCli(process.argv.slice(2), {
  client: () => (client ??= connectCore()),
  write: (line) => console.log(line),
  readFile: (path) => readFileSync(path, "utf8"),
  signal: interrupt.signal,
}).then(
  () => process.exit(),
  (error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  },
);

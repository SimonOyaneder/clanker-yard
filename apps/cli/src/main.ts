import { readFileSync } from "node:fs";
import { runCli } from "./cli";
import { connectCore } from "./core-client";

const interrupt = new AbortController();
// Un segundo Ctrl+C mata el proceso aunque el comando no escuche la señal.
process.on("SIGINT", () => (interrupt.signal.aborted ? process.exit(130) : interrupt.abort()));

let core: ReturnType<typeof connectCore> | undefined;
const connection = () => (core ??= connectCore());

runCli(process.argv.slice(2), {
  client: async () => (await connection()).client,
  // Sin memoizar: el puente MCP lo vuelve a pedir cuando el core se reinicia con otro puerto y token.
  mcpEndpoint: async () => {
    const { info } = await connectCore();
    return { url: `http://127.0.0.1:${info.port}/mcp`, token: info.token };
  },
  write: (line) => console.log(line),
  readFile: (path) => readFileSync(path, "utf8"),
  sleep: (ms) =>
    new Promise((resolve) => {
      const timer = setTimeout(resolve, ms);
      interrupt.signal.addEventListener("abort", () => (clearTimeout(timer), resolve()), { once: true });
    }),
  signal: interrupt.signal,
}).then(
  () => process.exit(),
  (error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  },
);

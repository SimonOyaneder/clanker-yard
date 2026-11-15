import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { API_MAJOR, createClient } from "@clanker/api";
import { removeCoreJson, writeCoreJson } from "@clanker/api/node";
import { createConnections, createFileSecrets, createRepos, openStore, startCore } from "@clanker/core";
import { createFakeRuntime, tempGitRepo } from "../src/index";

// Un core de demostración con el runtime fake y la plantilla `juguete`: un proyecto local con tres issues
// y un repo git temporal. Publica `core.json` en CLANKER_HOME, así la app de escritorio (o la CLI) se
// conecta a él como a un core real; las corridas duran unos 7 s para verlas avanzar en la UI.
//
//   CLANKER_HOME=$(mktemp -d) npm run demo-core -w @clanker/testkit

const home = process.env.CLANKER_HOME;
if (!home) {
  console.error("Falta CLANKER_HOME: usa una carpeta temporal (CLANKER_HOME=$(mktemp -d)) para no tocar tus datos reales.");
  process.exit(1);
}

const fixtures = fileURLToPath(new URL("../fixtures/runs/juguete-lento", import.meta.url));
const store = openStore({ path: join(home, "clanker.db") });
const repo = tempGitRepo({});
const core = await startCore({
  store,
  dataDir: home,
  connections: createConnections(store, createFileSecrets({ dir: join(home, "secrets") })),
  runtimes: [createFakeRuntime({ fixtures })],
  env: { CORE_RUNTIME: "fake" },
  coreVersion: "0.0.0-demo",
  onShutdown: () => void stop(),
});

const client = createClient({ url: core.server.url, token: core.server.token, origin: "cli" });
const repoId = createRepos(store).add({ name: "demo", path: repo.dir });
const project = await client.projects.create({
  slug: "demo",
  name: "Demo",
  tracker: "local",
  defaultFlowId: "juguete",
  defaultProfileId: "juguete",
  parallel: 2,
  flowParams: { repo: repoId },
});
for (const title of ["Saluda al mundo", "Saluda a la luna", "Saluda al sol"]) {
  await client.issues.createLocal({ projectId: project.id, title });
}

writeCoreJson(home, {
  pid: process.pid,
  port: core.server.port,
  token: core.server.token,
  version: "0.0.0-demo",
  apiMajor: API_MAJOR,
  bootId: core.server.bootId,
});
console.log(`core de demo en 127.0.0.1:${core.server.port} (CLANKER_HOME=${home}). Ctrl+C para cerrarlo.`);

let stopping: Promise<void> | undefined;
function stop(): Promise<void> {
  stopping ??= (async () => {
    removeCoreJson(home!);
    await core.close();
    store.close();
    repo.cleanup();
    process.exit(0);
  })();
  return stopping;
}
process.once("SIGINT", () => void stop());
process.once("SIGTERM", () => void stop());

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { API_MAJOR, createClient } from "@clanker/api";
import { removeCoreJson, writeCoreJson } from "@clanker/api/node";
import { createConnections, createFileSecrets, createRepos, openStore, startCore, startFakeLinear } from "@clanker/core";
import { createFakeClaude, createFakeRuntime, type FakeClaudeScenario, startGitHubSim, tempGitRepo } from "../src/index";

// Un core de demostración con el runtime fake y la plantilla `juguete`: un proyecto local con tres issues
// y tres repos git temporales (sin receta, con una válida y con una inválida). Publica `core.json` en
// CLANKER_HOME, así la app de escritorio (o la CLI) se conecta a él como a un core real; las corridas duran
// unos 7 s para verlas avanzar en la UI.
//
// Las conexiones nunca salen a internet: GitHub es el simulador (`startGitHubSim`, acepta el PAT
// `github_pat_demo`), Linear es el falso del core y Claude un `query` falso. Para ver una conexión vencida sin
// esperar, escribe `<CLANKER_HOME>/demo-control.json` con `{ "clockDays": 40, "claude": "login_expired" }`: el
// reloj de las conexiones se adelanta esos días y la próxima prueba de Claude responde ese escenario.
//
//   CLANKER_HOME=$(mktemp -d) npm run demo-core -w @clanker/testkit

const home = process.env.CLANKER_HOME;
if (!home) {
  console.error("Falta CLANKER_HOME: usa una carpeta temporal (CLANKER_HOME=$(mktemp -d)) para no tocar tus datos reales.");
  process.exit(1);
}

const fixtures = fileURLToPath(new URL("../fixtures/runs/juguete-lento", import.meta.url));
const store = openStore({ path: join(home, "clanker.db") });
const repo = tempGitRepo({ remote: true });
const withRecipe = tempGitRepo({
  commits: [
    {
      message: "chore: add the recipe",
      files: {
        ".clanker/recipe.json": JSON.stringify({
          version: 1,
          requires: [{ name: "Git", check: "git --version" }],
          setup: { worktree: ["for i in 1 2 3; do echo \"instalando dependencias $i/3\"; sleep 0.3; done"], slot: [] },
        }),
      },
    },
  ],
});
const withBrokenRecipe = tempGitRepo({ commits: [{ message: "chore: add a broken recipe", files: { ".clanker/recipe.json": JSON.stringify({ version: 1, checks: ["no-existe"] }) } }] });

const github = await startGitHubSim({ origin: repo, token: "github_pat_demo" });
const linear = await startFakeLinear({ clientId: "demo-client" });
const control = (): { clockDays?: number; claude?: FakeClaudeScenario } => {
  try {
    return JSON.parse(readFileSync(join(home, "demo-control.json"), "utf8"));
  } catch {
    return {};
  }
};
// El reloj de las conexiones parte de una fecha fija: el PAT del simulador vence el 2026-12-20 y la demo no debe
// depender del día en que se corre.
const CLOCK_START = Date.UTC(2026, 10, 15, 12);
const claude = createFakeClaude({ scenario: () => control().claude ?? "ready" });
const core = await startCore({
  store,
  dataDir: home,
  connections: createConnections(store, createFileSecrets({ dir: join(home, "secrets") }), {
    github: { baseUrl: github.baseUrl },
    linear: { clientId: "demo-client", redirectPort: 0, endpoints: linear.endpoints },
    claude: claude.options,
    now: () => CLOCK_START + (control().clockDays ?? 0) * 86_400_000,
  }),
  runtimes: [createFakeRuntime({ fixtures, transcripts: join(home, "transcripts") })],
  env: { CORE_RUNTIME: "fake" },
  // La demo deja las issues en la cola para lanzarlas a mano desde la UI.
  scheduler: false,
  coreVersion: "0.0.0-demo",
  onShutdown: () => void stop(),
});

const client = createClient({ url: core.server.url, token: core.server.token, origin: "cli" });
const repos = createRepos(store);
const repoId = repos.add({ name: "demo", path: repo.dir });
repos.add({ name: "demo-receta", path: withRecipe.dir });
repos.add({ name: "demo-rota", path: withBrokenRecipe.dir });
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
    await Promise.all([github.close(), linear.close()]);
    claude.cleanup();
    for (const r of [repo, withRecipe, withBrokenRecipe]) r.cleanup();
    process.exit(0);
  })();
  return stopping;
}
process.once("SIGINT", () => void stop());
process.once("SIGTERM", () => void stop());

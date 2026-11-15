import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { API_MAJOR, createClient, type FlowDef, FlowBody } from "@clanker/api";
import { removeCoreJson, writeCoreJson } from "@clanker/api/node";
import { createConnections, createDefs, createFileSecrets, createRepos, closeDecision, JUGUETE_FLOW, openDecision, openStore, startCore, startFakeLinear } from "@clanker/core";
import { createFakeClaude, createFakeRuntime, type FakeClaudeScenario, seedLanes, seedSummary, startGitHubSim, tempGitRepo } from "../src/index";

// Un core de demostración con el runtime fake y la plantilla `juguete`: un proyecto local con tres issues
// y tres repos git temporales (sin receta, con una válida y con una inválida). Publica `core.json` en
// CLANKER_HOME, así la app de escritorio (o la CLI) se conecta a él como a un core real; las corridas duran
// unos 7 s para verlas avanzar en la UI.
//
// Con DEMO_INBOX=1 se suma el proyecto "Bandeja de prueba", que arranca una corrida por cada tipo de decisión para
// ver la bandeja: un gate, un paso sin edge (needs_human), un tope de gasto, una nota de revisión que no bloquea y
// una alerta suelta.
//
// Con `DEMO_SCENARIO=summary` además importa el fixture del clanker-loop y le suma corridas de Yard con sus pasos
// (`summary-scenario.ts`): el proyecto de las capturas del Resumen.
//
// Las conexiones nunca salen a internet: GitHub es el simulador (`startGitHubSim`, acepta el PAT
// `github_pat_demo`), Linear es el falso del core y Claude un `query` falso. Para ver una conexión vencida sin
// esperar, escribe `<CLANKER_HOME>/demo-control.json` con `{ "clockDays": 40, "claude": "login_expired" }`: el
// reloj de las conexiones se adelanta esos días y la próxima prueba de Claude responde ese escenario.
//
// Con `DEMO_SCENARIO=lanes` además siembra el proyecto de la vista de Operación (`lanes-scenario.ts`): dev lleno,
// una corrida estacionada, un rebase en mantenimiento y un breaker abierto.
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
const control = (): { clockDays?: number; claude?: FakeClaudeScenario; closeAlert?: boolean } => {
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
const lanes = process.env.DEMO_SCENARIO === "lanes";
// En el escenario de carriles el repo tiene remoto, para que `prs.list` conozca los PRs que deja sembrados.
const repoId = repos.add({ name: "demo", path: repo.dir, remote: lanes ? "octocat/demo" : null });
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

// Con DEMO_INBOX=1, la bandeja: flujos de juguete que dejan una decisión de cada tipo. Se guardan directo en
// `defs` (el core no tiene API para escribir flujos todavía); el motor los lee al lanzar cada corrida.
if (process.env.DEMO_INBOX) {
  const defs = createDefs(store);
  defs.register("flow", FlowBody);
  const toy = (id: string, name: string, extra: Partial<FlowDef> & { nodes: FlowDef["nodes"] }) => {
    defs.save({ kind: "flow", slug: id, scope: "user", body: { ...JUGUETE_FLOW, id, name, ...extra }, source: "demo" });
  };
  const saludar = JUGUETE_FLOW.nodes.saludar!;
  toy("juguete-gate", "Juguete con gate", {
    start: "acquire",
    nodes: {
      ...JUGUETE_FLOW.nodes,
      acquire: { ...JUGUETE_FLOW.nodes.acquire!, on: { ok: "publicar" } },
      publicar: {
        type: "gate",
        question: "¿Publico el saludo?",
        options: [
          { id: "publish", label: "Publicar el saludo" },
          { id: "skip", label: "No publicar todavía" },
        ],
        on: { publish: "saludar", skip: "release" },
      },
    },
  });
  toy("juguete-trabado", "Juguete sin edge", { nodes: { ...JUGUETE_FLOW.nodes, saludar: { ...saludar, on: {} } } });
  toy("juguete-tope", "Juguete con tope", { limits: { maxCostUsd: 0.005 }, nodes: JUGUETE_FLOW.nodes });
  toy("juguete-nota", "Juguete con nota", { nodes: { ...JUGUETE_FLOW.nodes, saludar: { ...saludar, on: { ok: { to: "release", note: "El saludo quedó sin revisar" } } } } });

  const inbox = await client.projects.create({
    slug: "bandeja-demo",
    name: "Bandeja de prueba",
    tracker: "local",
    defaultFlowId: "juguete",
    defaultProfileId: "juguete",
    parallel: 4,
  });
  for (const [flow, title] of [
    ["juguete-gate", "Saluda a Marte"],
    ["juguete-trabado", "Saluda a Venus"],
    ["juguete-tope", "Saluda a Saturno"],
    ["juguete-nota", "Saluda a Mercurio"],
  ] as const) {
    const issue = await client.issues.createLocal({ projectId: inbox.id, title });
    await client.runs.start({ projectId: inbox.id, issueId: issue.id, flow, params: { repo: repoId } });
  }
  // Como la alerta de un breaker: sin opciones, el core la cierra cuando la causa se va. Aquí, cuando `demo-control.json`
  // trae `closeAlert: true`.
  const alert = store.tx((tx) =>
    openDecision(tx, {
      kind: "alert",
      title: "La conexión de Linear venció",
      body: "El refresh token de Linear ya no vale: las issues no se sincronizan hasta que vuelvas a conectar la cuenta.",
    }),
  );
  const closing = setInterval(() => {
    if (!control().closeAlert) return;
    clearInterval(closing);
    store.tx((tx) => closeDecision(tx, alert.id, { status: "superseded", by: "core" }));
  }, 500);
  closing.unref();
}

if (lanes) {
  // Sin una cuenta de GitHub conectada, `prs.list` no conoce el remoto del repo y los PRs sembrados no salen.
  await client.connections.setPat({ token: "github_pat_demo" });
  await seedLanes({ client, store, repoId });
}

if (process.env.DEMO_SCENARIO === "summary") await seedSummary({ client, store });

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

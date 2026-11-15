import { copyFileSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createClient, type Client, type ClankerProject, type Event, type IssueId, type NewProject, type Run } from "@clanker/api";
import {
  createConnections,
  createFileSecrets,
  createIssues,
  createLinearTracker,
  createRepos,
  openStore,
  startCore,
  startFakeLinear,
  type AgentRuntime,
  type Core,
  type FakeLinear,
  type FakeProject,
  type FakeTeam,
  type Store,
} from "@clanker/core";
import { createFakeRuntime } from "./fake-runtime";
import { tempGitRepo, type TempGitRepo } from "./git";
import { startGitHttpServer } from "./git-http";
import { startGitHubSim, type GitHubSim, type SimPr } from "./github-sim";
import { seedDb, type TestHome } from "./home";

// El escenario de la fase 1 (`docs/design.html#fases`): una issue de un proyecto con tracker local corre
// `techlead-clasico` en el core real (`startCore`) con el runtime fake hasta un PR draft en el GitHub
// simulado, pasando por reviews, commits, checks, `/review` y `pr-feedback`, sin ningún LLM. Lo usan
// el test de punta a punta y la fixture `.sqlite` con el resultado.

export const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), "../fixtures/runs/techlead-e2e");

export const ACCOUNT = "acme";
export const TOKEN = "github_pat_UNIQUE-0123456789";
export const REPO = "acme/web";
export const BOT = "review-bot[bot]";
const COMMENT_PREFIX = "[clanker] ";

/** El pack de la org del repo: un bot que se pide con `/review`, se resuelve a sí mismo y cuyo LGTM vale solo sobre el head. */
const PACK = {
  id: "acme",
  version: 1,
  activate: { githubOrgs: ["acme"] },
  reviewBot: {
    logins: [BOT],
    request: { type: "comment", body: "/review" },
    lgtm: { reviewState: "APPROVED", bodyMatch: "LGTM", sameSha: true },
    resolvableAuthors: [BOT],
  },
  conventions: { commentPrefix: COMMENT_PREFIX, councilPrefix: "[clanker-council] " },
};

const RECIPE = {
  version: 1,
  slots: { dev: 1, maintenance: 1 },
  commands: { test: "npm test -- {{files}}" },
  checks: ["test"],
};

/** Lo que el bot contesta cada vez que le piden `/review`, en orden: primero pide un cambio y después da LGTM. */
export type BotTurn = "lgtm" | { findings: string[] };

const LINEAR_CLIENT_ID = "test-client-id";
const LINEAR_STATES = [
  { name: "Todo", type: "unstarted" },
  { name: "In Progress", type: "started" },
  { name: "In Review", type: "started" },
  { name: "Done", type: "completed" },
  { name: "Canceled", type: "canceled" },
];

export interface TechleadScenarioOptions {
  /**
   * Pisa el guion del bot (por defecto un hallazgo y después LGTM): una lista con lo que contesta a cada `/review`
   * en orden, o una función que decide por PR (con varias corridas a la vez el orden de los `/review` no es de nadie).
   */
  bot?: BotTurn[] | ((pr: SimPr) => BotTurn);
  /** De dónde salen las issues: el tracker `local` (por defecto) o el adapter de Linear contra el Linear falso. */
  tracker?: "local" | "linear";
  /** Carpetas de guiones del runtime fake, además de `FIXTURES` (un test que corre otro flujo sobre el PR). */
  fixtures?: string[];
  /** Enciende Watch (por defecto sí). Un test que emite los eventos de PR a mano lo apaga para que nada los repita. */
  watch?: boolean;
  /** Enciende el Scheduler (por defecto no: `run()` lanza a mano). Con él, las issues de la cola se lanzan solas. */
  scheduler?: boolean;
  /** Campos del proyecto que se crea (`parallel`, `maxCostUsd`, `stackOn`...). */
  project?: Partial<NewProject>;
  /** Los ms entre las pruebas de un breaker (`StartCoreOptions.breakerBackoffMs`). */
  breakerBackoffMs?: readonly number[];
  /** Pisa la receta del repo (`.clanker/recipe.json`). */
  recipe?: Record<string, unknown>;
  /** El runtime de agentes, en lugar del fake con los guiones de `fixtures`. Un reinicio vuelve a pasar el mismo: sus sesiones sobreviven al core, como las de Claude. */
  runtime?: AgentRuntime;
}

/** La corrida con sus pasos, como la devuelve `runs.get`. */
export type RunDetail = Awaited<ReturnType<Client["runs"]["get"]>>;

export interface TechleadScenario {
  /** `client`, `core` y `store` son los del core de turno: `restart()` los reemplaza. */
  client: Client;
  core: Core;
  store: Store;
  home: TestHome;
  repo: TempGitRepo;
  github: GitHubSim;
  /** El Linear falso, con `tracker: "linear"`, con su equipo y su proyecto. */
  linear: FakeLinear | undefined;
  team: FakeTeam | undefined;
  linearProject: FakeProject | undefined;
  project: ClankerProject;
  /** Crea una issue en el tracker del proyecto y lanza `techlead-clasico` sobre ella, con `params` del flujo si se piden. */
  run(params?: Record<string, unknown>): Promise<{ issueId: IssueId; run: Run }>;
  /** La corrida hija (el subflujo `pr-feedback`) de `runId`. */
  feedback(runId: string): Promise<RunDetail>;
  /** La corrida con sus pasos, cuando termina (`run.finished` o `run.parked`). */
  finished(runId: string): Promise<RunDetail>;
  /** El PR que abrió la corrida, en el GitHub simulado. */
  pr(): SimPr;
  /** Las credenciales con las que llegó cada request al servidor git. */
  gitAuthorizations: string[];
  /** Los hashes de commit de la branch del PR en el remoto, del más nuevo al más viejo, con su asunto. */
  remoteLog(branch: string): { sha: string; subject: string }[];
  /**
   * Un corte: apaga el core (sin drain: interrumpe a los agentes y deja cada paso en curso como lo dejaría un apagado),
   * cierra la base y arranca otro core sobre el mismo `CLANKER_HOME`, que recupera lo que quedó a medias.
   */
  restart(): Promise<void>;
  /** Cierra el core y la base (con su WAL volcado) y copia `clanker.db` a `path`. */
  saveDb(path: string): Promise<void>;
  cleanup(): Promise<void>;
}

export async function startTechleadScenario(options: TechleadScenarioOptions = {}): Promise<TechleadScenario> {
  const home = seedDb("empty");
  let store = openStore({ path: home.dbPath });
  const repo = tempGitRepo({
    remote: true,
    commits: [
      {
        message: "chore: base",
        files: {
          "package.json": '{ "name": "web", "private": true }\n',
          "src/index.ts": "export {};\n",
          ".clanker/recipe.json": `${JSON.stringify(options.recipe ?? RECIPE, null, 2)}\n`,
        },
      },
    ],
  });
  repo.git("--git-dir", repo.remoteDir!, "config", "http.receivepack", "true");
  const gitServer = await startGitHttpServer(repo.remoteDir!, { user: ACCOUNT, password: TOKEN });
  const github = await startGitHubSim({ origin: repo, repo: REPO, account: ACCOUNT, token: TOKEN, bot: BOT });

  const turns: BotTurn[] = typeof options.bot === "function" ? [] : [...(options.bot ?? [{ findings: ["Falta incluir el monto en el mensaje del error"] }, "lgtm"])];
  github.onComment((pr, body) => {
    if (body.split("\n")[0] !== "/review") return;
    const turn = typeof options.bot === "function" ? options.bot(pr) : turns.shift();
    if (turn === undefined) throw new Error("El bot simulado no tiene más respuestas guionadas para otro `/review`.");
    if (turn === "lgtm") pr.botLgtm();
    else pr.botFindings(turn.findings.map((finding) => ({ body: finding, path: "src/transfer.ts", line: 2 })));
    // El CI del head de ese momento termina verde: cada push parte de cero checks.
    pr.ci("green");
  });

  const packDir = join(home.path, "packs", "acme");
  mkdirSync(packDir, { recursive: true });
  writeFileSync(join(packDir, "pack.json"), JSON.stringify(PACK));

  const useLinear = options.tracker === "linear";
  const linear = useLinear ? await startFakeLinear({ clientId: LINEAR_CLIENT_ID }) : undefined;
  const runtime = options.runtime ?? createFakeRuntime({ fixtures: [FIXTURES, ...(options.fixtures ?? [])], speed: Infinity });

  const newConnections = () =>
    createConnections(store, createFileSecrets({ dir: join(home.path, "secrets") }), {
      github: { baseUrl: github.baseUrl },
      ...(linear && { linear: { clientId: LINEAR_CLIENT_ID, redirectPort: 0, endpoints: linear.endpoints } }),
    });
  let connections = newConnections();
  await connections.connect({ provider: "github", account: ACCOUNT, scopes: [], token: TOKEN }, "core");
  if (linear) {
    const { url, done } = await connections.linearAuth("ui");
    await fetch((await fetch(url, { redirect: "manual" })).headers.get("location")!);
    await done;
  }

  /** El core sobre `store` y `connections`: lo mismo la primera vez que tras un corte. */
  async function bootCore(): Promise<{ core: Core; client: Client }> {
    const core = await startCore({
      store,
      dataDir: home.path,
      connections,
      runtimes: [runtime],
      env: { CORE_RUNTIME: "fake" },
      scheduler: options.scheduler ?? false,
      gitUrl: () => gitServer.url,
      linearEndpoint: linear?.endpoints.graphql,
      coreVersion: "0.0.0",
      onShutdown: () => {},
      watch: options.watch ?? true,
      ...(options.breakerBackoffMs && { breakerBackoffMs: options.breakerBackoffMs }),
    });
    return { core, client: createClient({ url: core.server.url, token: core.server.token, origin: "cli" }) };
  }
  let { core, client } = await bootCore();

  const repoId = createRepos(store).add({ name: "web", path: repo.dir, remote: REPO });
  let team: FakeTeam | undefined;
  let linearProject: FakeProject | undefined;
  if (linear) {
    team = linear.workspace.addTeam("WEB", LINEAR_STATES);
    linearProject = linear.workspace.addProject("Web");
  }
  const project = await client.projects.create({
    slug: "web",
    name: "Web",
    tracker: linearProject ? "linear" : "local",
    ...(linearProject && { trackerRef: linearProject.id }),
    defaultFlowId: "techlead-clasico",
    defaultProfileId: "eco",
    repos: [{ repoId }],
    ...options.project,
  });

  let abort: AbortController;
  const seen = new Map<string, Event>();
  const waiters = new Map<string, (event: Event) => void>();
  /** Sigue `run.finished` y `run.parked` del proyecto en el core de turno (el stream rellena desde el seq 0). */
  function follow() {
    abort = new AbortController();
    const ended = client.events.stream({ filter: { projectId: project.id, types: ["run.finished", "run.parked"] } }, { signal: abort.signal });
    void (async () => {
      for await (const event of await ended) {
        if (event.runId === undefined) continue;
        seen.set(event.runId, event);
        waiters.get(event.runId)?.(event);
      }
    })().catch(() => {});
  }
  follow();

  let closed = false;
  async function closeCore() {
    if (closed) return;
    closed = true;
    abort.abort();
    await core.close();
    store.close();
  }

  const scenario: TechleadScenario = {
    client,
    core,
    store,
    home,
    repo,
    github,
    linear,
    team,
    linearProject,
    project,
    gitAuthorizations: gitServer.authorizations,
    async run(params) {
      const title = "Validar el monto de una transfer";
      const body = "Una transfer con un monto negativo no debería crearse.\n\nCriterios de aceptación\n- El monto se redondea\n- Un monto menor o igual a 0 se rechaza\n";
      let issueId: IssueId;
      if (linear && team && linearProject) {
        const created = linear.workspace.addIssue({ team, title, description: body, project: linearProject });
        // Con el Scheduler apagado nadie sincroniza el caché de un proyecto de Linear: se llena a mano.
        await createIssues(store).sync(createLinearTracker({ connections, endpoint: linear.endpoints.graphql }), {
          projectId: project.id,
          project: { tracker: "linear", id: linearProject.id },
        });
        issueId = (await client.issues.list({ projectId: project.id })).find((i) => i.ref.key === created.identifier)!.id;
      } else {
        issueId = (await client.issues.createLocal({ projectId: project.id, title, body })).id;
      }
      return { issueId, run: await client.runs.start({ projectId: project.id, issueId, params }) };
    },
    async feedback(runId) {
      const child = store.db.$client.prepare("SELECT id FROM runs WHERE parent_run_id = ?").get(runId) as { id: Run["id"] } | undefined;
      if (!child) throw new Error(`La corrida ${runId} no abrió ningún subflujo.`);
      return client.runs.get({ id: child.id });
    },
    async finished(runId) {
      if (!seen.has(runId)) await new Promise<Event>((resolve) => waiters.set(runId, resolve));
      return client.runs.get({ id: runId as Run["id"] });
    },
    pr: () => github.pr(1),
    remoteLog: (branch) =>
      repo
        .git("--git-dir", repo.remoteDir!, "log", "--format=%H %s", `main..refs/heads/${branch}`)
        .split("\n")
        .filter(Boolean)
        .map((line) => ({ sha: line.slice(0, 40), subject: line.slice(41) })),
    async restart() {
      abort.abort();
      await core.close();
      store.close();
      store = openStore({ path: home.dbPath });
      connections = newConnections();
      ({ core, client } = await bootCore());
      Object.assign(scenario, { core, client, store });
      follow();
    },
    async saveDb(path) {
      await closeCore();
      mkdirSync(dirname(path), { recursive: true });
      copyFileSync(home.dbPath, path);
    },
    async cleanup() {
      await closeCore();
      await github.close();
      await linear?.close();
      await gitServer.close();
      repo.cleanup();
      home.cleanup();
    },
  };
  return scenario;
}

/**
 * Corre el escenario completo y deja la base resultante en `path` (un `.sqlite`): corridas, pasos,
 * eventos, costos y el PR de una issue que terminó en done. Para desarrollar la UI sin gastar tokens.
 */
export async function writeTechleadFixture(path: string): Promise<string> {
  const scenario = await startTechleadScenario();
  try {
    const { run } = await scenario.run();
    const done = await scenario.finished(run.id);
    if (done.status !== "done") throw new Error(`El escenario terminó ${done.status}, no done.`);
    await scenario.saveDb(path);
  } finally {
    await scenario.cleanup();
  }
  return path;
}

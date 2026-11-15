import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { FlowDef, Role, type Profile, type RunId } from "@clanker/api";
import {
  createAgents,
  createArtifacts,
  createDefs,
  createFlows,
  createRecipes,
  createSlots,
  createWorkspaces,
  DefValidationError,
  EnvironmentError,
  EXCERPT_MAX_LINES,
  newId,
  openStore,
  PermanentActionError,
  repoScope,
  StaleLeaseError,
  type ActionCtx,
  type Artifacts,
  type Recipes,
  type Slots,
  type Store,
  type WorkspaceLease,
  type Workspaces,
} from "@clanker/core";
import { afterAll, afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { createFakeRuntime } from "./fake-runtime";
import { tempGitRepo, type TempGitRepo } from "./git";

// Se prueba aquí y no en el core: necesita repos git reales (tempGitRepo) y el runtime fake.

const runId = newId("run");
const stepId = newId("stp");

let dataDir: string;
let store: Store;
let artifacts: Artifacts;
let workspaces: Workspaces;
let slots: Slots;
let recipes: Recipes;
let repo: TempGitRepo | undefined;
let lease: WorkspaceLease | undefined;

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), "clanker-recipe-"));
  store = openStore({ path: ":memory:" });
  artifacts = createArtifacts({ store, dir: join(dataDir, "artifacts") });
  workspaces = createWorkspaces({
    store,
    dataDir,
    repos: () => ({ path: repo!.dir, defaultBranch: "main" }),
    identity: { name: "Clanker Yard", email: "yard@clanker.invalid" },
  });
  slots = createSlots({ store });
  recipes = createRecipes({ store, defs: createDefs(store), workspaces, artifacts, slots });
});

afterEach(() => {
  vi.unstubAllEnvs();
  if (lease) workspaces.release(lease);
  lease = undefined;
  repo?.cleanup();
  repo = undefined;
  store.close();
  rmSync(dataDir, { recursive: true, force: true });
});

/** Un repo con `files` en su commit base (la receta, si la hay, va en `.clanker/recipe.json`) y un worktree tomado. */
async function worktree(files: Record<string, string> = {}, recipe?: unknown): Promise<WorkspaceLease> {
  repo = tempGitRepo({
    remote: true,
    commits: [
      {
        message: "base",
        files: { "app/a.rb": "a\n", "app/gone.rb": "gone\n", ...files, ...(recipe ? { ".clanker/recipe.json": JSON.stringify(recipe) } : {}) },
      },
    ],
  });
  lease = await workspaces.acquire({ repo: "r1", branch: "cla-38", base: "main", runId });
  return lease;
}

function write(path: string, content: string) {
  const full = join(lease!.path, path);
  mkdirSync(dirname(full), { recursive: true });
  writeFileSync(full, content);
}

const logPath = () => join(dataDir, "logs", "runs", runId, `${stepId}.log`);

function ctx(signal = new AbortController().signal): ActionCtx {
  return { runId, stepId, key: `${runId}:checks:1`, signal, once: (_stage, fn) => fn() };
}

function check(scope: "changed" | "all" = "changed", slot?: number) {
  const { workspaceId, path, branch, baseSha, fencingToken } = lease!;
  return recipes.checkAction.run({ ws: { workspaceId, path, branch, baseSha, fencingToken }, scope, slot }, ctx());
}

const artifactText = (hash: string) => new TextDecoder().decode(artifacts.get(hash as never)!.content);

describe("leer la receta", () => {
  test("un repo sin receta no tiene receta", async () => {
    await worktree();
    expect(recipes.read(lease!.path)).toBeUndefined();
  });

  test("una receta válida se lee con sus valores por defecto", async () => {
    await worktree({}, { version: 1, commands: { test: "true" }, checks: ["test"] });
    expect(recipes.read(lease!.path)).toMatchObject({ version: 1, commands: { test: "true" }, checks: ["test"], env: {} });
  });

  test("una receta inválida da error con la ruta de cada campo", async () => {
    await worktree({}, { version: 1, slots: { dev: 0, maintenance: 2 }, commands: { test: "rspec {{file}}" }, checks: ["lint"] });

    const error = (() => {
      try {
        recipes.read(lease!.path);
      } catch (e) {
        return e;
      }
    })();

    expect(error).toBeInstanceOf(DefValidationError);
    expect((error as DefValidationError).issues.map((i) => i.path.join("."))).toEqual(["slots.dev", "commands.test", "checks.0"]);
    expect((error as Error).message).toMatch(/slots\.dev: .*\n.*commands\.test: .*\{\{file\}\}.*\n.*checks\.0: "lint" no está en commands/);
  });

  test("un JSON roto dice de qué archivo", async () => {
    await worktree({ ".clanker/recipe.json": "{ no es json" });
    expect(() => recipes.read(lease!.path)).toThrow(/\.clanker\/recipe\.json .* no es JSON válido/);
  });

  test("el validador del kind recipe queda registrado en las defs", () => {
    const defs = createDefs(store);
    createRecipes({ store, defs, workspaces, artifacts, slots });
    expect(() => defs.save({ kind: "recipe", slug: "r", scope: "user", body: { version: 2 }, source: "ui" })).toThrow(DefValidationError);
    expect(defs.save({ kind: "recipe", slug: "r", scope: "user", body: { version: 1 }, source: "ui" }).version).toBe(1);
  });
});

describe("ws.exec", () => {
  test("la salida completa va al log del paso y el extracto trae las últimas 60 líneas", async () => {
    await worktree();

    const red = await workspaces.exec(lease!, "seq 1 200; echo boom >&2; exit 3", { runId, stepId });
    const green = await workspaces.exec(lease!, "echo todo bien", { runId, stepId });

    expect(red.exitCode).toBe(3);
    const lines = red.extract.split("\n");
    expect(lines).toHaveLength(EXCERPT_MAX_LINES);
    expect(lines.at(-1)).toBe("boom");
    expect(lines[0]).toBe("142");
    expect(green).toEqual({ exitCode: 0, extract: "todo bien" });

    const log = readFileSync(logPath(), "utf8");
    expect(log).toContain("$ seq 1 200; echo boom >&2; exit 3\n1\n2\n");
    expect(log).toContain("200\nboom\n[exit 3]\n\n$ echo todo bien\ntodo bien\n[exit 0]\n");
  });

  test("una salida de megabytes no se guarda en memoria: el extracto sale de la cola del log", async () => {
    await worktree();

    const { extract } = await workspaces.exec(lease!, "seq 1 300000", { runId, stepId });

    const lines = extract.split("\n");
    expect(lines).toHaveLength(EXCERPT_MAX_LINES);
    expect([lines[0], lines.at(-1)]).toEqual(["299941", "300000"]);
    expect(readFileSync(logPath(), "utf8")).toContain("\n300000\n[exit 0]");
  });

  test("corre en el worktree y solo hereda un entorno mínimo más el que se le da", async () => {
    await worktree();
    vi.stubEnv("GH_TOKEN", "secreto");
    vi.stubEnv("LINEAR_API_KEY", "secreto");

    const { extract } = await workspaces.exec(lease!, 'pwd -P; echo "gh=$GH_TOKEN linear=$LINEAR_API_KEY extra=$EXTRA"', {
      runId,
      stepId,
      env: { EXTRA: "1" },
    });

    expect(extract).toBe(`${realpathSync(lease!.path)}\ngh= linear= extra=1`);
  });

  test("sin los colores ANSI, y con las líneas larguísimas recortadas", async () => {
    await worktree();
    const { extract } = await workspaces.exec(lease!, `printf '\\033[31mrojo\\033[0m\\n'; head -c 5000 /dev/zero | tr '\\0' x`, { runId, stepId });
    const [first, second] = extract.split("\n");
    expect(first).toBe("rojo");
    expect(second).toHaveLength(501);
  });

  test("un token vencido no ejecuta nada", async () => {
    await worktree();
    const stale = { ...lease!, fencingToken: lease!.fencingToken + 1 };

    await expect(workspaces.exec(stale, "touch ran", { runId, stepId })).rejects.toThrow(StaleLeaseError);
    expect(existsSync(join(lease!.path, "ran"))).toBe(false);
  });

  test("abortar mata el comando y a sus hijos y lanza la razón", async () => {
    await worktree();
    const controller = new AbortController();
    const running = workspaces.exec(lease!, "sleep 30 & echo $! > child.pid; wait", { runId, stepId, signal: controller.signal });
    // El archivo existe desde que `>` lo abre, antes de que `echo` escriba: se espera el pid, no el archivo.
    // Un pid vacío sería 0, y `kill(0, 0)` apunta al grupo del propio test y nunca lanza.
    const child = await vi.waitFor(() => {
      const pid = Number(readFileSync(join(lease!.path, "child.pid"), "utf8"));
      expect(pid).toBeGreaterThan(0);
      return pid;
    });

    controller.abort(new Error("timeout"));

    await expect(running).rejects.toThrow("timeout");
    await vi.waitFor(() => expect(() => process.kill(child, 0)).toThrow(), { timeout: 5000 });
  });
});

describe("recipe.check", () => {
  const recipe = {
    version: 1,
    commands: {
      typecheck: "echo typecheck ok",
      lint: "echo lint {{files}}",
      test: "seq 1 100; echo 'FAIL spec/a_spec.rb' >&2; exit 1",
    },
    checks: ["typecheck", "lint", "test"],
  };

  test("verde: todos los checks pasan, con su extracto como artefacto", async () => {
    await worktree({}, { ...recipe, commands: { ...recipe.commands, test: "echo 3 examples, 0 failures" } });
    write("app/a.rb", "cambiado\n");

    const result = await check();

    expect(result.outcome).toBe("ok");
    const output = result.output as { failures: string; checks: { name: string; ok: boolean; artifact: string }[] };
    expect(output.failures).toBe("");
    expect(output.checks.map((c) => [c.name, c.ok])).toEqual([["typecheck", true], ["lint", true], ["test", true]]);
    expect(artifactText(output.checks[1]!.artifact)).toBe("lint app/a.rb");
    expect(artifactText(output.checks[2]!.artifact)).toBe("3 examples, 0 failures");
  });

  test("rojo: fail con un extracto de a lo más 60 líneas y corta en el primer check rojo", async () => {
    await worktree({}, { ...recipe, checks: ["typecheck", "test", "lint"] });
    write("app/a.rb", "cambiado\n");

    const result = await check();

    expect(result.outcome).toBe("fail");
    const output = result.output as { failures: string; checks: { name: string; ok: boolean; exitCode: number; artifact: string }[] };
    expect(output.checks.map((c) => c.name)).toEqual(["typecheck", "test"]);
    expect(output.checks[1]).toMatchObject({ ok: false, exitCode: 1 });
    const [header, ...body] = output.failures.split("\n");
    expect(header).toBe("[test] exit 1");
    expect(body).toHaveLength(EXCERPT_MAX_LINES);
    expect(body.at(-1)).toBe("FAIL spec/a_spec.rb");
    expect(artifactText(output.checks[1]!.artifact)).toBe(body.join("\n"));
    // La salida completa sigue en el log; lint no corrió.
    const log = readFileSync(logPath(), "utf8");
    expect(log).toContain("\n1\n2\n3\n");
    expect(log).not.toContain("$ echo lint");
  });

  test("sustituye las variables en el comando, el entorno y el wrap", async () => {
    await worktree(
      {},
      {
        version: 1,
        env: { PORT: "{{slot+10}}", DB: "app_{{slot}}" },
        wrap: "env WRAPPED=yes KEYS={{envKeys}}",
        commands: {
          args: "echo slot={{slot}} branch={{branch}} wt={{worktree}}",
          // Cada archivo llega como un solo argumento, aunque lleve espacios o comillas.
          files: "printf '[%s]' {{files}}",
          // `env` del wrap pone WRAPPED y KEYS, y el entorno de la receta trae PORT y DB.
          vars: "env | grep -E '^(PORT|DB|WRAPPED|KEYS)=' | sort",
        },
        checks: ["args", "files", "vars"],
      },
    );
    write("app/a.rb", "x\n");
    write("app/it's new.rb", "y\n");

    const result = await check("changed", 2);

    expect(result.outcome).toBe("ok");
    const { checks } = result.output as { checks: { artifact: string }[] };
    expect(artifactText(checks[0]!.artifact)).toBe(`slot=2 branch=cla-38 wt=${lease!.path}`);
    expect(artifactText(checks[1]!.artifact)).toBe("[app/a.rb][app/it's new.rb]");
    expect(artifactText(checks[2]!.artifact)).toBe("DB=app_2\nKEYS=PORT,DB\nPORT=12\nWRAPPED=yes");
  });

  test("{{slot}} sin slot falla con un mensaje que dice qué hacer", async () => {
    await worktree({}, { version: 1, commands: { t: "echo {{slot}}" }, checks: ["t"] });
    await expect(check()).rejects.toThrow(/\{\{slot\}\}.*no tiene slot/);
  });

  test("una receta inválida o un {{slot}} sin slot no se reintentan: el paso da error al primer intento", async () => {
    await worktree({}, { version: 1, commands: { t: "echo {{slot}}" }, checks: ["t"] });
    await expect(check()).rejects.toBeInstanceOf(PermanentActionError);
    write(".clanker/recipe.json", "{ no es json");
    await expect(check()).rejects.toBeInstanceOf(PermanentActionError);

    write(".clanker/recipe.json", JSON.stringify({ version: 1, commands: { t: "echo {{slot}}" }, checks: ["t"] }));
    const defs = createDefs(store);
    const fixtures = mkdtempSync(join(tmpdir(), "clanker-recipe-none-"));
    const flows = createFlows({
      store,
      defs,
      agents: createAgents({ store, defs, runtime: createFakeRuntime({ fixtures, speed: Infinity }) }),
      artifacts,
      roles: () => undefined,
    });
    flows.registerAction(recipes.checkAction);
    flows.save(
      FlowDef.parse({
        schema: 1,
        id: "checks",
        name: "Checks",
        trigger: { type: "manual" },
        params: { ws: "Workspace" },
        start: "checks",
        nodes: { checks: { type: "action", action: "recipe.check", args: { ws: "$run.params.ws", scope: "all" }, on: { ok: "@done", fail: "@failed" } } },
      }),
    );
    const { workspaceId, path, branch, baseSha, fencingToken } = lease!;
    const runId = flows.start("checks", { type: "issue", id: "CLA-38" }, { ws: { workspaceId, path, branch, baseSha, fencingToken } });
    await new Promise<void>((resolve) => {
      const filter = { runId, types: ["run.parked" as const] };
      if (store.events.since(0, filter).length > 0) return resolve();
      const off = store.events.subscribe(() => {
        off();
        resolve();
      }, filter);
    });
    await flows.close();
    rmSync(fixtures, { recursive: true, force: true });

    expect(flows.getRun(runId).steps).toMatchObject([{ status: "failed", outcome: "error", attempt: 1, error: expect.stringMatching(/no tiene slot/) }]);
    expect(store.events.since(0, { runId, types: ["step.retrying"] })).toEqual([]);
  });

  test("scope changed: {{files}} son los archivos de la issue y sin ninguno el check se salta", async () => {
    await worktree({}, { version: 1, commands: { lint: "echo lint {{files}}", types: "echo types" }, checks: ["lint", "types"] });

    const clean = await check();
    expect((clean.output as { checks: unknown[] }).checks).toEqual([{ name: "lint", skipped: true }, expect.objectContaining({ name: "types", ok: true })]);

    // Commiteado, sin commitear, nuevo y borrado: el borrado no se pasa al comando.
    write("app/committed.rb", "1\n");
    await workspaces.git(lease!, "add", "--all");
    await workspaces.git(lease!, "commit", "-m", "wip");
    write("app/a.rb", "2\n");
    write("app/new.rb", "3\n");
    rmSync(join(lease!.path, "app/gone.rb"));

    const dirty = await check();
    const { checks } = dirty.output as { checks: { artifact: string }[] };
    expect(artifactText(checks[0]!.artifact)).toBe("lint app/a.rb app/committed.rb app/new.rb");
  });

  test("scope all: {{files}} queda vacío y el check corre igual", async () => {
    await worktree({}, { version: 1, commands: { lint: "echo lint:{{files}}:" }, checks: ["lint"] });

    const result = await check("all");

    const { checks } = result.output as { checks: { artifact: string }[] };
    expect(artifactText(checks[0]!.artifact)).toBe("lint::");
  });

  test("specsChanged lista los archivos de pruebas que cambió la issue", async () => {
    await worktree({}, { version: 1 });
    for (const path of ["app/a.rb", "spec/models/a_spec.rb", "src/x.test.ts", "tests/y.py", "lib/contest.rb", "docs/inspect.md"]) write(path, "x\n");

    const result = await check();

    expect((result.output as { specsChanged: string[] }).specsChanged).toEqual(["spec/models/a_spec.rb", "src/x.test.ts", "tests/y.py"]);
  });

  test("un repo sin receta funciona sin slots ni wrap: no corre nada y da ok", async () => {
    await worktree();
    write("app/a.rb", "x\n");

    const result = await check();

    expect(result).toEqual({ outcome: "ok", output: { failures: "", specsChanged: [], checks: [] } });
    expect(existsSync(logPath())).toBe(false);
    // Y ws.exec no necesita receta.
    expect((await workspaces.exec(lease!, "echo hola", { runId, stepId })).extract).toBe("hola");
  });

  test("un reintento no repite los checks que ya terminaron (once)", async () => {
    await worktree({}, { version: 1, commands: { a: "echo a >> ran", b: "exit 7" }, checks: ["a", "b"] });
    const stages = new Map<string, unknown>();
    const once: ActionCtx["once"] = async (stage, fn) => {
      if (!stages.has(stage)) stages.set(stage, await fn());
      return stages.get(stage) as never;
    };
    const { workspaceId, path, branch, baseSha, fencingToken } = lease!;
    const args = { ws: { workspaceId, path, branch, baseSha, fencingToken }, scope: "all" as const };

    await recipes.checkAction.run(args, { ...ctx(), once });
    await recipes.checkAction.run(args, { ...ctx(), once });

    expect(readFileSync(join(lease!.path, "ran"), "utf8")).toBe("a\n");
  });
});

describe("recipe.check con el runtime fake", () => {
  const fixtures = (() => {
    const dir = mkdtempSync(join(tmpdir(), "clanker-recipe-fixtures-"));
    const script = (round: number, test: string) =>
      [
        `match: { mode: implement, round: ${round} }`,
        "run:",
        "  test:",
        `    - ${test}`,
        "result:",
        "  status: success",
        "  structured: { outcome: ok, summary: listo, payload: {} }",
        "",
      ].join("\n");
    writeFileSync(join(dir, "dev.r1.implement.yaml"), script(0, "{ ok: false, extract: extracts/test-r1.txt }"));
    writeFileSync(join(dir, "dev.r2.implement.yaml"), script(1, "{ ok: true }"));
    mkdirSync(join(dir, "extracts"));
    writeFileSync(join(dir, "extracts/test-r1.txt"), "FAIL spec/a_spec.rb\n  esperaba 1\n");
    return dir;
  })();

  afterAll(() => rmSync(fixtures, { recursive: true, force: true }));

  const role: Role = {
    prompt: "Eres dev.",
    context: [],
    modes: {
      implement: {
        instructions: "Implementa.",
        report: { type: "object", properties: { n: { type: "number" } } },
        outcomes: ["ok"],
        session: "new",
      },
    },
  };
  const profile: Profile = { roles: { dev: { model: "sonnet" } } };

  const flow = FlowDef.parse({
    schema: 1,
    id: "fake-check",
    name: "Fake check",
    trigger: { type: "manual" },
    params: { ws: "Workspace" },
    start: "implement",
    nodes: {
      implement: { type: "agent", role: "dev", mode: "implement", brief: {}, on: { ok: "checks" } },
      checks: {
        type: "action",
        action: "recipe.check",
        args: { ws: "$run.params.ws", scope: "all" },
        on: { ok: "@done", fail: { to: "implement", maxRounds: 1, exhausted: "@failed" } },
      },
    },
  });

  test("usa los run del guion de la sesión del agente: rojo con su extracto, y verde en la ronda siguiente", async () => {
    await worktree({}, { version: 1, commands: { test: "no se corre" }, checks: ["test"] });
    const defs = createDefs(store);
    const runtime = createFakeRuntime({ fixtures, speed: Infinity });
    const fakeRecipes = createRecipes({ store, defs, workspaces, artifacts, slots, fake: runtime });
    const flows = createFlows({
      store,
      defs,
      agents: createAgents({ store, defs, runtime }),
      artifacts,
      roles: () => ({ modes: { implement: { outcomes: ["ok"] } } }),
      workspaceOf: () => ({ path: lease!.path, base: "main" }),
    });
    defs.save({ kind: "role", slug: "dev", scope: "user", body: role, source: "ui" });
    defs.save({ kind: "profile", slug: "default", scope: "user", body: profile, source: "ui" });
    flows.registerAction(fakeRecipes.checkAction);
    flows.save(flow);

    const { workspaceId, path, branch, baseSha, fencingToken } = lease!;
    const started: RunId = flows.start("fake-check", { type: "issue", id: "CLA-38" }, { ws: { workspaceId, path, branch, baseSha, fencingToken } }, { profile: "default" });
    await new Promise<void>((resolve) => {
      const filter = { runId: started, types: ["run.finished" as const, "run.parked" as const] };
      if (store.events.since(0, filter).length > 0) return resolve();
      const off = store.events.subscribe(() => {
        off();
        resolve();
      }, filter);
    });

    const view = flows.getRun(started);
    expect(view.status).toBe("done");
    const checks = view.steps.filter((s) => s.nodeId === "checks");
    expect(checks.map((s) => s.outcome)).toEqual(["fail", "ok"]);
    const outputOf = (hash: string | null) => JSON.parse(artifactText(hash!));
    expect(outputOf(checks[0]!.outputHash)).toMatchObject({ failures: "[test] exit 1\nFAIL spec/a_spec.rb\n  esperaba 1" });
    expect(outputOf(checks[1]!.outputHash)).toMatchObject({ failures: "" });
    // El fake no corre nada: no hay log.
    expect(existsSync(join(dataDir, "logs", "runs", started))).toBe(false);

    await flows.close();
  });
});

describe("recipe.check con slots", () => {
  const pools = { dev: 2, maintenance: 1 };
  const setups = () => join(dataDir, "setups.log");
  const setupRuns = () => (existsSync(setups()) ? readFileSync(setups(), "utf8").trim().split("\n").length : 0);
  const recipeWith = (setup: Record<string, unknown> = {}) => ({
    version: 1,
    slots: pools,
    env: { DB: "db_{{slot}}" },
    setup: { slot: [`echo "slot {{slot}}" >> ${setups()}`], slotKey: ["db/structure.sql"], ...setup },
    commands: { env: "echo $DB" },
    checks: ["env"],
  });
  const slotRow = (idx: number) =>
    store.db.$client.prepare("SELECT holder_run_id AS holder, workspace_id AS workspaceId, dirty FROM slots WHERE idx = ?").get(idx) as {
      holder: string | null;
      workspaceId: string | null;
      dirty: number;
    };

  /** La corrida en la base, sin pasar por el motor: `recipe.check` solo mira su carril. */
  function seedRun(lane: "dev" | "maintenance") {
    const sqlite = store.db.$client;
    sqlite.exec("PRAGMA foreign_keys = OFF");
    sqlite
      .prepare(
        `INSERT INTO runs (id, subject_type, subject_id, flow_def_id, flow_version, roles, lane, status, writes, params, rounds, started_at)
         VALUES (?, 'issue', 'CLA-42', 'def_x', 1, '{}', ?, 'running', 1, '{}', '{}', 0)`,
      )
      .run(runId, lane);
    sqlite.exec("PRAGMA foreign_keys = ON");
  }

  const outputOf = (result: { output?: unknown }) => result.output as { failures: string; checks: { name: string; artifact: string }[] };

  test("toma un slot del pool del carril de la corrida, renderiza {{slot}} con él y lo suelta al terminar", async () => {
    await worktree({ "db/structure.sql": "v1\n" }, recipeWith());
    seedRun("maintenance");

    const result = await check();

    expect(result.outcome).toBe("ok");
    // Con dev: 2 y maintenance: 1, el pool de mantenimiento es el slot 3.
    expect(artifactText(outputOf(result).checks[0]!.artifact)).toBe("db_3");
    expect(slotRow(3)).toMatchObject({ holder: null, workspaceId: lease!.workspaceId, dirty: 0 });
    expect(slotRow(1)).toMatchObject({ holder: null, workspaceId: null });
  });

  test("lo suelta también cuando un check está rojo o el paso se cancela a medio comando", async () => {
    await worktree({}, { ...recipeWith(), commands: { env: "exit 1", slow: "sleep 30" } });
    seedRun("dev");
    expect((await check()).outcome).toBe("fail");
    expect(slotRow(1).holder).toBeNull();

    write(".clanker/recipe.json", JSON.stringify({ ...recipeWith(), commands: { slow: "sleep 30" }, checks: ["slow"] }));
    const controller = new AbortController();
    const running = recipes.checkAction.run({ ws: lease!, scope: "all" }, ctx(controller.signal));
    await vi.waitFor(() => expect(slotRow(1).holder).toBe(runId));

    controller.abort(new Error("cancelada"));

    await expect(running).rejects.toThrow("cancelada");
    expect(slotRow(1).holder).toBeNull();
  });

  test("el pool dev lleno no impide el check de una corrida de mantenimiento", async () => {
    await worktree({}, recipeWith());
    seedRun("maintenance");
    slots.tryAcquire({ repoId: "r1", lane: "dev", runId: newId("run"), pools });
    slots.tryAcquire({ repoId: "r1", lane: "dev", runId: newId("run"), pools });

    const result = await check();

    expect(result.outcome).toBe("ok");
    expect(artifactText(outputOf(result).checks[0]!.artifact)).toBe("db_3");
  });

  test("cambiar un archivo de slotKey dispara setup.slot, y sin cambios no se repite", async () => {
    await worktree({ "db/structure.sql": "v1\n" }, recipeWith());
    seedRun("dev");

    await check();
    expect(setupRuns()).toBe(1);
    await check();
    expect(setupRuns()).toBe(1);

    write("db/structure.sql", "v2\n");
    await check();
    expect(setupRuns()).toBe(2);
    expect(readFileSync(setups(), "utf8")).toBe("slot 1\nslot 1\n");
    // Borrar el archivo también cambia el hash.
    rmSync(join(lease!.path, "db/structure.sql"));
    await check();
    expect(setupRuns()).toBe(3);
  });

  test("un slot que preparó otro worktree se prepara de nuevo", async () => {
    await worktree({ "db/structure.sql": "v1\n" }, recipeWith());
    seedRun("dev");
    await check();
    store.db.$client.prepare("UPDATE slots SET workspace_id = 'ws_otro' WHERE idx = 1").run();

    await check();

    expect(setupRuns()).toBe(2);
    expect(slotRow(1).workspaceId).toBe(lease!.workspaceId);
  });

  test("un guard que no calza aborta sin correr setup.slot ni ensuciar el slot", async () => {
    await worktree({}, recipeWith({ guard: { run: "printf otra_db", expect: "db_{{slot}}" } }));
    seedRun("dev");

    const error = await check().catch((e: unknown) => e);

    expect(error).toBeInstanceOf(PermanentActionError);
    expect((error as Error).message).toBe('setup.guard no calza en el slot 1: se esperaba "db_1" y salió "otra_db". No se corrió setup.slot ni se borró nada.');
    expect(setupRuns()).toBe(0);
    expect(slotRow(1)).toMatchObject({ holder: null, dirty: 0, workspaceId: null });
  });

  test("un guard que calza deja correr setup.slot, con el entorno del slot", async () => {
    await worktree({}, recipeWith({ guard: { run: 'printf "$DB"', expect: "db_{{slot}}" } }));
    seedRun("dev");

    expect((await check()).outcome).toBe("ok");
    expect(setupRuns()).toBe(1);
  });

  test("un setup.slot rojo da fail con su extracto, no corre los checks y deja el slot sucio hasta que se arregla", async () => {
    await worktree({ "db/structure.sql": "roto\n" }, recipeWith({ slot: ["echo cargando", "echo 'syntax error' >&2; exit 3"] }));
    seedRun("dev");

    const result = await check();

    expect(result.outcome).toBe("fail");
    expect(outputOf(result)).toMatchObject({ failures: "[setup.slot] echo 'syntax error' >&2; exit 3 exit 3\nsyntax error", checks: [] });
    expect(slotRow(1)).toMatchObject({ holder: null, dirty: 1 });

    write(".clanker/recipe.json", JSON.stringify(recipeWith()));
    expect((await check()).outcome).toBe("ok");
    expect(slotRow(1)).toMatchObject({ dirty: 0, workspaceId: lease!.workspaceId });
  });

  test("con slot explícito no usa los pools ni corre el setup", async () => {
    await worktree({}, recipeWith());

    const result = await check("changed", 7);

    expect(artifactText(outputOf(result).checks[0]!.artifact)).toBe("db_7");
    expect(setupRuns()).toBe(0);
    expect(store.db.$client.prepare("SELECT count(*) AS n FROM slots").get()).toEqual({ n: 0 });
  });

  test("una receta sin slots no toma ninguno", async () => {
    await worktree({}, { version: 1, commands: { t: "true" }, checks: ["t"] });

    expect((await check()).outcome).toBe("ok");
    expect(store.db.$client.prepare("SELECT count(*) AS n FROM slots").get()).toEqual({ n: 0 });
  });

  test("sin su corrida en la base no se sabe el carril: error permanente", async () => {
    await worktree({}, recipeWith());

    await expect(check()).rejects.toBeInstanceOf(PermanentActionError);
  });
});

describe("recipe.check con requires", () => {
  const withRequires = (requires: Array<{ name: string; check: string }>) => ({
    version: 1,
    requires,
    commands: { t: "touch checked && true" },
    checks: ["t"],
  });

  test("un servicio caído es un error de entorno del repo, no un check rojo, y no corre los checks", async () => {
    await worktree({}, withRequires([{ name: "Postgres", check: "exit 2" }, { name: "Redis", check: "true" }, { name: "Doppler", check: "exit 1" }]));

    const error = await check().catch((e: unknown) => e);

    expect(error).toBeInstanceOf(EnvironmentError);
    expect((error as EnvironmentError).scope).toBe(repoScope("r1"));
    expect((error as Error).message).toBe("Al repo le falta su entorno, no responde: Postgres, Doppler.");
    expect(existsSync(join(lease!.path, "checked"))).toBe(false);
  });

  test("con el runtime fake los requires también se prueban: son el entorno real del repo, no un check guionado", async () => {
    await worktree({}, withRequires([{ name: "Postgres", check: "exit 2" }]));
    const fakeRecipes = createRecipes({ store, defs: createDefs(store), workspaces, artifacts, slots, fake: createFakeRuntime({ fixtures: [], speed: Infinity }) });
    const { workspaceId, path, branch, baseSha, fencingToken } = lease!;

    const error = await fakeRecipes.checkAction.run({ ws: { workspaceId, path, branch, baseSha, fencingToken }, scope: "changed" }, ctx()).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(EnvironmentError);
    expect((error as Error).message).toBe("Al repo le falta su entorno, no responde: Postgres.");
  });

  test("con todos los requires arriba corre los checks", async () => {
    await worktree({}, withRequires([{ name: "Postgres", check: "true" }]));

    expect((await check()).outcome).toBe("ok");
    expect(existsSync(join(lease!.path, "checked"))).toBe(true);
  });
});

import { resolve } from "node:path";
import { CachedIssue, type Client, ClankerProject, type Event, type RunDetail } from "@clanker/api";
import { describe, expect, test } from "vitest";
import { type CliContext, runCli } from "./cli";

const projectId = "prj_00000000000000000000000001" as const;
const issueId = "iss_00000000000000000000000001" as const;
const runId = "run_00000000000000000000000001" as const;

const project = ClankerProject.parse({
  id: projectId,
  slug: "demo",
  name: "Demo",
  tracker: "local",
  trackerRef: projectId,
  trackerAccount: null,
  defaultFlowId: "juguete",
  defaultProfileId: null,
  repos: [],
  queueFilter: {},
  conventions: {},
  parallel: 2,
  stackOn: "ci_green",
  statusMapping: {},
  status: "active",
  flowParams: {},
  maxCostUsd: null,
});
const issue = CachedIssue.parse({
  id: issueId,
  projectId,
  ref: { tracker: "local", id: "1", key: "DEMO-1", url: "https://example.com/DEMO-1" },
  project: projectId,
  title: "Saluda al mundo",
  body: "",
  status: "todo",
  rawStatus: "todo",
  priority: 0,
  labels: [],
  relations: { blocks: [], blockedBy: [], related: [] },
  updatedAt: 0,
});
const run: RunDetail = {
  id: runId,
  projectId,
  parentRunId: null,
  borrowedFromRunId: null,
  flow: { slug: "juguete", version: 1 },
  subject: { type: "issue", id: issueId },
  lane: "dev",
  status: "parked",
  parkReason: "needs_human",
  outcome: null,
  params: {},
  rounds: {},
  costMicros: 1_234_000,
  startedAt: Date.UTC(2026, 10, 15, 12, 0, 0),
  endedAt: null,
  flowDef: { schema: 1, id: "juguete", name: "Juguete", trigger: { type: "manual" }, start: "dev", nodes: { dev: { type: "agent", role: "dev", mode: "plan", brief: {}, on: { ok: "@done" } } } },
  workspace: null,
  usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  steps: [
    { id: "stp_00000000000000000000000001", nodeId: "dev", visit: 1, round: 0, attempt: 0, status: "done", outcome: "ok", outputHash: null, error: null, notBefore: null, costMicros: 1_000_000, startedAt: null, endedAt: null },
    { id: "stp_00000000000000000000000002", nodeId: "review", visit: 1, round: 0, attempt: 1, status: "failed", outcome: null, outputHash: null, error: "se cayó el runtime", notBefore: null, costMicros: 234_000, startedAt: null, endedAt: null },
  ],
};

const event = (seq: number, overrides: Partial<Event> = {}): Event => ({ seq, ts: Date.UTC(2026, 10, 15, 12, 0, seq), type: "run.status", origin: "core", payload: {}, ...overrides });

/** Corre un comando contra un cliente de mentira: devuelve lo impreso y lo que le pidió al cliente. */
async function exec(argv: string[], client: Record<string, unknown>, signal = new AbortController().signal) {
  const out: string[] = [];
  const ctx: CliContext = {
    client: () => Promise.resolve(client as Client),
    mcpEndpoint: () => Promise.reject(new Error("este test no usa el MCP")),
    write: (line) => out.push(line),
    readFile: () => "",
    signal,
  };
  await runCli(argv, ctx);
  return out.join("\n");
}

const projects = { list: () => Promise.resolve([project]) };

describe("clanker", () => {
  test("sin comando o con --help lista los comandos", async () => {
    const out = await exec([], {});

    expect(out).toContain("clanker runs start <proyecto> <issue>");
    expect(out).toContain("clanker events tail");
    expect(out).toContain("clanker metrics compare");
    await expect(exec(["--help"], {})).resolves.toBe(out);
  });

  test("un comando desconocido o un flag mal puesto fallan con el uso, sin tocar el core", async () => {
    await expect(exec(["constructor"], {})).rejects.toThrow(/Comando desconocido: clanker constructor\nUso:/);
    await expect(exec(["runs", "stop"], {})).rejects.toThrow(/Comando desconocido: clanker runs stop/);
    await expect(exec(["projects", "list", "--nope"], {})).rejects.toThrow(/Unknown option '--nope'\.\nUso: clanker projects list/);
  });
});

describe("clanker status", () => {
  const client = {
    system: {
      health: () => Promise.resolve({ coreVersion: "1.2.3", apiMajor: 1, schemaVersion: 7, bootId: "b", activeRuns: 2 }),
      info: () => Promise.resolve({ pid: 4242, startedAt: 0, dataDir: "/datos", platform: "darwin" }),
    },
  };

  test("dice versión, pid, carpeta de datos y corridas activas", async () => {
    expect(await exec(["status"], client)).toBe(
      "Core 1.2.3 corriendo (pid 4242, api 1, esquema 7)\nDatos: /datos\nCorridas activas: 2",
    );
  });

  test("--json junta health e info", async () => {
    expect(JSON.parse(await exec(["status", "--json"], client))).toMatchObject({ coreVersion: "1.2.3", pid: 4242, activeRuns: 2 });
  });
});

describe("clanker projects list", () => {
  test("imprime una tabla, o --json", async () => {
    const client = { projects };

    expect(await exec(["projects", "list"], client)).toBe(
      ["Slug  Nombre  Tracker  Estado  Flujo    Cupo", "demo  Demo    local    active  juguete  2"].join("\n"),
    );
    expect(JSON.parse(await exec(["projects", "list", "--json"], client))).toEqual([project]);
  });

  test("sin proyectos lo dice", async () => {
    expect(await exec(["projects", "list"], { projects: { list: () => Promise.resolve([]) } })).toBe("No hay proyectos.");
  });
});

describe("clanker runs", () => {
  function fakeRuns() {
    const starts: unknown[] = [];
    const client = {
      projects,
      issues: { list: () => Promise.resolve([issue]) },
      runs: {
        start: (input: unknown) => (starts.push(input), Promise.resolve(run)),
        get: ({ id }: { id: string }) => (id === runId ? Promise.resolve(run) : Promise.reject(new Error("NOT_FOUND"))),
      },
    };
    return { client, starts };
  }

  test("start resuelve el proyecto por slug y la issue por key (sin distinguir mayúsculas) y lanza la corrida", async () => {
    const { client, starts } = fakeRuns();

    const out = await exec(["runs", "start", "demo", "demo-1", "--flow", "otro"], client);

    expect(starts).toEqual([{ projectId, issueId, flow: "otro" }]);
    expect(out).toContain(`Corrida:  ${runId}`);
    expect(out).toContain(`Sigue el progreso con: clanker events tail --run ${runId} --follow`);
  });

  test("start también acepta el id de la issue y --json imprime la corrida", async () => {
    const { client } = fakeRuns();

    const out = await exec(["runs", "start", "demo", issueId, "--json"], client);

    expect(JSON.parse(out)).toMatchObject({ id: runId, status: "parked" });
  });

  test("start falla con un mensaje claro si falta algo o no existe el proyecto o la issue", async () => {
    const { client } = fakeRuns();

    await expect(exec(["runs", "start", "demo"], client)).rejects.toThrow(/Faltan el proyecto y la issue/);
    await expect(exec(["runs", "start", "nope", "DEMO-1"], client)).rejects.toThrow('No existe el proyecto "nope"');
    await expect(exec(["runs", "start", "demo", "DEMO-9"], client)).rejects.toThrow('No existe la issue "DEMO-9" en el proyecto "demo"');
  });

  test("get imprime la corrida con sus pasos y el error del que falló", async () => {
    const { client } = fakeRuns();

    expect(await exec(["runs", "get", runId], client)).toBe(
      [
        `Corrida:  ${runId}`,
        "Flujo:    juguete@1",
        `Sujeto:   issue ${issueId}`,
        "Carril:   dev",
        "Estado:   parked (needs_human)",
        "Costo:    $1.23",
        "Inicio:   2026-11-15T12:00:00Z",
        "",
        "Paso    Visita  Estado  Outcome  Costo",
        "dev     1       done    ok       $1.00",
        "review  1       failed  -        $0.23",
        "Error en review (visita 1): se cayó el runtime",
      ].join("\n"),
    );
  });

  test("get rechaza un id que no es de corrida sin llamar al core", async () => {
    await expect(exec(["runs", "get", "run_1"], {})).rejects.toThrow('"run_1" no es un id de corrida');
    await expect(exec(["runs", "get"], {})).rejects.toThrow(/Falta el id de la corrida/);
  });
});

describe("clanker events tail", () => {
  /** Un core con `total` eventos; `list` pagina como el real (por `seq` y `limit`) y `stream` entrega `live`. */
  function fakeEvents(total: number, live: Event[] = []) {
    const lists: unknown[] = [];
    const streams: unknown[] = [];
    const client = {
      projects,
      events: {
        list: ({ after, limit, filter }: { after: number; limit: number; filter: unknown }) => {
          lists.push({ after, limit, filter });
          const seqs = Array.from({ length: Math.min(limit, Math.max(0, total - after)) }, (_, i) => after + i + 1);
          return Promise.resolve(seqs.map((seq) => event(seq)));
        },
        stream: async (input: unknown, { signal }: { signal: AbortSignal }) => {
          streams.push(input);
          return (async function* () {
            yield* live;
            await new Promise((_, reject) => {
              const abort = () => reject(new DOMException("abortado", "AbortError"));
              if (signal.aborted) abort();
              else signal.addEventListener("abort", abort);
            });
          })();
        },
      },
    };
    return { client, lists, streams };
  }

  test("imprime los últimos 20 eventos recorriendo todas las páginas", async () => {
    const { client, lists } = fakeEvents(1_201);

    const out = (await exec(["events", "tail"], client)).split("\n");

    expect(out).toHaveLength(20);
    expect(out[0]).toBe("2026-11-15T12:19:42Z #1182 run.status           core");
    expect(out.at(-1)).toContain("#1201");
    expect(lists.map((l) => (l as { after: number }).after)).toEqual([0, 500, 1_000]);
  });

  test("-n elige cuántos, y un filtro por corrida, proyecto y tipo llega a la API", async () => {
    const { client, lists } = fakeEvents(5);

    const out = await exec(["events", "tail", "-n", "2", "--run", runId, "--project", "demo", "--type", "run.finished", "--type", "run.parked"], client);

    expect(out.split("\n").map((l) => l.match(/#\d+/)?.[0])).toEqual(["#4", "#5"]);
    expect(lists[0]).toMatchObject({ filter: { runId, projectId, types: ["run.finished", "run.parked"] } });
  });

  test("muestra el run y el payload del evento, y --json imprime una línea JSON por evento", async () => {
    const client = { events: { list: (): Promise<Event[]> => Promise.resolve([event(7, { type: "run.finished", runId, payload: { outcome: "done" } })]) } };

    expect(await exec(["events", "tail"], client)).toBe(`2026-11-15T12:00:07Z #7 run.finished         core   ${runId} {"outcome":"done"}`);
    expect(JSON.parse(await exec(["events", "tail", "--json"], client))).toMatchObject({ seq: 7, runId });
  });

  test("--follow sigue desde el último seq hasta Ctrl+C sin fallar", async () => {
    const { client, streams } = fakeEvents(3, [event(4), event(5)]);
    const interrupt = new AbortController();
    const out: string[] = [];
    const done = runCli(["events", "tail", "-n", "1", "-f"], {
      client: () => Promise.resolve(client as Client),
      mcpEndpoint: () => Promise.reject(new Error("este test no usa el MCP")),
      write: (line) => {
        out.push(line);
        if (out.length === 3) interrupt.abort();
      },
      readFile: () => "",
      signal: interrupt.signal,
    });

    await done;

    expect(out.map((l) => l.match(/#\d+/)?.[0])).toEqual(["#3", "#4", "#5"]);
    expect(streams).toEqual([{ after: 3, filter: {} }]);
  });

  test("rechaza un -n, un run o un tipo inválidos sin llamar al core", async () => {
    await expect(exec(["events", "tail", "-n", "x"], {})).rejects.toThrow('-n debe ser un entero desde 0, no "x"');
    await expect(exec(["events", "tail", "--run", "nope"], {})).rejects.toThrow('"nope" no es un id de corrida');
    await expect(exec(["events", "tail", "--type", "run.nope"], {})).rejects.toThrow('Tipo de evento desconocido "run.nope"');
  });
});

describe("clanker import legacy", () => {
  const result = { dryRun: false, created: { projects: 2, issues: 7, pullRequests: 5, runs: 9, runRoleCosts: 23, learnings: 5, decisions: 9, artifacts: 12, profiles: 2, modelPrices: 1 }, unresolvedRepos: ["infra"] };
  const clientFor = (reply: unknown) => {
    const calls: unknown[] = [];
    return { calls, imports: { legacy: (input: unknown) => (calls.push(input), Promise.resolve(reply)) } };
  };

  test("pide la importación con la ruta absoluta y cuenta lo que creó y los repos que faltan", async () => {
    const client = clientFor(result);

    const out = await exec(["import", "legacy", "--from", "datos/clanker-loop"], client);

    expect(client.calls).toEqual([{ from: resolve("datos/clanker-loop"), dryRun: false }]);
    expect(out).toBe(
      [
        "Importado:",
        "proyectos                     2",
        "issues                        7",
        "PRs                           5",
        "corridas (con sus métricas)   9",
        "costos por rol               23",
        "learnings propuestos          5",
        "decisiones y notas            9",
        "artefactos                   12",
        "perfiles                      2",
        "precios de modelos            1",
        "Repos sin registrar (sus PRs quedaron fuera): infra.",
        "Regístralos en Clanker Yard y repite el comando: solo agrega lo que falte.",
      ].join("\n"),
    );
  });

  test("--dry-run se lo pasa al core y lo dice en la salida; --json imprime el resultado", async () => {
    const client = clientFor({ ...result, dryRun: true, unresolvedRepos: [] });

    const out = await exec(["import", "legacy", "--from", "/x", "--dry-run"], client);
    const json = await exec(["import", "legacy", "--from", "/x", "--dry-run", "--json"], client);

    expect(client.calls).toEqual([
      { from: "/x", dryRun: true },
      { from: "/x", dryRun: true },
    ]);
    expect(out.split("\n")[0]).toBe("Simulación: no se escribió nada. Una importación real crearía:");
    expect(out).not.toContain("Repos sin registrar");
    expect(JSON.parse(json)).toMatchObject({ dryRun: true, created: { runs: 9 } });
  });

  test("sin --from falla con el uso, sin tocar el core", async () => {
    await expect(exec(["import", "legacy"], {})).rejects.toThrow(/Falta --from\. Uso: clanker import legacy/);
  });
});

import { resolve } from "node:path";
import { CachedIssue, type CachedPr, type Client, ClankerProject, type Event, type LocalCommitDiff, type LocalPrDetail, type RunDetail } from "@clanker/api";
import { describe, expect, test, vi } from "vitest";
import type { CliContext } from "./command";
import { runCli } from "./cli";

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
  stackMode: "remote",
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
async function exec(argv: string[], client: Record<string, unknown>, overrides?: Partial<Pick<CliContext, "client" | "readFile" | "signal">>) {
  const out: string[] = [];
  const ctx: CliContext = {
    client: () => Promise.resolve(client as Client),
    mcpEndpoint: () => Promise.reject(new Error("este test no usa el MCP")),
    write: (line) => out.push(line),
    readFile: () => "",
    sleep: () => Promise.resolve(),
    signal: new AbortController().signal,
    ...overrides,
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
    expect(out).toContain("clanker prs list-local");
    expect(out).toContain("clanker prs show-local");
    expect(out).toContain("clanker prs edit-local");
    expect(out).toContain("clanker prs apply-local");
    expect(out).toContain("clanker prs publish-local");
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
      sleep: () => Promise.resolve(),
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

describe("clanker prs republish", () => {
  const finals = [
    { repo: "r1", number: 4299, status: "planned", branch: "eng-1-uno", base: "main", commits: 3 },
    { repo: "r1", number: 4300, status: "republished", branch: "eng-2-dos", base: "eng-1-uno", newNumber: 4350, commits: 2 },
    { repo: "r1", number: 4301, status: "skipped", reason: "la corrida run_1 sigue viva" },
  ];
  /** El core lanza y vuelve: el primer avance trae a 4300 sin terminar y cada `republishProgress` mueve un paso. */
  const clientFor = (steps: unknown[][] = [finals]) => {
    const calls: unknown[] = [];
    const polls: unknown[] = [];
    const next = [...steps];
    const progress = () => {
      const results = next.shift() ?? finals;
      return { id: "rep_1", done: next.length === 0, results };
    };
    return {
      calls,
      polls,
      projects: { list: () => Promise.resolve([{ id: "prj_1", slug: "api" }]) },
      prs: {
        republish: (input: unknown) => (calls.push(input), Promise.resolve(progress())),
        republishProgress: (input: unknown) => (polls.push(input), Promise.resolve(progress())),
      },
    };
  };

  test("--project, --pr (repetible) y --dry-run se los pasa al core y lista viejo → nuevo por PR", async () => {
    const client = clientFor();

    const out = await exec(["prs", "republish", "--project", "api", "--pr", "4299", "--pr", "4300", "--drafts", "--dry-run"], client);

    expect(client.calls).toEqual([{ projectId: "prj_1", prs: [4299, 4300], dryRun: true, draftOnly: true }]);
    expect(client.polls).toEqual([]);
    expect(out).toBe(
      [
        "planned r1#4299 → eng-1-uno, base main, 3 commits",
        "republished r1#4300 → eng-2-dos (#4350), base eng-1-uno, 2 commits",
        "skipped r1#4301 (la corrida run_1 sigue viva)",
      ].join("\n"),
    );
  });

  test("consulta el avance hasta que termina e imprime cada PR en cuanto tiene resultado, sin repetirlo", async () => {
    const running = { repo: "r1", number: 4300, status: "running", branch: "eng-2-dos", base: "eng-1-uno", newNumber: 4350 };
    const client = clientFor([
      [{ ...finals[0]!, status: "republished", newNumber: 4349 }, { repo: "r1", number: 4300, status: "pending" }],
      [{ ...finals[0]!, status: "republished", newNumber: 4349 }, running],
      [{ ...finals[0]!, status: "republished", newNumber: 4349 }, finals[1]!],
    ]);

    const out = await exec(["prs", "republish"], client);

    expect(client.polls).toEqual([{ id: "rep_1" }, { id: "rep_1" }]);
    expect(out).toBe(
      [
        "republished r1#4299 → eng-1-uno (#4349), base main, 3 commits",
        "republished r1#4300 → eng-2-dos (#4350), base eng-1-uno, 2 commits",
      ].join("\n"),
    );
  });

  test("--json imprime los resultados finales una sola vez y Ctrl+C corta la espera con un mensaje", async () => {
    const client = clientFor([[{ repo: "r1", number: 1, status: "pending" }], finals]);
    expect(JSON.parse(await exec(["prs", "republish", "--json"], client))).toEqual(finals);

    const interrupted = new AbortController();
    interrupted.abort();
    const stuck = clientFor([[{ repo: "r1", number: 1, status: "pending" }], [{ repo: "r1", number: 1, status: "pending" }]]);
    await expect(exec(["prs", "republish"], stuck, { signal: interrupted.signal })).rejects.toThrow(/Interrumpido/);
  });

  test("sin opciones rehace todo y un --pr que no es número falla con el uso, sin tocar el core", async () => {
    const client = clientFor();
    await exec(["prs", "republish"], client);
    expect(client.calls).toEqual([{ projectId: undefined, prs: [], dryRun: false, draftOnly: false }]);

    await expect(exec(["prs", "republish", "--pr", "abc"], client)).rejects.toThrow(/--pr pide un número de PR, no "abc"\.\nUso: clanker prs republish/);
    expect(client.calls).toHaveLength(1);
  });
});

describe("clanker prs locales", () => {
  const id = "pr_00000000000000000000000001";
  const decisionId = "dec_00000000000000000000000001";
  const head = "a".repeat(40);
  const repo = "octocat/demo";
  const patch = "diff --git a/README.md b/README.md\n+hola\n";
  const local = { branch: "rama-hija", base: "rama-padre", title: "Saluda al mundo" };
  const cached: CachedPr = {
    id, repo, ref: null, local, owned: true, issueId, runId, parents: [], signals: [], reviewBot: false, state: null, readAt: null,
  };
  const detail: LocalPrDetail = {
    id, repo, ...local, baseSha: "b".repeat(40), head, body: "Primera línea\n\nSegunda línea",
    commits: [{ sha: head, subject: "feat: agrega saludo", body: "", author: "Octocat", date: "2026-11-15T12:00:00Z" }],
    files: [{ path: "README.md", additions: 1, deletions: 0 }],
    patch, truncated: false,
  };

  test("list-local pide solo PRs locales, filtra por repo y muestra una tabla o JSON", async () => {
    const list = vi.fn().mockResolvedValue([cached]);
    const client = { prs: { list } };

    const out = await exec(["prs", "list-local", "--repo", repo], client);

    expect(list).toHaveBeenCalledExactlyOnceWith({ state: "local", repo });
    expect(out).toContain("Título");
    for (const value of [id, repo, local.branch, local.base, local.title]) expect(out).toContain(value);
    expect(JSON.parse(await exec(["prs", "list-local", "--json"], client))).toEqual([cached]);
    expect(list).toHaveBeenLastCalledWith({ state: "local", repo: undefined });

    list.mockResolvedValueOnce([]);
    await expect(exec(["prs", "list-local"], client)).resolves.toBe("No hay PRs locales.");
  });

  test("show-local muestra título, descripción, commits, archivos y patch (o el detalle JSON)", async () => {
    const localDetail = vi.fn().mockResolvedValue(detail);
    const client = { prs: { localDetail } };

    const out = await exec(["prs", "show-local", id], client);

    expect(localDetail).toHaveBeenCalledExactlyOnceWith({ id });
    for (const text of [local.title, detail.body, head, "feat: agrega saludo", "README.md", "+1", patch]) expect(out).toContain(text);
    expect(JSON.parse(await exec(["prs", "show-local", id, "--json"], client))).toEqual(detail);
  });

  test("show-local --commit pide el diff de ese commit y avisa si se truncó", async () => {
    const diff: LocalCommitDiff = { sha: head, files: detail.files, patch, truncated: true };
    const localCommitDiff = vi.fn().mockResolvedValue(diff);
    const client = { prs: { localCommitDiff } };
    const sha = head.slice(0, 7);
    const args = ["prs", "show-local", id, "--commit", sha];

    const out = await exec(args, client);

    expect(localCommitDiff).toHaveBeenCalledExactlyOnceWith({ id, sha });
    for (const text of [head, "README.md", patch, "Patch truncado"]) expect(out).toContain(text);
    expect(JSON.parse(await exec([...args, "--json"], client))).toEqual(diff);
  });

  test("edit-local envía solo los campos pedidos; un archivo vacío borra la descripción", async () => {
    const updateLocal = vi.fn().mockResolvedValue({ id, title: "Título nuevo", body: "" });
    const client = { prs: { updateLocal } };
    const readFile = vi.fn().mockReturnValueOnce("").mockReturnValueOnce(detail.body);
    const args = ["prs", "edit-local", id];

    const out = await exec([...args, "--title", "Título nuevo"], client, { readFile });
    expect(updateLocal).toHaveBeenNthCalledWith(1, { id, title: "Título nuevo" });
    expect(readFile).not.toHaveBeenCalled();
    expect(out).toContain(`PR local ${id} actualizado: Título nuevo`);

    await exec([...args, "--body-file", "vacio.md"], client, { readFile });
    expect(readFile).toHaveBeenCalledExactlyOnceWith("vacio.md");
    expect(updateLocal).toHaveBeenNthCalledWith(2, { id, body: "" });

    await exec([...args, "--title", "Título nuevo", "--body-file", "cuerpo.md"], client, { readFile });
    expect(updateLocal).toHaveBeenNthCalledWith(3, { id, title: "Título nuevo", body: detail.body });
  });

  test("apply-local encola el contenido del patch con el HEAD esperado, sin push", async () => {
    const applyLocalPatch = vi.fn().mockResolvedValue({ runId });
    const readFile = vi.fn().mockReturnValue(patch);

    const out = await exec(["prs", "apply-local", id, "--head", head, "--patch", "cambio.diff"], { prs: { applyLocalPatch } }, { readFile });

    expect(readFile).toHaveBeenCalledExactlyOnceWith("cambio.diff");
    expect(applyLocalPatch).toHaveBeenCalledExactlyOnceWith({ id, head, patch });
    expect(out).toContain(`sin hacer push: ${runId}`);
    expect(out).toContain(`clanker events tail --run ${runId} --follow`);
  });

  test("publish-local solo solicita la publicación y manda a Bandeja con el id de decisión", async () => {
    const requestLocalPublish = vi.fn().mockResolvedValue({ decisionId });
    const publishLocal = vi.fn();

    const out = await exec(["prs", "publish-local", id], { prs: { requestLocalPublish, publishLocal } });

    expect(requestLocalPublish).toHaveBeenCalledExactlyOnceWith({ id });
    expect(publishLocal).not.toHaveBeenCalled();
    for (const text of [decisionId, "aún no se publicó", "Clanker Yard > Bandeja"]) expect(out).toContain(text);
  });

  test.each([
    [["list-local", "--repo", "demo"], "--repo pide"],
    [["show-local"], "Indica un solo id"],
    [["show-local", id, "--commit", "main"], "--commit pide un SHA"],
    [["edit-local", id], "Indica --title o --body-file"],
    [["edit-local", id, "--title", ""], "--title pide un título no vacío"],
    [["edit-local", id, "--title", "Dos\nlíneas"], "--title pide un título no vacío"],
    [["edit-local", id, "--body-file", ""], "--body-file pide la ruta"],
    [["apply-local", id, "--patch", "cambio.diff"], "--head pide el SHA completo"],
    [["apply-local", id, "--head", head.slice(0, 7), "--patch", "cambio.diff"], "--head pide el SHA completo"],
    [["apply-local", id, "--head", head], "Falta --patch"],
    [["apply-local", id, "--head", head, "--patch", "vacio.diff"], "El archivo de --patch está vacío"],
    [["publish-local", id, "otro"], "Indica un solo id"],
  ])("valida %j antes de arrancar el core", async (args, message) => {
    const client = vi.fn();
    await expect(exec(["prs", ...args], {}, { client })).rejects.toThrow(message);
    expect(client).not.toHaveBeenCalled();
  });

  test("valida los archivos antes de arrancar el core", async () => {
    const client = vi.fn();
    const readFile = vi.fn().mockImplementationOnce(() => { throw new Error("ENOENT"); })
      .mockReturnValueOnce("x".repeat(65_537))
      .mockReturnValueOnce("x".repeat(2_000_001));
    const edit = ["prs", "edit-local", id, "--body-file", "cuerpo.md"];
    const apply = ["prs", "apply-local", id, "--head", head, "--patch", "cambio.diff"];

    await expect(exec(edit, {}, { client, readFile })).rejects.toThrow("ENOENT");
    await expect(exec(edit, {}, { client, readFile })).rejects.toThrow("excede el tamaño de descripción");
    await expect(exec(apply, {}, { client, readFile })).rejects.toThrow("excede el tamaño admitido");
    expect(client).not.toHaveBeenCalled();
  });
});

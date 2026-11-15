import { cpSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { FlowBody } from "@clanker/api";
import { eq } from "drizzle-orm";
import { afterEach, describe, expect, test } from "vitest";
import { createDefs } from "../defs/defs";
import { createMetrics } from "../metrics/metrics";
import { events, issues, projectRepos, projects, pullRequests, runMetrics, runRoleCosts, runs, defs as defsTable } from "../store/schema";
import { openStore } from "../store/store";
import { createRepos } from "../workspaces/repos";
import { createLegacyImporter, LegacyImportError } from "./legacy";
import { parseLegacyState } from "./legacy-state";

const FIXTURES = fileURLToPath(new URL("../../fixtures/legacy", import.meta.url));

const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
});

/** Una base en memoria con `api` y `dashboard` registrados; `infra` y `docs-sdks` no lo están. */
function setup() {
  const store = openStore({ path: ":memory:" });
  cleanups.push(() => store.close());
  const defs = createDefs(store);
  defs.register("flow", FlowBody);
  const repos = createRepos(store);
  const api = repos.add({ name: "api", path: "/home/demo/work/api" });
  // `dashboard` no trae ruta en la cabecera: se resuelve por nombre aunque su checkout esté en otra parte.
  const dashboard = repos.add({ name: "dashboard", path: "/elsewhere/dashboard" });
  const importer = createLegacyImporter({ store, defs });
  const rowCounts = () => ({
    projects: store.db.select().from(projects).all().length,
    projectRepos: store.db.select().from(projectRepos).all().length,
    issues: store.db.select().from(issues).all().length,
    pullRequests: store.db.select().from(pullRequests).all().length,
    runs: store.db.select().from(runs).all().length,
    runMetrics: store.db.select().from(runMetrics).all().length,
    runRoleCosts: store.db.select().from(runRoleCosts).all().length,
    defs: store.db.select().from(defsTable).all().length,
    events: store.db.select().from(events).all().length,
  });
  return { store, defs, repos, api, dashboard, importer, rowCounts };
}

const slugA = "demo-lote-0a1b2c3d4e5f";
const slugB = "demo-sin-linear";

describe("clanker import legacy", () => {
  test("importa proyectos, issues, PRs y corridas del fixture con sus métricas", () => {
    const { store, importer, api, dashboard } = setup();

    const result = importer.run({ from: FIXTURES, dryRun: false });

    expect(result).toEqual({
      dryRun: false,
      created: { projects: 2, issues: 7, pullRequests: 5, runs: 9, runRoleCosts: 23 },
      unresolvedRepos: ["infra"],
    });

    // Proyectos: pausados, con el parallel de la cabecera y los repos registrados en el orden de la cabecera.
    const a = store.db.select().from(projects).where(eq(projects.slug, slugA)).get()!;
    const b = store.db.select().from(projects).where(eq(projects.slug, slugB)).get()!;
    expect(a).toMatchObject({ name: "Lote demo", tracker: "linear", trackerRef: slugA, parallel: 1, status: "paused" });
    expect(b).toMatchObject({ name: "Demo sin Linear", trackerRef: slugB, parallel: 2, status: "paused" });
    expect(store.db.select().from(projectRepos).where(eq(projectRepos.projectId, a.id)).orderBy(projectRepos.ord).all()).toMatchObject([
      { repoId: api, ord: 0 },
      { repoId: dashboard, ord: 1 },
    ]);

    // Una corrida: flujo histórico archivado, outcome del core, contadores del flujo techlead-clasico y costo por rol.
    const demo4 = store.db.select().from(runs).where(eq(runs.sourceKey, `legacy:metrics:${slugA}:DEMO-4:2026-11-03T15:30:00Z`)).get()!;
    expect(demo4).toMatchObject({
      projectId: a.id,
      subjectType: "issue",
      status: "done",
      outcome: "done",
      rounds: { review: 3, bot: 3, ci: 2 },
      costMicros: 9_000_000,
      startedAt: Date.parse("2026-11-03T15:30:00Z") - 45 * 60_000,
      endedAt: Date.parse("2026-11-03T15:30:00Z"),
      params: { legacy: { result: "sin-lgtm", profile: "alto", repo: "api", mode: "real" } },
    });
    expect(store.db.select().from(runMetrics).where(eq(runMetrics.runId, demo4.id)).get()).toMatchObject({
      result: "done",
      minutes: 45,
      rounds: { review: 3, bot: 3, ci: 2 },
      outcomes: { bot: { valid: 1, false_positive: 2 } },
      costMicros: 9_000_000,
    });
    expect(store.db.select().from(runRoleCosts).where(eq(runRoleCosts.runId, demo4.id)).orderBy(runRoleCosts.role).all()).toEqual([
      { runId: demo4.id, role: "dev", model: "opus", effort: "high", tokens: 3_000_000, costMicros: 4_000_000 },
      { runId: demo4.id, role: "review-bugs", model: "sonnet", effort: "medium", tokens: 500_000, costMicros: 2_500_000 },
      { runId: demo4.id, role: "techlead", model: "opus", effort: "medium", tokens: 900_000, costMicros: 2_500_000 },
    ]);
    const flow = store.db.select().from(defsTable).where(eq(defsTable.id, demo4.flowDefId)).get()!;
    expect(flow).toMatchObject({ kind: "flow", slug: "legacy-clanker-loop", scope: "user", currentVersion: demo4.flowVersion });
    expect(flow.archivedAt).not.toBeNull();

    // Los resultados del loop viejo se mapean a outcomes del core y `fallo` se normaliza a `falló`.
    const outcomes = store.db.select().from(runs).all().map((r) => [(r.params as { legacy: { result: string } }).legacy.result, r.outcome]);
    expect(outcomes).toEqual(
      expect.arrayContaining([
        ["falló", "failed"],
        ["necesita-humano", "blocked"],
        ["council-listo", "done"],
        ["sin-lgtm", "done"],
      ]),
    );
    expect(store.db.select().from(runs).where(eq(runs.outcome, "failed")).all()).toMatchObject([
      { status: "failed" },
      { status: "failed" },
    ]);

    // Issues y PRs enlazados a su run: el estado sale del historial y el PR sin repo es del primero de la cabecera.
    const demo2 = store.db.select().from(issues).where(eq(issues.key, "DEMO-2")).get()!;
    expect(demo2).toMatchObject({ status: "in_review", rawStatus: "listo (sin squash, pendiente body)", url: "https://linear.app/acme/issue/DEMO-2", projectId: a.id });
    expect(store.db.select().from(issues).where(eq(issues.key, "DEMO-3")).get()).toMatchObject({ status: "done" });
    expect(store.db.select().from(issues).where(eq(issues.key, "DEMO-8")).get()).toMatchObject({ status: "in_progress", rawStatus: "necesita-humano" });
    const pr102 = store.db.select().from(pullRequests).where(eq(pullRequests.number, 102)).get()!;
    expect(pr102).toMatchObject({ repoId: api, state: "open", owned: false, issueId: demo2.id, headRef: "" });
    expect(store.db.select().from(runs).where(eq(runs.id, pr102.runId!)).get()).toMatchObject({ subjectId: demo2.id });
    expect(store.db.select().from(pullRequests).where(eq(pullRequests.number, 11)).get()).toMatchObject({ repoId: dashboard, state: "merged", headRef: "demo-3-date-picker" });
    // `infra` no está registrado: su PR queda fuera hasta repetir el import.
    expect(store.db.select().from(pullRequests).where(eq(pullRequests.number, 7)).all()).toEqual([]);

    // Un solo evento, con el origin import.
    expect(store.events.since(0, { types: ["import.completed"] })).toMatchObject([
      { origin: "import", payload: { source: FIXTURES, counts: result.created } },
    ]);
  });

  test("projects.summary de lo importado suma lo mismo que metrics.jsonl", () => {
    const { store, importer } = setup();
    importer.run({ from: FIXTURES, dryRun: false });
    const metrics = createMetrics(store);
    const projectA = store.db.select().from(projects).where(eq(projects.slug, slugA)).get()!;

    const summary = metrics.summary(projectA.id);

    expect(summary).toMatchObject({
      runs: 5,
      costMicros: 3_500_000 + 5_000_000 + 650_000 + 4_000_000 + 9_000_000,
      minutes: 20 + 30 + 5 + 25 + 45,
      results: [
        { result: "done", count: 4 },
        { result: "failed", count: 1 },
      ],
      rounds: [
        { counter: "bot", total: 1 + 2 + 0 + 1 + 3 },
        { counter: "ci", total: 0 + 1 + 0 + 0 + 2 },
        { counter: "review", total: 2 + 1 + 1 + 2 + 3 },
      ],
    });
    expect(summary.byRole.find((r) => r.role === "dev")).toEqual({ role: "dev", runs: 5, tokens: 1_000_000 + 2_000_000 + 100_000 + 1_200_000 + 3_000_000, costMicros: 1_500_000 + 2_500_000 + 400_000 + 1_750_000 + 4_000_000 });
    // El techlead se importa para poder compararlo.
    expect(summary.byRole.map((r) => r.role)).toContain("techlead");
  });

  test("importar dos veces deja los mismos conteos y no repite el evento de filas", () => {
    const { importer, rowCounts } = setup();

    const first = importer.run({ from: FIXTURES, dryRun: false });
    const afterFirst = rowCounts();
    const second = importer.run({ from: FIXTURES, dryRun: false });

    expect(second.created).toEqual({ projects: 0, issues: 0, pullRequests: 0, runs: 0, runRoleCosts: 0 });
    expect(rowCounts()).toEqual({ ...afterFirst, events: afterFirst.events + 1 });
    expect(first.created.runs).toBe(9);
  });

  test("--dry-run cuenta lo mismo que la importación real y no escribe nada", () => {
    const { importer, rowCounts } = setup();
    const empty = rowCounts();

    const dry = importer.run({ from: FIXTURES, dryRun: true });

    expect(rowCounts()).toEqual(empty);
    expect(rowCounts().events).toBe(0);
    expect(dry.dryRun).toBe(true);
    expect(importer.run({ from: FIXTURES, dryRun: false }).created).toEqual(dry.created);
  });

  test("lo nuevo que el loop agregó a metrics.jsonl entra en la segunda importación", () => {
    const { importer, store } = setup();
    const home = mkdtempSync(join(tmpdir(), "legacy-"));
    cleanups.push(() => rmSync(home, { recursive: true, force: true }));
    cpSync(FIXTURES, home, { recursive: true });
    importer.run({ from: home, dryRun: false });

    const line = JSON.stringify({ issue: "DEMO-5", project: slugA, repo: "api", result: "listo", ts: "2026-11-05T10:00:00Z", usd: 1, minutes: 3, por_rol: { dev: { modelo: "opus", tokens: 10, usd: 1 } } });
    writeFileSync(join(home, "metrics.jsonl"), `${line}\n`, { flag: "a" });
    const second = importer.run({ from: home, dryRun: false });

    expect(second.created).toEqual({ projects: 0, issues: 1, pullRequests: 0, runs: 1, runRoleCosts: 1 });
    expect(store.db.select().from(runs).where(eq(runs.outcome, "done")).all()).toHaveLength(7);
    expect(store.db.select().from(runRoleCosts).where(eq(runRoleCosts.role, "dev")).all().some((r) => r.effort === null && r.model === "opus")).toBe(true);
  });

  test("metrics.byRole distingue las corridas importadas de las nuevas", () => {
    const { store, importer } = setup();
    importer.run({ from: FIXTURES, dryRun: false });
    const metrics = createMetrics(store);

    const imported = metrics.byRole({ imported: true });

    expect(imported.find((r) => r.role === "techlead")).toMatchObject({ runs: 8 });
    expect(metrics.byRole({ imported: false })).toEqual([]);
    expect(metrics.byRole()).toEqual(imported);
    expect(metrics.byModel({ imported: false })).toEqual([]);
    expect(metrics.byDay({ imported: false })).toEqual([]);
    expect(metrics.byDay({ imported: true }).map((d) => d.day)).toEqual(["2026-11-01", "2026-11-02", "2026-11-03", "2026-11-04"]);
  });

  test("registrar un repo faltante y repetir el import completa sus PRs y el repo del proyecto", () => {
    const { importer, repos, store } = setup();
    expect(importer.run({ from: FIXTURES, dryRun: false }).created.pullRequests).toBe(5);
    const infra = repos.add({ name: "infra", path: "/home/demo/work/infra" });

    const second = importer.run({ from: FIXTURES, dryRun: false });

    expect(second).toMatchObject({ created: { pullRequests: 1, runs: 0 }, unresolvedRepos: [] });
    expect(store.db.select().from(pullRequests).where(eq(pullRequests.repoId, infra)).get()).toMatchObject({ number: 7, state: "closed" });
    const a = store.db.select().from(projects).where(eq(projects.slug, slugA)).get()!;
    expect(store.db.select().from(projectRepos).where(eq(projectRepos.projectId, a.id)).orderBy(projectRepos.ord).all().map((r) => [r.repoId === infra, r.ord])).toEqual([
      [false, 0],
      [false, 1],
      [true, 2],
    ]);
  });

  test("un proyecto ya existente no se pisa", () => {
    const { importer, store } = setup();
    importer.run({ from: FIXTURES, dryRun: false });
    store.tx((tx) => tx.db.update(projects).set({ status: "active", parallel: 4 }).where(eq(projects.slug, slugA)).run());

    importer.run({ from: FIXTURES, dryRun: false });

    expect(store.db.select().from(projects).where(eq(projects.slug, slugA)).get()).toMatchObject({ status: "active", parallel: 4 });
  });

  describe("errores", () => {
    const withMetrics = (text: string) => {
      const home = mkdtempSync(join(tmpdir(), "legacy-"));
      cleanups.push(() => rmSync(home, { recursive: true, force: true }));
      writeFileSync(join(home, "metrics.jsonl"), text);
      return home;
    };

    test("sin metrics.jsonl dice cuál es la carpeta esperada y no escribe", () => {
      const { importer, rowCounts } = setup();
      const home = mkdtempSync(join(tmpdir(), "legacy-"));
      cleanups.push(() => rmSync(home, { recursive: true, force: true }));

      expect(() => importer.run({ from: home, dryRun: false })).toThrow(LegacyImportError);
      expect(() => importer.run({ from: home, dryRun: false })).toThrow(/No hay metrics\.jsonl en .*clanker-loop/);
      expect(rowCounts().runs).toBe(0);
    });

    test("un resultado desconocido falla con el nombre del resultado", () => {
      const { importer } = setup();
      const home = withMetrics('{"issue":"X-1","project":"p","result":"raro","ts":"2026-11-01T00:00:00Z"}\n');

      expect(() => importer.run({ from: home, dryRun: true })).toThrow(/"raro"/);
    });

    test("una fila sin ts falla: no tendría clave de origen", () => {
      const { importer } = setup();
      const home = withMetrics('{"issue":"X-1","project":"p","result":"listo"}\n');

      expect(() => importer.run({ from: home, dryRun: true })).toThrow(/X-1.*ts válido/);
    });

    test("la misma línea repetida en el archivo es una sola corrida", () => {
      const { importer } = setup();
      const line = '{"issue":"X-1","project":"p","result":"listo","ts":"2026-11-01T00:00:00Z","usd":2,"minutes":1}\n';
      const home = withMetrics(line + line);

      expect(importer.run({ from: home, dryRun: false }).created).toMatchObject({ runs: 1 });
    });

    test("una fila sin proyecto va al proyecto sin-proyecto", () => {
      const { importer, store } = setup();
      const home = withMetrics('{"issue":"X-1","result":"listo","ts":"2026-11-01T00:00:00Z","usd":2,"minutes":1}\n');

      expect(importer.run({ from: home, dryRun: false }).created).toMatchObject({ projects: 1, runs: 1 });
      expect(store.db.select().from(projects).get()).toMatchObject({ slug: "sin-proyecto", parallel: 1 });
    });
  });
});

describe("parseLegacyState", () => {
  test("lee título, cabecera, repos con y sin ruta, parallel y las filas del historial", () => {
    const state = parseLegacyState(
      [
        "# Algo · clanker-loop",
        "proyecto: https://linear.app/ws/project/algo-abc123 · repos: a (/x/a), b (raíz), c (sub, issues) · ERD: no",
        "parallel: 3 para issues nuevas",
        "## Historial",
        "| ID | estado | perfil | PR | branch | min | $ |",
        "|---|---|---|---|---|---|---|",
        "| ZZ-1 | listo (algo) | medio | a#5 (stacked #4) | rama-uno (main) | 1 | 1 |",
        "| ZZ-2 (tf) | cerrado | medio | #6 CERRADO | (worktree a-zz-2) | - | - |",
        "| ZZ-3 | mergeado | medio | - | - | - | - |",
        "- una nota",
        "## Omitidas",
      ].join("\n"),
    );

    expect(state).toEqual({
      name: "Algo",
      trackerUrl: "https://linear.app/ws/project/algo-abc123",
      repos: [{ name: "a", path: "/x/a" }, { name: "b" }, { name: "c" }],
      parallel: 3,
      history: [
        { key: "ZZ-1", status: "listo (algo)", state: "listo", pr: { repo: "a", number: 5 }, branch: "rama-uno" },
        { key: "ZZ-2", variant: "tf", status: "cerrado", state: "cerrado", pr: { number: 6 } },
        { key: "ZZ-3", status: "mergeado", state: "mergeado" },
      ],
    });
  });

  test("un archivo sin título o sin historial no es el state.md de un proyecto del loop", () => {
    expect(() => parseLegacyState("hola")).toThrow(/título/);
    expect(() => parseLegacyState("# X · clanker-loop\nproyecto: sin\n## Brief")).toThrow(/Historial/);
  });
});

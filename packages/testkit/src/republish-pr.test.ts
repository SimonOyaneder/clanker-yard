import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { IssueId } from "@clanker/api";
import { newId } from "@clanker/core";
import { afterEach, describe, expect, test, vi } from "vitest";
import { startTechleadScenario, type TechleadScenario } from "./techlead-scenario";

// `prs.republish` con el core real, el GitHub simulado y el runtime fake: el committer sale de los guiones de
// `techlead-e2e` (dos commits: la implementación y su test), así que cada PR sembrado cambia `src/<x>.ts` y `src/<x>.test.ts`.

vi.setConfig({ testTimeout: 90_000 });

let scenario: TechleadScenario | undefined;
const cleanups: (() => void)[] = [];
afterEach(async () => {
  await scenario?.cleanup();
  scenario = undefined;
  for (const cleanup of cleanups.splice(0)) cleanup();
});

const GIT_ENV = { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null", GIT_AUTHOR_NAME: "Seed", GIT_AUTHOR_EMAIL: "seed@example.com", GIT_COMMITTER_NAME: "Seed", GIT_COMMITTER_EMAIL: "seed@example.com" };
const run = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, env: GIT_ENV, encoding: "utf8", stdio: "pipe" }).trimEnd();

interface Seeded {
  number: number;
  branch: string;
  issueId: IssueId;
  key: string;
}

/** Siembra un PR como lo dejaría una corrida vieja: branch `iss_...` en el remoto con tres commits sueltos, PR en el simulador y su fila `owned` con la issue. */
async function seed(s: TechleadScenario, name: string, opts: { base?: string; draft?: boolean } = {}): Promise<Seeded> {
  const issue = await s.client.issues.createLocal({ projectId: s.project.id, title: `Cambio ${name}`, body: "Un cambio de prueba" });
  const branch = `iss_${name}`;
  const clone = mkdtempSync(join(tmpdir(), "clanker-seed-"));
  cleanups.push(() => rmSync(clone, { recursive: true, force: true }));
  run(clone, "clone", "--quiet", s.repo.remoteDir!, ".");
  run(clone, "checkout", "--quiet", "-b", branch, `origin/${opts.base ?? "main"}`);
  mkdirSync(join(clone, "src"), { recursive: true });
  writeFileSync(join(clone, `src/${name}.ts`), `export const ${name} = 1;\nexport const again = 2;\n`);
  run(clone, "add", "-A");
  run(clone, "commit", "--quiet", "-m", "wip");
  writeFileSync(join(clone, `src/${name}.test.ts`), `import { ${name} } from "./${name}";\n`);
  run(clone, "add", "-A");
  run(clone, "commit", "--quiet", "-m", "wip 2");
  run(clone, "push", "--quiet", "origin", branch);

  const pr = s.github.openPr({ head: branch, base: opts.base ?? "main", title: `Cambio ${name}`, body: `Cuerpo de ${name}`, draft: opts.draft ?? true });
  const repoId = s.project.repos[0]!.repoId;
  const id = newId("pr");
  s.store.db
    .$client.prepare(
      `INSERT INTO pull_requests (id, repo_id, number, node_id, head_ref, base_ref, head_sha, state, is_draft, issue_id, owned)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'open', ?, ?, 1)`,
    )
    .run(id, repoId, pr.number, `PR_${pr.number}`, branch, opts.base ?? "main", pr.headSha(), opts.draft === false ? 0 : 1, issue.id);
  if (opts.base) {
    const parent = s.store.db.$client.prepare("SELECT id FROM pull_requests WHERE head_ref = ?").get(opts.base) as { id: string };
    s.store.db.$client.prepare("INSERT INTO pr_parents (child_id, parent_id) VALUES (?, ?)").run(id, parent.id);
  }
  return { number: pr.number, branch, issueId: issue.id, key: issue.ref.key };
}

/** El prefijo de la branch nueva: la key de la issue como la escribe `suggestedBranch`. */
const slug = (key: string) => key.toLowerCase().replace(/[^a-z0-9]+/g, "-");

const start = (options: Parameters<typeof startTechleadScenario>[0] = {}) =>
  startTechleadScenario({ watch: false, bot: () => "lgtm", ...options });

const remoteTree = (s: TechleadScenario, branch: string) => s.repo.git("--git-dir", s.repo.remoteDir!, "rev-parse", `refs/heads/${branch}^{tree}`);
const remoteBranches = (s: TechleadScenario) =>
  s.repo.git("--git-dir", s.repo.remoteDir!, "for-each-ref", "--format=%(refname:short)", "refs/heads").split("\n").sort();
/** Lo que hace la CLI: lanza el lote y consulta el avance hasta que termina. */
async function republishAll(s: TechleadScenario, input: Parameters<TechleadScenario["client"]["prs"]["republish"]>[0] = {}) {
  let progress = await s.client.prs.republish(input);
  while (!progress.done) {
    await new Promise((resolve) => setTimeout(resolve, 50));
    progress = await s.client.prs.republishProgress({ id: progress.id });
  }
  return progress.results;
}

const subjects = (s: TechleadScenario, branch: string) => s.remoteLog(branch).map((c) => c.subject).reverse();

describe("prs.republish", () => {
  test("un PR simple sale con branch nueva, mismo árbol, commits del committer, mismo título y draft, y el viejo se cierra", async () => {
    scenario = await start();
    const old = await seed(scenario, "transfer");
    const oldTree = remoteTree(scenario, old.branch);
    scenario.repo.git("config", "user.name", "Simón Test");
    scenario.repo.git("config", "user.email", "simon@example.com");

    const results = await republishAll(scenario, {});

    const branch = `${slug(old.key)}-cambio-transfer`;
    expect(results).toEqual([{ repo: expect.any(String), number: old.number, status: "republished", branch, base: "main", newNumber: 2, commits: 2 }]);
    const [before, after] = scenario.github.pulls();
    expect(before).toMatchObject({ number: old.number, state: "closed" });
    expect(after).toMatchObject({ number: 2, state: "open", draft: true, title: `[${old.key}] Cambio transfer`, head: { ref: branch }, base: { ref: "main" }, assignees: [{ login: "acme" }] });
    expect(after!.body).toBe("Cuerpo de transfer\n\nReemplaza a #1");
    expect(scenario.github.pr(old.number).node().comments.map((c) => c.body)).toContain("Reemplazado por #2");

    // Mismo árbol que el head viejo, cortado por el committer, y la branch vieja ya no está en el remoto.
    expect(remoteTree(scenario, branch)).toBe(oldTree);
    expect(subjects(scenario, branch)).toEqual(["feat(transfers): validate and round the transfer amount", "test(transfers): log a created transfer"]);
    expect(remoteBranches(scenario)).toEqual(["main", branch]);
    // Los commits salen a nombre de quien tiene el repo, nunca con una identidad del sistema.
    const authors = scenario.repo.git("--git-dir", scenario.repo.remoteDir!, "log", "--format=%an <%ae> / %cn <%ce>", `main..refs/heads/${branch}`).split("\n");
    expect(authors).toEqual(Array(2).fill("Simón Test <simon@example.com> / Simón Test <simon@example.com>"));

    // El core sigue al PR nuevo: su fila es de la issue, la corrida lo tomó y el viejo quedó cerrado.
    const rows = scenario.store.db.$client.prepare("SELECT number, state, owned, issue_id AS issue, run_id AS run FROM pull_requests ORDER BY number").all();
    expect(rows).toEqual([
      { number: 1, state: "closed", owned: 1, issue: old.issueId, run: null },
      { number: 2, state: "open", owned: 1, issue: old.issueId, run: expect.any(String) },
    ]);
    // Era draft: pidió `/review` en el PR nuevo, como el flujo normal tras publicar.
    expect(scenario.github.pr(2).node().comments.map((c) => c.body.split("\n")[0])).toContain("/review");
  });

  test("un stack de 2: el hijo sale sobre la branch nueva del padre y las branches viejas se borran al final", async () => {
    scenario = await start();
    const parent = await seed(scenario, "parent");
    const child = await seed(scenario, "child", { base: parent.branch });

    const results = await republishAll(scenario, {});

    expect(results.map((r) => [r.number, r.status, r.newNumber, r.base])).toEqual([
      [parent.number, "republished", 3, "main"],
      [child.number, "republished", 4, `${slug(parent.key)}-cambio-parent`],
    ]);
    const [oldParent, oldChild, newParent, newChild] = scenario.github.pulls();
    expect([oldParent!.state, oldChild!.state, newParent!.state, newChild!.state]).toEqual(["closed", "closed", "open", "open"]);
    expect(newChild!.base.ref).toBe(newParent!.head.ref);
    expect(remoteBranches(scenario)).toEqual(["main", newParent!.head.ref, newChild!.head.ref].sort());
    const links = scenario.store.db.$client.prepare("SELECT c.number AS child, p.number AS parent FROM pr_parents x JOIN pull_requests c ON c.id = x.child_id JOIN pull_requests p ON p.id = x.parent_id ORDER BY c.number").all();
    expect(links).toEqual([
      { child: 2, parent: 3 },
      { child: 4, parent: 3 },
    ]);
  });

  test("republicar solo el hijo: el PR nuevo queda colgando del mismo padre y los hijos del viejo pasan al nuevo", async () => {
    scenario = await start();
    const parent = await seed(scenario, "parent");
    const child = await seed(scenario, "child", { base: parent.branch });
    const grandchild = await seed(scenario, "grandchild", { base: child.branch });
    // El caché aún no se enteró de que el padre sigue abierto (se reabrió): `pr.publish` no lo ve como padre por su base.
    scenario.store.db.$client.prepare("UPDATE pull_requests SET state = 'closed' WHERE number = ?").run(parent.number);

    const results = await republishAll(scenario, { prs: [child.number] });

    expect(results.map((r) => [r.number, r.status, r.newNumber, r.base])).toEqual([[child.number, "republished", 4, parent.branch]]);
    const links = scenario.store.db.$client.prepare("SELECT c.number AS child, p.number AS parent FROM pr_parents x JOIN pull_requests c ON c.id = x.child_id JOIN pull_requests p ON p.id = x.parent_id ORDER BY c.number, p.number").all();
    expect(links).toEqual([
      { child: 2, parent: 1 },
      { child: 3, parent: 4 },
      { child: 4, parent: 1 },
    ]);
    expect(grandchild.number).toBe(3);
  });

  test("republish lanza y vuelve: el hijo espera a que su padre publique y sale solo con progress, sin que ninguna llamada espere una corrida", async () => {
    scenario = await start();
    const parent = await seed(scenario, "parent");
    const child = await seed(scenario, "child", { base: parent.branch });

    const first = await scenario.client.prs.republish({});

    // Vuelve con el padre en marcha (o ya publicado) y el hijo sin lanzar: ninguna corrida terminó dentro de la llamada.
    expect(first.done).toBe(false);
    expect(first.results.map((r) => [r.number, r.status])).toEqual([
      [parent.number, "running"],
      [child.number, "pending"],
    ]);
    expect(scenario.store.db.$client.prepare("SELECT COUNT(*) AS n FROM runs WHERE flow_def_id IS NOT NULL").get()).toEqual({ n: 1 });

    let progress = first;
    const seen: string[] = [];
    while (!progress.done) {
      await new Promise((resolve) => setTimeout(resolve, 50));
      progress = await scenario.client.prs.republishProgress({ id: first.id });
      seen.push(progress.results.map((r) => r.status).join(","));
      // Un hijo solo se lanza con el padre ya publicado: su PR nuevo existe y el viejo está cerrado.
      if (progress.results[1]!.status === "running") expect(progress.results[0]).toMatchObject({ newNumber: 3 });
    }

    expect(progress.results.map((r) => [r.number, r.status, r.newNumber])).toEqual([
      [parent.number, "republished", 3],
      [child.number, "republished", 4],
    ]);
    expect(seen.some((line) => line.endsWith("pending") || line.endsWith("running"))).toBe(true);
    await expect(scenario.client.prs.republishProgress({ id: "no-existe" })).rejects.toThrow(/No hay una republicación/);
  });

  test("un padre que falla (el committer dejó otro árbol) no publica nada, deja el PR viejo abierto y salta a su hijo", async () => {
    const dir = mkdtempSync(join(tmpdir(), "clanker-tamper-"));
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
    writeFileSync(
      join(dir, "committer.r0.plan.yaml"),
      `match: { mode: plan, round: "*" }
times: 1
effects:
  - write: { path: src/parent.ts, content: "export const parent = 99;\\n" }
result:
  status: success
  structured:
    outcome: ok
    summary: "Dos commits"
    payload:
      commits:
        - { message: "feat(transfers): validate and round the transfer amount", hunks: [h2], tests: [], whyAtomic: "uno" }
        - { message: "test(transfers): log a created transfer", hunks: [h1], tests: [], whyAtomic: "dos" }
      pr: { title: "feat: x", body: "x" }
      notes: []
`,
    );
    scenario = await start({ fixtures: [dir] });
    const parent = await seed(scenario, "parent");
    const child = await seed(scenario, "child", { base: parent.branch });

    const results = await republishAll(scenario, {});

    expect(results).toEqual([
      expect.objectContaining({ number: parent.number, status: "failed", reason: expect.stringMatching(/árbol/) }),
      expect.objectContaining({ number: child.number, status: "skipped", reason: expect.stringMatching(/^su padre #1 no se rehízo/) }),
    ]);
    expect(scenario.github.pulls().map((p) => [p.number, p.state])).toEqual([
      [1, "open"],
      [2, "open"],
    ]);
    expect(remoteBranches(scenario)).toEqual(["main", child.branch, parent.branch].sort());
  });

  test("un fallo en commit termina la corrida en failed, sin worktree ni branch local, y el reintento usa el mismo nombre", async () => {
    const dir = mkdtempSync(join(tmpdir(), "clanker-commit-fails-"));
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
    writeFileSync(
      join(dir, "committer.r0.plan.yaml"),
      `match: { mode: plan, round: "*" }
times: 2
result:
  status: error
  message: "el committer se cayó"
`,
    );
    scenario = await start({ fixtures: [dir] });
    const old = await seed(scenario, "transfer");
    const branch = `${slug(old.key)}-cambio-transfer`;
    const runRows = () => scenario!.store.db.$client.prepare("SELECT status, outcome FROM runs").all();
    const workspaces = () => scenario!.store.db.$client.prepare("SELECT branch FROM workspaces").all();

    const [failed] = await republishAll(scenario, {});

    expect(failed).toMatchObject({ number: old.number, status: "failed", branch });
    expect(runRows()).toEqual([{ status: "failed", outcome: "failed" }]);
    expect(workspaces()).toEqual([]);
    expect(scenario.repo.git("branch", "--list", branch)).toBe("");
    expect(scenario.github.pr(old.number).node()).toMatchObject({ state: "OPEN" });
    expect(remoteBranches(scenario)).toEqual(["main", old.branch].sort());

    const [retried] = await republishAll(scenario, {});

    expect(retried).toMatchObject({ number: old.number, status: "republished", branch });
  });

  test("se salta un PR con corrida viva, con thread de council y con comentario humano, y los demás siguen", async () => {
    scenario = await start();
    const live = await seed(scenario, "live");
    const council = await seed(scenario, "council");
    const human = await seed(scenario, "human");
    const fine = await seed(scenario, "fine");
    scenario.github.pr(council.number).councilThread("rechaza los negativos", { path: "src/council.ts", line: 1 });
    scenario.github.pr(human.number).comment("marta", "Esto no me convence");
    const { def_id: flow, version } = scenario.store.db.$client.prepare("SELECT def_id, version FROM def_versions LIMIT 1").get() as { def_id: string; version: number };
    scenario.store.db
      .$client.prepare(
        `INSERT INTO runs (id, project_id, subject_type, subject_id, flow_def_id, flow_version, roles, lane, status, writes, params, rounds, started_at)
         VALUES (?, ?, 'issue', ?, ?, ?, '{}', 'dev', 'running', 1, '{}', '{}', 1)`,
      )
      .run(newId("run"), scenario.project.id, live.issueId, flow, version);

    const results = await republishAll(scenario, {});

    expect(results.map((r) => [r.number, r.status])).toEqual([
      [live.number, "skipped"],
      [council.number, "skipped"],
      [human.number, "skipped"],
      [fine.number, "republished"],
    ]);
    expect(results[0]!.reason).toMatch(/sigue viva/);
    expect(results[1]!.reason).toMatch(/threads sin resolver/);
    expect(results[2]!.reason).toMatch(/comentarios o reviews de humanos/);
    expect(scenario.github.pulls().filter((p) => p.state === "open").map((p) => p.number)).toEqual([live.number, council.number, human.number, 5]);
  });

  test("draftOnly deja los PRs listos como están y un draft apilado sobre uno listo sale sobre su branch actual", async () => {
    scenario = await start();
    const ready = await seed(scenario, "ready", { draft: false });
    const child = await seed(scenario, "kid", { base: ready.branch });

    const results = await republishAll(scenario, { draftOnly: true });

    expect(results.map((r) => [r.number, r.status, r.base])).toEqual([[child.number, "republished", ready.branch]]);
    expect(scenario.github.pr(ready.number).node()).toMatchObject({ state: "OPEN" });
    expect(scenario.github.pulls().map((p) => [p.number, p.state, p.base.ref])).toEqual([
      [1, "open", "main"],
      [2, "closed", ready.branch],
      [3, "open", ready.branch],
    ]);
    expect(remoteBranches(scenario)).toContain(ready.branch);
  });

  test("dry-run lista viejo → branch nueva, base y commits sin escribir en GitHub, en el core ni correr al committer", async () => {
    scenario = await start();
    const parent = await seed(scenario, "parent");
    const child = await seed(scenario, "child", { base: parent.branch });
    const snapshot = () => ({
      rows: scenario!.store.db.$client.prepare("SELECT * FROM pull_requests ORDER BY number").all(),
      runs: scenario!.store.db.$client.prepare("SELECT COUNT(*) AS n FROM runs").get(),
      pulls: scenario!.github.pulls(),
      branches: remoteBranches(scenario!),
    });
    const before = snapshot();
    const requests = scenario.github.requests.length;

    const results = await republishAll(scenario, { dryRun: true });

    expect(results).toEqual([
      expect.objectContaining({ number: parent.number, status: "planned", branch: `${slug(parent.key)}-cambio-parent`, base: "main", commits: 2 }),
      expect.objectContaining({ number: child.number, status: "planned", branch: `${slug(child.key)}-cambio-child`, base: `${slug(parent.key)}-cambio-parent`, commits: 2 }),
    ]);
    expect(snapshot()).toEqual(before);
    expect(scenario.github.requests.slice(requests).filter((r) => r.method !== "GET" && r.path !== "/graphql")).toEqual([]);
  });
});

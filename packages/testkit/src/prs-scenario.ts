import type { Client, IssueId, RepoId, RunId } from "@clanker/api";
import { newId, type Store } from "@clanker/core";
import { writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import type { CommitSpec, TempGitRepo } from "./git";
import type { GitHubSim, SimPr } from "./github-sim";
import { seedPr } from "@clanker/core/testing";

// El escenario de `DEMO_SCENARIO=prs` (ver `demo-core.ts`): los PRs de la vista de Stacks de PR contra el GitHub
// simulado y el pack de ejemplo: un stack de tres, dos PRs de riesgo alto (uno con su cola caída) que un tercero junta en
// una base combinada, uno en cola, uno en hold, uno listo para merge y uno sin señales.
//
// Cada PR se abre en el simulador y su fila de `pull_requests` se escribe a mano, como `pr.publish` la dejaría; después
// `prs.refresh` lee el PR por GraphQL y deja su estado en el caché, igual que Watch. Nada de esto necesita Watch
// encendido.

const lines = (n: number, prefix: string) => Array.from({ length: n }, (_, i) => `${prefix} ${i}\n`).join("");
const change = (message: string, file: string, size: number): CommitSpec[] => [{ message, files: { [file]: lines(size, file) } }];

/** Las ramas que el repo del escenario necesita en su bare: todas salen de `main`, con commits propios. */
export const PR_BRANCHES: Record<string, CommitSpec[]> = {
  "lint-imports": change("feat: lint de imports entre engines", "lint.txt", 40),
  "boundary-checks": change("feat: checks de boundaries en CI", "ci.txt", 12),
  "engine-rules": change("feat: reglas de boundaries", "rules.txt", 6),
  "reconcile-job": change("feat: migrar el job de conciliación", "job.txt", 30),
  "rename-posting": change("refactor: renombrar Ledger a Posting", "posting.txt", 80),
  "base-combined": change("chore: base combinada de conciliación y renombre", "combined.txt", 4),
  "close-reconcile": change("feat: cerrar la conciliación", "close.txt", 20),
  "accounts-scroll": change("fix: scroll del listado de cuentas", "scroll.txt", 3),
  "radix-tooltips": change("refactor: tooltips en Radix", "tooltips.txt", 25),
  "payment-summary": change("feat: pantalla de resumen del pago", "summary.txt", 50),
};

interface Spec {
  head: string;
  title: string;
  body?: string;
  base?: string;
  draft?: boolean;
  /** Lo abrió el sistema: queda `owned` y, el primero, con la corrida y la issue de `origin`. */
  owned?: boolean;
  parents?: string[];
  setup(pr: SimPr, account: string): void;
}

/** Un PR aprobado por un humano con el CI en verde: lo que el pack da por listo para merge. */
const approved = (pr: SimPr) => {
  pr.ci("green");
  pr.review("ana", "APPROVED");
};
/**
 * Alguien comentó: el pack no ofrece ni mergea solo un PR con conversación de un humano (`noHumanTalk`). Sin esto, Watch
 * leería el PR "listo" por primera vez y el core comentaría el comando de merge por su cuenta (`auto`), y el escenario
 * perdería el PR listo y el que tiene hold.
 */
const discussed = (pr: SimPr) => pr.comment("marta", "Lo reviso mejor mañana");
const lgtm = (pr: SimPr) => pr.botLgtm();
/** Comentó el comando de merge y la cola (`merge-queue`) está en ese estado. */
const requested = (pr: SimPr, account: string, state: "PENDING" | "FAILURE") => {
  pr.comment(account, "/merge");
  pr.status("merge-queue", state);
};

export async function seedPrs({
  client,
  store,
  sim,
  repoId,
  origin,
}: {
  client: Client;
  store: Store;
  sim: GitHubSim;
  repoId: RepoId;
  /** La issue y la corrida que "abrió" el primer PR, para ver "Ver corrida". */
  origin: { issueId: IssueId; runId: RunId };
}): Promise<void> {
  const account = sim.account;
  // El pack solo aplica la estrategia de merge donde `merge-queue` corre en la branch por defecto.
  sim.defaultBranchCheck("merge-queue");

  const specs: Spec[] = [
    {
      head: "lint-imports",
      title: "Lint de imports entre engines",
      body: "## Qué cambia\n\nAgrega 40 casos de imports entre engines en `lint.txt` para revisar sus dependencias.\n\n## Cómo revisarlo\n\nRevisa el commit y los casos de `lint.txt` en la pestaña Archivos.\n",
      owned: true,
      setup: (pr) => (approved(pr), lgtm(pr), discussed(pr), pr.label("risk:mid")),
    },
    {
      head: "boundary-checks",
      base: "lint-imports",
      title: "Agregar checks de boundaries a CI",
      owned: true,
      parents: ["lint-imports"],
      setup(pr) {
        pr.ci("green");
        pr.review("marta", "CHANGES_REQUESTED");
        pr.thread("marta", "¿Y los engines de pagos?", { path: "ci.txt", line: 3 });
        pr.thread("marta", "Falta el caso sin dependencias", { path: "ci.txt", line: 8 });
        pr.label("risk:low");
      },
    },
    {
      head: "engine-rules",
      base: "boundary-checks",
      title: "Reglas de boundaries para engines nuevas",
      draft: true,
      owned: true,
      parents: ["boundary-checks"],
      setup: (pr) => (pr.ci("pending"), pr.label("risk:low")),
    },
    {
      head: "reconcile-job",
      title: "Migrar el job de conciliación",
      owned: true,
      setup: (pr) => (approved(pr), lgtm(pr), pr.label("risk:high"), requested(pr, account, "FAILURE")),
    },
    {
      head: "rename-posting",
      title: "Renombrar Payments::Ledger a Payments::Posting",
      owned: true,
      setup(pr) {
        pr.ci("green");
        pr.review("diego", "APPROVED");
        pr.botFindings([{ body: "Falta migrar el alias viejo", path: "posting.txt", line: 12 }]);
        pr.thread("marta", "Esto rompe el job de conciliación", { path: "posting.txt", line: 40 });
        pr.comment("marta", "Lo vemos en la daily");
        pr.label("risk:high");
      },
    },
    {
      head: "close-reconcile",
      base: "base-combined",
      title: "Cerrar la conciliación con el nuevo nombre",
      draft: true,
      owned: true,
      parents: ["reconcile-job", "rename-posting"],
      setup: (pr) => (pr.ci("pending"), pr.label("risk:high")),
    },
    {
      head: "accounts-scroll",
      title: "Arreglar el scroll del listado de cuentas",
      owned: true,
      setup: (pr) => (approved(pr), lgtm(pr), pr.label("risk:low"), requested(pr, account, "PENDING")),
    },
    { head: "radix-tooltips", title: "Migrar los tooltips a Radix", owned: true, setup: (pr) => (approved(pr), lgtm(pr), discussed(pr), pr.label("risk:mid")) },
    { head: "payment-summary", title: "Pantalla de resumen del pago", setup: (pr) => (pr.ci("green"), pr.requestReview("sofia")) },
  ];

  const ids = new Map<string, string>();
  for (const [index, spec] of specs.entries()) {
    const pr = sim.openPr({ head: spec.head, ...(spec.base && { base: spec.base }), title: spec.title, ...(spec.body && { body: spec.body }), ...(spec.draft && { draft: true }) });
    spec.setup(pr, account);
    const first = index === 0;
    ids.set(
      spec.head,
      seedPr(store, {
        repoId,
        number: pr.number,
        headRef: spec.head,
        baseRef: spec.base ?? "main",
        headSha: pr.headSha(),
        isDraft: spec.draft === true,
        issueId: first ? origin.issueId : null,
        runId: first ? origin.runId : null,
        owned: spec.owned === true,
        // Los padres van antes en `specs`: su fila ya existe.
        parents: (spec.parents ?? []).map((parent) => ids.get(parent)!),
      }),
    );
  }

  const ref = (number: number) => ({ account, repo: sim.repo, number });
  for (const [index] of specs.entries()) await client.prs.refresh(ref(index + 1));
  // El hold es del usuario: se marca por la API, como lo haría la app.
  await client.prs.setHold({ ref: ref(specs.findIndex((s) => s.head === "radix-tooltips") + 1), hold: true });
  const local = seedPr(store, {
    repoId, number: null, state: "local", headRef: "engine-rules-docs", baseRef: "engine-rules",
    title: "Documentar las reglas de boundaries", parents: [ids.get("engine-rules")!],
    body: "## Qué cambia\n\n- Agrega `Boundaries::RulesService` con una regla por engine.\n- Documenta las reglas en `docs/boundaries.md`.\n\n## Cómo probarlo\n\n```\nbin/rails runner 'Boundaries::RulesService.new.rule_0(\"core\")'\n```\n",
    issueId: origin.issueId, runId: origin.runId,
  });
  seedPr(store, {
    repoId, number: null, state: "local", headRef: "engine-rules-rollout", baseRef: "engine-rules-docs",
    title: "Preparar el despliegue de las reglas", parents: [local],
  });
}

/** Un servicio Ruby de `n` métodos: largo para probar el scroll y con sintaxis para el color por lenguaje. */
const rubyService = (n: number, extra = "") =>
  [
    "# frozen_string_literal: true",
    "",
    "module Boundaries",
    "  # Reglas de qué engine puede llamar a cuál.",
    "  class RulesService",
    ...Array.from({ length: n }, (_, i) => [`    def rule_${i}(engine)`, `      return :allowed if engine == "core" # regla ${i}${extra}`, `      raise ArgumentError, "engine #{engine} no puede llamar a rule_${i}"`, "    end", ""]).flat(),
    "  end",
    "end",
    "",
  ].join("\n");

/**
 * Las branches de los dos PRs locales del escenario (`engine-rules-docs` sobre `engine-rules` y `engine-rules-rollout` sobre
 * ella), que existen solo en el repo de la máquina, como las deja `pr.publish` en modo local: así la vista del PR local
 * tiene commits y diff que mostrar. La primera tiene tres commits: un servicio Ruby largo, su doc y un cambio al servicio.
 */
export function seedLocalPrBranches(repo: TempGitRepo): void {
  const commit = (files: Record<string, string>, message: string) => {
    for (const [path, content] of Object.entries(files)) {
      mkdirSync(dirname(join(repo.dir, path)), { recursive: true });
      writeFileSync(join(repo.dir, path), content);
    }
    repo.git("add", "--all");
    repo.git("commit", "--quiet", "--message", message);
  };
  repo.git("checkout", "--quiet", "-b", "engine-rules-docs", "engine-rules");
  commit({ "app/services/boundaries/rules_service.rb": rubyService(40) }, "feat(boundaries): servicio de reglas entre engines");
  commit({ "docs/boundaries.md": "# Reglas de boundaries\n\n- Un engine solo llama a `core`.\n- Lo demás pasa por un puerto.\n" }, "docs(boundaries): documentar las reglas");
  commit({ "app/services/boundaries/rules_service.rb": rubyService(40, " (revisada)") }, "refactor(boundaries): anotar las reglas revisadas\n\nCada regla dice que ya se revisó.");
  repo.git("checkout", "--quiet", "-b", "engine-rules-rollout");
  commit({ "config/rollout.yml": "boundaries:\n  enabled: true\n  engines:\n    - core\n    - payments\n" }, "chore(boundaries): rollout de las reglas");
  repo.git("checkout", "--quiet", "main");
}

/**
 * Registra el worktree de cada PR del escenario (sin carpeta: se crea al tomarlo), como lo dejan `pr.publish` y los
 * stacks locales. Sin esto `workspace.attach` y `workspace.acquire` toman sus branches por del usuario (existen en el repo
 * y Clanker Yard no las creó) y el chat no podría aplicar una propuesta en el demo. Va después de `seedPrs`.
 */
export function adoptPrBranches({ store, repo, repoId, dataDir }: { store: Store; repo: TempGitRepo; repoId: RepoId; dataDir: string }): void {
  const rows = store.db.$client.prepare("SELECT head_ref AS branch, base_ref AS base, state FROM pull_requests WHERE repo_id = ?").all(repoId) as { branch: string; base: string; state: string }[];
  const insert = store.db.$client.prepare(
    "INSERT INTO workspaces (id, repo_id, path, branch, base_ref, base_sha, head_sha, remote_sha, state) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'idle')",
  );
  const setHead = store.db.$client.prepare("UPDATE pull_requests SET head_sha = ? WHERE repo_id = ? AND head_ref = ? AND (head_sha IS NULL OR head_sha = '')");
  for (const { branch, base, state } of rows) {
    const head = repo.git("rev-parse", `refs/heads/${branch}`);
    setHead.run(head, repoId, branch);
    const baseSha = repo.git("merge-base", `refs/heads/${base}`, head);
    insert.run(newId("ws"), repoId, join(dataDir, "worktrees", repoId, branch), branch, base, baseSha, head, state === "local" ? null : head);
  }
}
import { execFile } from "node:child_process";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { promisify } from "node:util";
import type { ArtifactKind, Brief, IssueDetail, IssueRef, Report } from "@clanker/api";
import type { Artifacts } from "../artifacts/artifacts";
import type { WorkspaceLease, Workspaces } from "../workspaces/workspaces";

const execFileAsync = promisify(execFile);

/** Carpeta de los artefactos dentro del worktree; el brief los cita con rutas relativas a él. */
export const RUN_DIR = ".clanker-run";

export const MAX_CRITERIA = 5;
export const MAX_LEARNINGS = 10;
const MAX_CRITERION_CHARS = 200;

/** Un reporte de una ronda anterior, para que el agente lo lea del disco. */
export interface PreviousReport {
  round: number;
  role: string;
  report: Report;
}

export interface BriefRequest {
  lease: WorkspaceLease;
  run: Brief["run"];
  mode: string;
  /** Tal como la devuelve `Tracker.getIssue`. Sin issue (un PR sin issue) no hay `issue.md`. */
  issue?: IssueDetail;
  reports?: PreviousReport[];
  /**
   * El `snapshot` que devolvió la ronda anterior. Con él se escribe `diff-round.patch`; sin él (la
   * primera ronda) ese archivo no existe.
   */
  since?: string;
  /** Aprobados del proyecto. Pasan los primeros `MAX_LEARNINGS`. */
  learnings?: string[];
  /** Lo propio del brief del modo; lo valida `Agents`. */
  payload?: unknown;
}

export interface PreparedBrief {
  brief: Brief;
  /**
   * Un árbol de git con el estado completo del worktree (commits, cambios y archivos nuevos). Es el
   * `since` de la ronda siguiente. No pertenece a ninguna branch: git lo borra solo si nadie lo usa.
   */
  snapshot: string;
}

/** Un hunk del diff: `h12 app/models/x.rb @@ -10,6 +10,9 @@`. */
export interface Hunk {
  id: string;
  path: string;
  header: string;
}

export interface Briefs {
  /**
   * Deja en `<worktree>/.clanker-run/` lo que el agente lee si lo necesita (`issue.md`, `diff.patch`,
   * `diff-round.patch`, `hunks.json` y los reportes previos) y arma el `Brief` que cita esas rutas.
   * Cada archivo también se guarda en `artifacts`, que es la fuente de verdad, con una ref a la corrida.
   * La carpeta queda en `.git/info/exclude`: nunca entra a un commit.
   */
  prepare(request: BriefRequest): Promise<PreparedBrief>;
}

export function createBriefs({
  workspaces,
  artifacts,
}: {
  workspaces: Workspaces;
  artifacts: Artifacts;
}): Briefs {
  return {
    async prepare({ lease, run, mode, issue, reports = [], since, learnings, payload }) {
      workspaces.validate(lease);
      const cwd = lease.path;
      await excludeRunDir(cwd);

      const snapshot = await snapshotTree(cwd);
      const diff = await diffBetween(cwd, lease.baseSha, snapshot);

      const files = new Map<string, { content: string; kind: ArtifactKind; mime?: string }>();
      const paths: Record<string, string> = {};
      const add = (key: string, name: string, kind: ArtifactKind, content: string, mime?: string) => {
        files.set(name, { content, kind, mime });
        paths[key] = `${RUN_DIR}/${name}`;
      };

      if (issue) add("issue", "issue.md", "snapshot", issueMarkdown(issue));
      add("diff", "diff.patch", "snapshot", diff);
      if (since !== undefined) {
        add("diffRound", "diff-round.patch", "snapshot", await diffBetween(cwd, since, snapshot));
      }
      add("hunks", "hunks.json", "snapshot", `${JSON.stringify(listHunks(diff), null, 2)}\n`, "application/json");
      for (const { round, role, report } of reports) {
        const name = `r${round}-${role}`;
        add(`report-${name}`, `reports/${name}.json`, "report", `${JSON.stringify(report, null, 2)}\n`, "application/json");
      }

      const dir = join(cwd, RUN_DIR);
      // Un diff-round.patch de la ronda anterior no puede quedar pasando por el de esta.
      if (since === undefined) rmSync(join(dir, "diff-round.patch"), { force: true });
      for (const [name, file] of files) writeFile(join(dir, name), file.content);

      const brief: Brief = {
        run,
        ...(issue && {
          issue: { key: issue.ref.key, title: issue.title, criteria: acceptanceCriteria(issue.body) },
        }),
        worktree: cwd,
        base: `origin/${lease.baseRef}`,
        mode,
        artifacts: paths,
        ...(learnings?.length && { learnings: learnings.slice(0, MAX_LEARNINGS) }),
        payload,
      };

      const owner = (role: string) => ({ type: "run", id: run.id, role: `r${run.round}/${role}` });
      for (const [name, file] of files) {
        const hash = artifacts.put(file.content, file.kind, { mime: file.mime });
        artifacts.ref(hash, owner(name));
      }
      artifacts.ref(
        artifacts.put(JSON.stringify(brief), "brief", { mime: "application/json" }),
        owner("brief"),
      );

      return { brief, snapshot };
    },
  };
}

/**
 * Los criterios de aceptación: los ítems de lista bajo un encabezado o rótulo "Criterios de
 * aceptación" (o "Acceptance criteria"), hasta el siguiente rótulo. Son los primeros
 * `MAX_CRITERIA`, acortados: el resto está en `issue.md`.
 */
export function acceptanceCriteria(body: string): string[] {
  const criteria: string[] = [];
  let inSection = false;
  for (const line of body.split("\n")) {
    const text = line.trim();
    if (/^(#+\s*)?(\*\*|__)?\s*(criterios de aceptaci[oó]n|acceptance criteria)/i.test(text)) {
      inSection = true;
    } else if (inSection) {
      const item = /^(?:[*+-]|\d+[.)])\s+(?:\[[ xX]\]\s+)?(.+)$/.exec(text);
      if (item) criteria.push(shorten(item[1]!));
      else if (text !== "") break;
    }
    if (criteria.length === MAX_CRITERIA) break;
  }
  return criteria;
}

function shorten(text: string): string {
  return text.length <= MAX_CRITERION_CHARS ? text : `${text.slice(0, MAX_CRITERION_CHARS - 1)}…`;
}

/** Cuerpo, relaciones y comentarios: lo que el brief no lleva de la issue. */
function issueMarkdown(issue: IssueDetail): string {
  const relations = (
    [
      ["Bloquea", issue.relations.blocks],
      ["Bloqueada por", issue.relations.blockedBy],
      ["Relacionada con", issue.relations.related],
    ] as [string, IssueRef[]][]
  )
    .filter(([, list]) => list.length > 0)
    .map(([label, list]) => `- ${label}: ${list.map((r) => r.key).join(", ")}`);
  const comments = issue.comments.map(
    (c) => `### ${c.author.name} · ${new Date(c.createdAt).toISOString()}\n\n${c.text}`,
  );
  return [
    `# ${issue.ref.key} ${issue.title}`,
    `${issue.ref.url}\nEstado: ${issue.rawStatus}${issue.labels.length ? `\nLabels: ${issue.labels.join(", ")}` : ""}`,
    issue.body.trim() || "(sin descripción)",
    ...(relations.length ? ["## Relaciones", relations.join("\n")] : []),
    ...(comments.length ? ["## Comentarios", ...comments] : []),
  ].join("\n\n") + "\n";
}

/**
 * Un id por hunk, en el orden del patch: `h1`, `h2`... El mismo diff da siempre los mismos ids.
 * Los archivos binarios no tienen hunks.
 */
export function listHunks(diff: string): Hunk[] {
  const hunks: Hunk[] = [];
  let path: string | undefined;
  let oldPath: string | undefined;
  // Las líneas `---` y `+++` solo son encabezado antes del primer `@@`: dentro de un hunk, `--- x` es la línea `-- x` borrada.
  let inHunk = false;
  for (const line of diff.split("\n")) {
    if (line.startsWith("diff --git ")) {
      path = oldPath = undefined;
      inHunk = false;
    } else if (!inHunk && line.startsWith("--- ")) {
      oldPath = stripPrefix(line.slice(4), "a/");
    } else if (!inHunk && line.startsWith("+++ ")) {
      path = stripPrefix(line.slice(4), "b/") ?? oldPath;
    } else if (line.startsWith("@@") && path !== undefined) {
      inHunk = true;
      const header = /^(@@ -\S+ \+\S+ @@)/.exec(line);
      if (header) hunks.push({ id: `h${hunks.length + 1}`, path, header: header[1]! });
    }
  }
  return hunks;
}

/**
 * `undefined` si el nombre no lleva el prefijo: es el "no existe" de un archivo creado o borrado. Git
 * agrega un tab tras los nombres con espacios.
 */
function stripPrefix(name: string, prefix: string): string | undefined {
  const clean = name.replace(/\t.*$/, "");
  return clean.startsWith(prefix) ? clean.slice(prefix.length) : undefined;
}

async function excludeRunDir(cwd: string): Promise<void> {
  // En un worktree `info/exclude` es el del repo común: vale para todos sus worktrees.
  const exclude = resolve(cwd, (await git(cwd, ["rev-parse", "--git-path", "info/exclude"])).trim());
  const entry = `/${RUN_DIR}/`;
  const current = existsSync(exclude) ? readFileSync(exclude, "utf8") : "";
  if (current.split("\n").includes(entry)) return;
  mkdirSync(dirname(exclude), { recursive: true });
  appendFileSync(exclude, `${current === "" || current.endsWith("\n") ? "" : "\n"}${entry}\n`);
}

/**
 * El árbol del worktree tal como está (commits, cambios y archivos nuevos), sin tocar su index real:
 * se parte de un index temporal con `HEAD` y se hace `add --all`. No se copia el index real: sin los
 * datos de stat git rehashea todo, pero un cambio del mismo tamaño dentro del mismo segundo del
 * checkout (el mtime de git en macOS es de un segundo) no se le puede escapar.
 */
async function snapshotTree(cwd: string): Promise<string> {
  const tmp = mkdtempSync(join(tmpdir(), "clanker-index-"));
  try {
    const env = { GIT_INDEX_FILE: join(tmp, "index") };
    await git(cwd, ["read-tree", "HEAD"], env);
    await git(cwd, ["add", "--all"], env);
    return (await git(cwd, ["write-tree"], env)).trim();
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

/** Con prefijos `a/` `b/` fijos y sin renames: el patch no depende de la config de git de quien lo corra. */
async function diffBetween(cwd: string, from: string, to: string): Promise<string> {
  return git(cwd, [
    "-c",
    "core.quotePath=false",
    "diff",
    "--no-color",
    "--no-ext-diff",
    "--no-renames",
    "--binary",
    "--src-prefix=a/",
    "--dst-prefix=b/",
    from,
    to,
  ]);
}

function writeFile(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
}

/** Sin `trimEnd`, a diferencia de `Workspaces.git`: a un patch sin su salto final `git apply` lo rechaza. */
async function git(cwd: string, args: string[], env: Record<string, string> = {}): Promise<string> {
  try {
    const { stdout } = await execFileAsync("git", args, {
      cwd,
      env: { ...process.env, ...env },
      encoding: "utf8",
      maxBuffer: 256 * 1024 * 1024,
    });
    return stdout;
  } catch (error) {
    const { stderr } = error as { stderr?: string };
    throw new Error(`git ${args.join(" ")} falló en ${cwd}: ${stderr?.trim() ?? String(error)}`, {
      cause: error,
    });
  }
}

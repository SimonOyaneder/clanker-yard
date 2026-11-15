/** Lo que `clanker import legacy` saca del `state.md` de un proyecto del clanker-loop. */
export interface LegacyState {
  /** El título sin el sufijo ` · clanker-loop`. */
  name: string;
  /** La URL del proyecto en Linear de la cabecera; `undefined` si el proyecto no tiene uno. */
  trackerUrl?: string;
  /** Los repos de la cabecera, en orden, con su ruta si la trae. */
  repos: { name: string; path?: string }[];
  /** `parallel: N` de la cabecera; `undefined` si no lo fija. */
  parallel?: number;
  /** El texto de `## Brief`; `undefined` si la sección falta o está vacía. */
  brief?: string;
  history: LegacyHistoryRow[];
  /** Las viñetas de `## Decisiones y aprendizajes`. */
  learnings: string[];
  /** Las viñetas de `## Decisiones a revisar`. */
  reviewNotes: string[];
  /** Las viñetas de `## Omitidas`: desvíos que ya se hicieron. */
  skipped: string[];
}

/** Una fila de la tabla `## Historial`: una issue y su PR. */
export interface LegacyHistoryRow {
  /** `ENG-9171`; con `ENG-9130 (tf)` es `ENG-9130` y `variant` es `tf`. */
  key: string;
  variant?: string;
  /** La celda `estado` entera (`listo (sin squash)`). */
  status: string;
  /** `mergeado`, `cerrado`, `listo`...: la celda sin lo que va entre paréntesis. */
  state: string;
  /** `undefined` si la fila no tiene PR (`-`). Sin repo en la celda (`#4244`), es el único repo del proyecto. */
  pr?: { repo?: string; number: number };
  /** `undefined` si la celda no es una branch (`(worktree api-eng-9088-x)`). */
  branch?: string;
}

/** Lee un `state.md`. Lanza si no tiene título o `## Historial`: no es el archivo de un proyecto del loop. */
export function parseLegacyState(text: string): LegacyState {
  const lines = text.split("\n");
  const title = /^# (.+?)(?: · clanker-loop)?\s*$/.exec(lines[0] ?? "");
  if (!title) throw new Error("state.md: la primera línea debe ser el título `# <proyecto> · clanker-loop`.");

  // La cabecera es todo lo que va antes del primer `## `.
  const firstSection = lines.findIndex((line) => line.startsWith("## "));
  const header = lines.slice(1, firstSection === -1 ? undefined : firstSection);
  const fields = (header[0] ?? "").split(" · ");
  const field = (label: string) => fields.find((f) => f.startsWith(`${label}: `))?.slice(label.length + 2).trim();

  const project = field("proyecto");
  const reposField = field("repos");
  const brief = sectionOf(lines, "Brief").join("\n").trim();
  const parallel = /^parallel:\s*(\d+)/m.exec(header.join("\n"))?.[1];

  return {
    name: title[1]!,
    ...(project?.startsWith("http") ? { trackerUrl: project.split(/\s/)[0] } : {}),
    repos: reposField === undefined ? [] : parseRepos(reposField),
    ...(parallel === undefined || Number(parallel) < 1 ? {} : { parallel: Number(parallel) }),
    ...(brief === "" ? {} : { brief }),
    history: parseHistory(lines),
    learnings: bulletsOf(lines, "Decisiones y aprendizajes"),
    reviewNotes: bulletsOf(lines, "Decisiones a revisar"),
    skipped: bulletsOf(lines, "Omitidas"),
  };
}

/** Las líneas de `## <heading>`, hasta la próxima sección. Vacío si la sección no está. */
function sectionOf(lines: string[], heading: string): string[] {
  const start = lines.findIndex((line) => line.trim() === `## ${heading}`);
  if (start === -1) return [];
  const rest = lines.slice(start + 1);
  const end = rest.findIndex((line) => line.startsWith("## "));
  return end === -1 ? rest : rest.slice(0, end);
}

/** Cada `- ` de la sección es una viñeta; una línea con sangría la continúa. */
function bulletsOf(lines: string[], heading: string): string[] {
  const bullets: string[] = [];
  for (const line of sectionOf(lines, heading)) {
    if (line.startsWith("- ")) bullets.push(line.slice(2).trim());
    else if (/^\s+\S/.test(line) && bullets.length > 0) bullets[bullets.length - 1] += `\n${line.trim()}`;
  }
  return bullets.filter((bullet) => bullet !== "");
}

/** `api (/ruta/api), dashboard, infra-tf (sub-issues de ENG-1)`: los paréntesis solo cuentan si empiezan con `/`. */
function parseRepos(list: string): { name: string; path?: string }[] {
  const items: string[] = [];
  let depth = 0;
  let item = "";
  for (const char of list) {
    if (char === "(") depth++;
    if (char === ")") depth--;
    if (char === "," && depth === 0) {
      items.push(item);
      item = "";
    } else item += char;
  }
  items.push(item);

  return items.flatMap((raw) => {
    const match = /^\s*([\w.-]+)\s*(?:\((.*)\))?\s*$/.exec(raw);
    if (!match) return [];
    const path = match[2]?.trim();
    return [{ name: match[1]!, ...(path?.startsWith("/") ? { path } : {}) }];
  });
}

function parseHistory(lines: string[]): LegacyHistoryRow[] {
  const start = lines.findIndex((line) => line.trim() === "## Historial");
  if (start === -1) throw new Error("state.md: falta la sección `## Historial`.");
  const rows: LegacyHistoryRow[] = [];
  for (const line of lines.slice(start + 1)) {
    if (line.startsWith("## ")) break;
    // Las notas sueltas bajo la tabla no son filas: solo cuentan las de `| ENG-123 | ... |`.
    if (!line.startsWith("|")) continue;
    const cells = line.split("|").slice(1, -1).map((cell) => cell.trim());
    const id = /^([A-Z][A-Z0-9]*-\d+)(?:\s*\(([^)]*)\))?$/.exec(cells[0] ?? "");
    if (!id || cells.length < 5) continue;
    const status = cells[1]!;
    const pr = /^(?:([\w.-]+))?#(\d+)/.exec(cells[3]!);
    const branch = /^[\w./]+(?:-[\w./]+)*/.exec(cells[4]!)?.[0];
    rows.push({
      key: id[1]!,
      ...(id[2] === undefined ? {} : { variant: id[2] }),
      status,
      state: status.replace(/\s*\(.*$/, ""),
      ...(pr ? { pr: { ...(pr[1] === undefined ? {} : { repo: pr[1] }), number: Number(pr[2]) } } : {}),
      ...(branch === undefined ? {} : { branch }),
    });
  }
  return rows;
}

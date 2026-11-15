import { readdirSync, readFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { parse as parseYaml } from "yaml";
import * as z from "zod";

const Wildcard = z.literal("*");

const ScriptEvent = z.union([
  z.strictObject({ at: z.number().nonnegative(), text: z.string() }),
  z.strictObject({
    at: z.number().nonnegative(),
    tool: z.string(),
    input: z.record(z.string(), z.unknown()).optional(),
  }),
  z.strictObject({
    at: z.number().nonnegative(),
    usage: z.strictObject({
      /** Se graba para quien lea el guion; `Usage` no lleva el modelo. */
      model: z.string().optional(),
      in: z.number().nonnegative(),
      out: z.number().nonnegative(),
      cacheWrite: z.number().nonnegative().default(0),
      cacheRead: z.number().nonnegative().default(0),
      costUsd: z.number().nonnegative().default(0),
    }),
  }),
]);
export type ScriptEvent = z.infer<typeof ScriptEvent>;

const Outcome = z.strictObject({ text: z.string().optional(), structured: z.unknown().optional() });

const ScriptResult = z.discriminatedUnion("status", [
  Outcome.extend({ status: z.literal("success") }),
  Outcome.extend({ status: z.literal("error_max_turns"), message: z.string().optional() }),
  Outcome.extend({ status: z.literal("error_max_budget_usd"), message: z.string().optional() }),
  z.strictObject({ status: z.literal("crash"), at: z.number().nonnegative() }),
]);
export type ScriptResult = z.infer<typeof ScriptResult>;

const ScriptFile = z.strictObject({
  match: z
    .strictObject({
      role: z.string().optional(),
      mode: z.string().optional(),
      round: z.union([z.int().nonnegative(), Wildcard]).optional(),
      issue: z.string().optional(),
    })
    .default({}),
  speed: z.number().positive().default(1),
  events: z.array(ScriptEvent).default([]),
  effects: z.array(z.strictObject({ apply: z.string() })).default([]),
  run: z
    .record(
      z.string(),
      z.array(z.strictObject({ ok: z.boolean(), extract: z.string().optional() })),
    )
    .default({}),
  result: ScriptResult,
});

/** Lo que la receta devolvió en una llamada guionada; `extract` es el texto del archivo del guion. */
export interface RecipeResult {
  ok: boolean;
  extract?: string;
}

export interface Script {
  /** Ruta del guion, para los mensajes de error. */
  file: string;
  /** `"*"` acepta cualquier valor. */
  match: { role: string; mode: string; round: number | "*"; issue: string };
  speed: number;
  /** Ordenados por `at`. */
  events: ScriptEvent[];
  /** Rutas absolutas de los patches a aplicar al worktree. */
  patches: string[];
  run: Record<string, RecipeResult[]>;
  result: ScriptResult;
}

/** `<rol>.r<n>.yaml`, con una etiqueta opcional (`dev.r1.plan.yaml`) cuando un rol tiene varios pasos en la misma ronda. */
const FILE_NAME = /^(?<role>[^.]+)\.r(?<round>\d+)(?:\.[^.]+)?\.yaml$/;

/** Lee todos los `*.yaml` de cada carpeta. El rol y la ronda salen del nombre, y `match` los puede pisar. */
export function loadScripts(dirs: readonly string[]): Script[] {
  return dirs.flatMap((dir) => {
    let names: string[];
    try {
      names = readdirSync(dir).filter((name) => name.endsWith(".yaml")).sort();
    } catch (error) {
      throw new Error(`No se pudo leer la carpeta de guiones ${dir}: ${(error as Error).message}`, {
        cause: error,
      });
    }
    return names.map((name) => loadScript(join(dir, name)));
  });
}

function loadScript(file: string): Script {
  const named = FILE_NAME.exec(basename(file))?.groups;
  if (!named?.role || !named.round) {
    throw new Error(`El guion ${file} no se llama <rol>.r<n>.yaml (ni <rol>.r<n>.<etiqueta>.yaml).`);
  }
  const parsed = ScriptFile.safeParse(parseYamlFile(file));
  if (!parsed.success) {
    throw new Error(`El guion ${file} no es válido:\n${z.prettifyError(parsed.error)}`);
  }
  const dir = resolve(file, "..");
  const { match } = parsed.data;
  return {
    file,
    match: {
      role: match.role ?? named.role,
      mode: match.mode ?? "*",
      round: match.round ?? Number(named.round),
      issue: match.issue ?? "*",
    },
    speed: parsed.data.speed,
    events: [...parsed.data.events].sort((a, b) => a.at - b.at),
    patches: parsed.data.effects.map((effect) => existing(file, resolve(dir, effect.apply))),
    run: Object.fromEntries(
      Object.entries(parsed.data.run).map(([command, results]) => [
        command,
        results.map(({ ok, extract }) => ({
          ok,
          ...(extract === undefined ? {} : { extract: readFileSync(existing(file, resolve(dir, extract)), "utf8") }),
        })),
      ]),
    ),
    result: parsed.data.result,
  };
}

function parseYamlFile(file: string): unknown {
  try {
    return parseYaml(readFileSync(file, "utf8"));
  } catch (error) {
    throw new Error(`No se pudo leer el guion ${file}: ${(error as Error).message}`, { cause: error });
  }
}

/** Un archivo que el guion cita y no existe es un error del fixture: se detecta al cargar, no a mitad de un flujo. */
function existing(script: string, path: string): string {
  try {
    readFileSync(path);
  } catch {
    throw new Error(`El guion ${script} cita ${path}, que no existe.`);
  }
  return path;
}

export interface ScriptQuery {
  role: string;
  mode: string;
  round: number;
  /** Key de la issue del brief, si la trae. */
  issue: string | undefined;
}

const FIELDS = ["role", "mode", "round", "issue"] as const;

function specificity(script: Script): number {
  return FIELDS.filter((field) => script.match[field] !== "*").length;
}

/** Gana el guion que fija más campos de `match`; un empate es un error, nunca una elección silenciosa. */
export function pickScript(scripts: readonly Script[], query: ScriptQuery): Script {
  const matching = scripts.filter((script) =>
    FIELDS.every((field) => script.match[field] === "*" || script.match[field] === query[field]),
  );
  const best = Math.max(0, ...matching.map(specificity));
  const winners = matching.filter((script) => specificity(script) === best);
  const [winner, second] = winners;
  if (!winner) {
    const forRole = scripts.filter((s) => s.match.role === query.role || s.match.role === "*");
    throw new Error(
      `no hay fixture para ${query.role} r${query.round} (modo ${query.mode}${query.issue ? `, issue ${query.issue}` : ""}). ` +
        (forRole.length === 0
          ? `No hay guiones para ese rol.`
          : `Guiones de ese rol: ${forRole.map((s) => basename(s.file)).join(", ")}.`),
    );
  }
  if (second) {
    throw new Error(
      `${winners.length} guiones empatan para ${query.role} r${query.round} (modo ${query.mode}): ${winners.map((s) => s.file).join(", ")}. Haz uno más específico con match.`,
    );
  }
  return winner;
}

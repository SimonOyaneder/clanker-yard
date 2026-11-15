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
    /** Lo que la herramienta devolvió: queda en el transcript (`transcripts` del runtime), no en los eventos. */
    output: z.string().optional(),
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
  /** El proceso murió sin `result`: el run rechaza con `message` (el error real trae la cola del stderr de claude). */
  z.strictObject({ status: z.literal("crash"), at: z.number().nonnegative(), message: z.string().optional() }),
  /** Fallos que el runtime reporta como resultado (no rechaza), con el texto accionable que dio. */
  Outcome.extend({
    status: z.enum(["error", "login_expired", "quota_exhausted"]),
    message: z.string().optional(),
    resetsAt: z.number().optional(),
  }),
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
  /** Cuántas veces sirve este guion; después se salta y gana el siguiente que calce (o un guion sin `times`). */
  times: z.int().positive().optional(),
  events: z.array(ScriptEvent).default([]),
  effects: z
    .array(z.union([z.strictObject({ apply: z.string() }), z.strictObject({ write: z.strictObject({ path: z.string(), content: z.string() }) })]))
    .default([]),
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
  times: number | undefined;
  /** Ordenados por `at`. */
  events: ScriptEvent[];
  /** Rutas absolutas de los patches a aplicar al worktree. */
  patches: string[];
  /** Archivos a escribir enteros en el worktree (`path` relativo a él), después de los patches: para resolver un conflicto, cuyas marcas un patch no puede citar. */
  writes: { path: string; content: string }[];
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
    times: parsed.data.times,
    events: [...parsed.data.events].sort((a, b) => a.at - b.at),
    patches: parsed.data.effects.flatMap((effect) => ("apply" in effect ? [existing(file, resolve(dir, effect.apply))] : [])),
    writes: parsed.data.effects.flatMap((effect) => ("write" in effect ? [effect.write] : [])),
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

/**
 * Gana el guion que fija más campos de `match`. Entre los igual de específicos, primero los que tienen
 * `times` y aún les quedan usos (en orden de nombre de archivo): así una serie de respuestas distintas a
 * la misma pregunta (la ronda 1 de un fix que llega tres veces) se escribe como guiones con `times: 1`.
 * Dos guiones sin `times` igual de específicos son un error, nunca una elección silenciosa.
 */
export function pickScript(scripts: readonly Script[], query: ScriptQuery, used: ReadonlyMap<Script, number> = new Map()): Script {
  const matching = scripts.filter(
    (script) =>
      FIELDS.every((field) => script.match[field] === "*" || script.match[field] === query[field]) &&
      (script.times === undefined || (used.get(script) ?? 0) < script.times),
  );
  const best = Math.max(0, ...matching.map(specificity));
  const winners = matching.filter((script) => specificity(script) === best);
  const limited = winners.find((script) => script.times !== undefined);
  if (limited) return limited;
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

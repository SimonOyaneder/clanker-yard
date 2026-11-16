import { mkdirSync, realpathSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { Document } from "yaml";
import { messageOf } from "../../errors/format";
import { diffBetween, snapshotTree } from "../../git/tree";
import { briefOfMessage } from "../brief";
import type { AgentEvent, RunResult, RunSpec } from "../runtime";

/**
 * Grabar una corrida real como guion del runtime fake (`CLANKER_RECORD=<dir>`, `docs/design.html#d-agents`).
 *
 * Por cada run (start o resume) deja `<dir>/<issue>/<rol>.r<ronda>.<modo>.yaml` con el formato que lee
 * `createFakeRuntime`: eventos (texto, herramientas con su entrada y salida, uso por turno), el resultado
 * y, en `patches/`, lo que el agente cambió en el worktree. Un mismo rol, ronda y modo grabado otra vez
 * (otro intento, otro resume) queda como `<modo>02`, `<modo>03`...; todos con `times: 1`, así el fake los
 * sirve en el orden en que ocurrieron.
 *
 * Los guiones se commitean como fixtures: nada que parezca un secreto ni una ruta de la máquina llega
 * al archivo (`createScrubber`). Las salidas de herramientas se recortan a `MAX_OUTPUT_CHARS`.
 * No graba `run:` (lo que respondieron los checks de la receta): lo corre el core, no el agente.
 */
export interface RecordingOptions {
  /** `CLANKER_RECORD`. */
  dir: string;
  spec: RunSpec;
  /** El mensaje del run: de su brief salen la issue, el modo y la ronda. */
  prompt: string;
  /** `CLANKER_HOME`: se reemplaza por `<clanker-home>`. */
  home: string;
  /** Valores exactos que no pueden quedar en el guion (las credenciales del run). */
  secrets: readonly string[];
}

export interface Recording {
  /** Cada mensaje del stream de Claude, en orden. */
  message(message: SDKMessage): void;
  /** El uso por turno y los restos que el adapter emite. */
  usage(event: Extract<AgentEvent, { type: "usage" | "usage_remainder" }>): void;
  /** Escribe el guion. Un `result` que rechazó (el proceso murió) se graba como `crash`. */
  finish(outcome: { result: RunResult } | { crash: unknown }): Promise<void>;
}

export const MAX_OUTPUT_CHARS = 2000;

/** Los tiempos reales se reproducen 20 veces más rápido (el ejemplo de `d-agents`). */
const SPEED = 20;

type TokenCounts = { in: number; out: number; cacheWrite: number; cacheRead: number };
interface UsageEntry {
  at: number;
  usage: TokenCounts & { model: string; costUsd?: number };
}
type Entry = { at: number; text: string } | { at: number; tool: string; input?: unknown; output?: string } | UsageEntry;

/**
 * Empieza a grabar: toma el estado del worktree para sacar al final el patch del agente. Rechaza si el
 * mensaje no trae brief o el cwd no es un repo git: sin eso no hay a dónde ni cómo grabar, y es mejor
 * enterarse antes de gastar el run.
 */
export async function startRecording(options: RecordingOptions): Promise<Recording> {
  const { spec } = options;
  const brief = briefOfMessage(options.prompt);
  if (!brief) {
    throw new Error(
      `CLANKER_RECORD: el mensaje del rol "${spec.role}" no trae el brief en JSON al final, así que no se sabe qué guion grabar.`,
    );
  }
  const before = await snapshotTree(spec.cwd);
  const scrub = createScrubber({ cwd: spec.cwd, home: options.home, secrets: options.secrets });
  const started = Date.now();
  const elapsed = () => Date.now() - started;

  const entries: Entry[] = [];
  const tools = new Map<string, Extract<Entry, { tool: string }>>();

  return {
    message(message) {
      if (message.type === "assistant") {
        for (const block of message.message.content) {
          if (block.type === "text" && block.text !== "") {
            entries.push({ at: elapsed(), text: block.text });
          } else if (block.type === "tool_use") {
            // El reporte ya va entero en `result.structured`.
            const entry = { at: elapsed(), tool: block.name, ...(block.name === STRUCTURED_OUTPUT ? {} : { input: block.input }) };
            tools.set(block.id, entry);
            entries.push(entry);
          }
        }
      } else if (message.type === "user") {
        const content = message.message.content;
        for (const block of Array.isArray(content) ? content : []) {
          if (block.type !== "tool_result") continue;
          const entry = tools.get(block.tool_use_id);
          if (entry && entry.tool !== STRUCTURED_OUTPUT) entry.output = clip(textOf(block.content));
        }
      }
    },

    usage(event) {
      if (event.type === "usage") {
        const { usage } = event;
        entries.push({
          at: elapsed(),
          usage: {
            model: event.model ?? spec.model,
            in: usage.tokensIn,
            out: usage.tokensOut,
            cacheWrite: usage.tokensCacheWrite,
            cacheRead: usage.tokensCacheRead,
          },
        });
        return;
      }
      // Igual que el core: el resto se suma al último turno de ese modelo, o es un turno nuevo.
      const last = entries.findLast((e): e is UsageEntry => "usage" in e && e.usage.model === event.model);
      const { tokensIn, tokensOut, tokensCacheWrite, tokensCacheRead } = event.tokens;
      if (last) {
        last.usage.in += tokensIn;
        last.usage.out += tokensOut;
        last.usage.cacheWrite += tokensCacheWrite;
        last.usage.cacheRead += tokensCacheRead;
      } else {
        entries.push({
          at: elapsed(),
          usage: { model: event.model, in: tokensIn, out: tokensOut, cacheWrite: tokensCacheWrite, cacheRead: tokensCacheRead },
        });
      }
    },

    async finish(outcome) {
      const at = elapsed();
      const crashed = "crash" in outcome;
      if (!crashed) putCost(entries, outcome.result.usage.costMicros / 1_000_000, { at, model: spec.model });

      // Antes de reservar el nombre: si el patch no se puede grabar, no queda un guion a medias.
      const patch = scrubPatch(await diffBetween(spec.cwd, before, await snapshotTree(spec.cwd)), scrub);
      const issueDir = join(options.dir, slug(brief.issue?.key ?? "sin-issue"));
      mkdirSync(join(issueDir, "patches"), { recursive: true });
      const name = claim(issueDir, `${slug(spec.role)}.r${brief.run.round}`, slug(brief.mode));
      if (patch !== "") writeFileSync(join(issueDir, "patches", `${name}.patch`), patch);

      const script = {
        match: { role: spec.role, mode: brief.mode, round: brief.run.round, issue: "*" },
        speed: SPEED,
        times: 1,
        events: entries.map((entry) => ("usage" in entry ? { at: entry.at, usage: withoutZeroCost(entry.usage) } : entry)),
        effects: patch === "" ? [] : [{ apply: `patches/${name}.patch` }],
        result: crashed
          ? { status: "crash", at, message: messageOf(outcome.crash) }
          : resultOf(outcome.result),
      };
      const doc = new Document(mapStrings(script, scrub));
      doc.commentBefore = " Grabado de una corrida real (CLANKER_RECORD). Revísalo antes de commitearlo como fixture.";
      writeFileSync(join(issueDir, `${name}.yaml`), doc.toString({ lineWidth: 0 }));
    },
  };
}

const STRUCTURED_OUTPUT = "StructuredOutput";

/** El costo del run no se reparte por turno (el real tampoco lo sabe): va entero en el último uso. */
function putCost(entries: Entry[], costUsd: number, empty: { at: number; model: string }): void {
  if (costUsd <= 0) return;
  const last = entries.findLast((e): e is UsageEntry => "usage" in e);
  if (last) last.usage.costUsd = costUsd;
  else entries.push({ at: empty.at, usage: { model: empty.model, in: 0, out: 0, cacheWrite: 0, cacheRead: 0, costUsd } });
}

function withoutZeroCost({ costUsd, ...rest }: UsageEntry["usage"]) {
  return costUsd === undefined ? rest : { ...rest, costUsd };
}

function resultOf(result: RunResult): Record<string, unknown> {
  const { status, text, structured, message, resetsAt } = result;
  return {
    status,
    ...(status === "success" && text !== "" ? { text } : {}),
    ...(structured === undefined ? {} : { structured }),
    ...(message === undefined ? {} : { message }),
    ...(resetsAt === undefined ? {} : { resetsAt }),
  };
}

/**
 * Reserva el nombre del guion sin pisar uno grabado antes (ni por otro run en paralelo): `<base>.<modo>.yaml`,
 * y si existe `<base>.<modo>02.yaml`, `03`... El orden alfabético es el orden en que el fake los sirve.
 */
function claim(dir: string, base: string, mode: string): string {
  for (let n = 1; ; n++) {
    const name = `${base}.${mode}${n === 1 ? "" : String(n).padStart(2, "0")}`;
    try {
      writeFileSync(join(dir, `${name}.yaml`), "", { flag: "wx" });
      return name;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
  }
}

function slug(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9_-]+/g, "-");
}

function textOf(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return JSON.stringify(content) ?? "";
  return content.map((block) => (block?.type === "text" ? String(block.text) : `[${String(block?.type)}]`)).join("\n");
}

function clip(text: string): string {
  return text.length <= MAX_OUTPUT_CHARS ? text : `${text.slice(0, MAX_OUTPUT_CHARS)}\n[recortado: ${text.length - MAX_OUTPUT_CHARS} caracteres más]`;
}

function mapStrings(value: unknown, f: (text: string) => string): unknown {
  if (typeof value === "string") return f(value);
  if (Array.isArray(value)) return value.map((item) => mapStrings(item, f));
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, mapStrings(item, f)]));
  }
  return value;
}

/**
 * Solo se limpian las líneas que el agente agregó: el contexto y las líneas borradas ya están en el repo
 * y tienen que seguir iguales para que `git apply` calce sobre el fixture. Una llave privada se reparte en
 * varias líneas que ninguna regla ve completas, así que se rechaza.
 */
function scrubPatch(patch: string, scrub: (text: string) => string): string {
  if (/^\+.*PRIVATE KEY-----/m.test(patch)) {
    throw new Error("CLANKER_RECORD: el agente dejó una llave privada en el worktree; no se grabó el patch ni el guion.");
  }
  return patch
    .split("\n")
    .map((line) => (line.startsWith("+") && !line.startsWith("+++") ? `+${scrub(line.slice(1))}` : line))
    .join("\n");
}

const SECRET = "[secreto]";

// Formas conocidas de credenciales; los valores exactos del run se limpian aparte.
const SECRET_PATTERNS: [RegExp, string][] = [
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, SECRET],
  [/\bsk-[A-Za-z0-9_-]{20,}/g, SECRET],
  [/\bgh[pousr]_[A-Za-z0-9]{20,}/g, SECRET],
  [/\bgithub_pat_[A-Za-z0-9_]{20,}/g, SECRET],
  [/\blin_(?:api|oauth)_[A-Za-z0-9]{20,}/g, SECRET],
  [/\bxox[abprs]-[A-Za-z0-9-]{10,}/g, SECRET],
  [/\bAKIA[0-9A-Z]{16}\b/g, SECRET],
  [/\b(Bearer|Basic) [A-Za-z0-9._~+/=-]{16,}/g, `$1 ${SECRET}`],
  [/(:\/\/)[^\s/@:]+:[^\s/@]+@/g, `$1${SECRET}@`],
  [/\b([A-Z0-9_]*(?:TOKEN|SECRET|PASSWORD|PASSWD|API_KEY|APIKEY|PRIVATE_KEY)[A-Z0-9_]*)=("[^"]*"|'[^']*'|\S+)/g, `$1=${SECRET}`],
  [/("[A-Za-z_]*(?:token|secret|password|api_key)[A-Za-z_]*"\s*:\s*)"[^"]*"/gi, `$1"${SECRET}"`],
];

/**
 * Lo que sale de la máquina en un guion: el worktree queda como ruta relativa (`app/models/x.rb`, como en
 * el ejemplo de `d-agents`), `CLANKER_HOME` como `<clanker-home>` y cualquier carpeta de usuario como `<home>`.
 */
export function createScrubber(options: { cwd: string; home: string; secrets: readonly string[] }): (text: string) => string {
  const exact = options.secrets.filter((secret) => secret.length >= 8);
  const worktrees = pathsOf(options.cwd);
  const clankerHome = pathsOf(options.home);
  const homes = [...new Set([homedir(), process.env.HOME ?? ""])].filter((home) => home.length > 1);

  return (text) => {
    let out = text;
    for (const secret of exact) out = out.replaceAll(secret, SECRET);
    for (const [pattern, replacement] of SECRET_PATTERNS) out = out.replace(pattern, replacement);
    for (const root of worktrees) out = out.replaceAll(`${root}/`, "").replace(boundary(root), ".");
    for (const root of clankerHome) out = out.replaceAll(root, "<clanker-home>");
    for (const home of homes) out = out.replaceAll(home, "<home>");
    return out.replace(/\/(?:Users|home)\/[^/\s"'`:;)]+/g, "<home>");
  };
}

/** La ruta tal cual y resuelta: en macOS `/var/...` y `/private/var/...` son la misma carpeta y las herramientas usan cualquiera. */
function pathsOf(path: string): string[] {
  let real = path;
  try {
    real = realpathSync(path);
  } catch {
    // Una carpeta que ya no existe: queda la ruta tal cual.
  }
  return [...new Set([path, real])].filter((p) => p.length > 1);
}

function boundary(path: string): RegExp {
  return new RegExp(`${path.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![\\w.-])`, "g");
}

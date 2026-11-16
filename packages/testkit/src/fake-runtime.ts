import { execFile } from "node:child_process";
import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { promisify } from "node:util";
import { compileJsonSchema, type Brief, type JsonSchema } from "@clanker/api";
import {
  addUsage,
  briefOfMessage,
  detailOf,
  emptyUsage,
  usdToMicros,
  type AgentEvent,
  type AgentRun,
  type AgentRuntime,
  type RunResult,
  type Usage,
} from "@clanker/core";
import * as z from "zod";
import { loadScripts, pickScript, type RecipeResult, type Script, type ScriptResult } from "./fake-script";

const git = promisify(execFile);

export interface FakeRuntimeOptions {
  /** Carpetas con guiones `<rol>.r<n>.yaml` (típicamente `fixtures/runs/<caso>`). */
  fixtures: string | readonly string[];
  /** Pisa el `speed` de los guiones: `Infinity` los reproduce sin esperar. */
  speed?: number;
  /** Cómo se espera entre eventos; los tests lo reemplazan para no dormir. Debe resolver al abortarse `signal`. */
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
  /**
   * Una carpeta donde dejar `<sessionId>.jsonl` por sesión, con mensajes con la forma de los del SDK de Claude
   * (el core lee `transcripts/` de su `CLANKER_HOME`, así que el demo pasa esa). Sin ella no se escribe nada.
   */
  transcripts?: string;
}

/**
 * Runtime `fake` (`CORE_RUNTIME=fake`): reproduce guiones YAML en vez de llamar a un modelo.
 * Elige el guion por el rol y por el modo, la ronda y la issue del brief que el core pone al final del
 * prompt. Los errores de fixture (sin guion, reporte que no cumple el esquema del modo, patch que no
 * aplica) salen de `start` y `resume`: el test falla, nunca se inventa un reporte.
 */
export interface FakeRuntime extends AgentRuntime {
  id: "fake";
  /**
   * El resultado guionado de la próxima llamada a `command` de la receta (`run.<command>` del guion)
   * para una sesión del fake. Cada `start` o `resume` agrega los resultados de su guion al final de la
   * cola de la sesión. La acción de checks lo consume en lugar de correr el comando real.
   */
  nextRecipeResult(sessionId: string, command: string): RecipeResult;
}

interface Session {
  role: string;
  cwd: string;
  recipe: Map<string, RecipeResult[]>;
}

export function createFakeRuntime(options: FakeRuntimeOptions): FakeRuntime {
  const dirs = typeof options.fixtures === "string" ? [options.fixtures] : [...options.fixtures];
  const scripts = loadScripts(dirs);
  const sleep = options.sleep ?? sleepUnlessAborted;
  const sessions = new Map<string, Session>();
  const used = new Map<Script, number>();
  let started = 0;

  async function serve(
    sessionId: string,
    session: Session,
    message: string,
    outputSchema: JsonSchema,
  ): Promise<AgentRun> {
    const brief = briefOfMessage(message);
    if (!brief) {
      throw new Error(
        `El fake necesita el brief en JSON al final del mensaje para elegir el guion (sesión ${sessionId}).`,
      );
    }
    const script = pickScript(scripts, {
      role: session.role,
      mode: brief.mode,
      round: brief.run.round,
      issue: brief.issue?.key,
    }, used);
    used.set(script, (used.get(script) ?? 0) + 1);
    const result = fillFromBrief(script, brief);
    checkReport(script, result, outputSchema);

    for (const [command, results] of Object.entries(script.run)) {
      session.recipe.set(command, [...(session.recipe.get(command) ?? []), ...results]);
    }

    const events = channel<AgentEvent>();
    const abort = new AbortController();
    const speed = options.speed ?? script.speed;
    const record = options.transcripts ? transcriptWriter(options.transcripts, sessionId) : undefined;
    const played = play(script, result, session.cwd, speed, events.push, abort.signal, record).finally(events.close);
    // Quien solo itera los eventos todavía no pidió `result`: un crash no debe tumbar el proceso antes.
    played.catch(() => {});
    return {
      ref: { runtime: "fake", sessionId, cwd: session.cwd },
      events,
      interrupt: async () => abort.abort(),
      result: played,
    };
  }

  async function play(
    script: Script,
    result: ScriptResult,
    cwd: string,
    speed: number,
    emit: (event: AgentEvent) => void,
    signal: AbortSignal,
    record?: (message: Record<string, unknown>) => void,
  ): Promise<RunResult> {
    const crashAt = script.result.status === "crash" ? script.result.at : Infinity;
    const usage = emptyUsage("estimate");
    let clock = 0;
    let messages = 0;
    let tools = 0;

    const waitUntil = async (at: number) => {
      const ms = (at - clock) / speed;
      clock = at;
      if (ms > 0) await sleep(ms, signal);
    };

    for (const event of script.events) {
      if (event.at > crashAt) break;
      await waitUntil(event.at);
      if (signal.aborted) return interrupted(usage);
      if ("text" in event) {
        emit({ type: "text", text: event.text });
        record?.({ type: "assistant", message: { id: `msg_${++messages}`, content: [{ type: "text", text: event.text }] } });
      } else if ("tool" in event) {
        const detail = detailOf(event.input);
        emit({ type: "tool_start", tool: event.tool, ...(detail === undefined ? {} : { detail }) });
        const id = `toolu_${++tools}`;
        record?.({ type: "assistant", message: { id: `msg_${id}`, content: [{ type: "tool_use", id, name: event.tool, input: event.input ?? {} }] } });
        if (event.output !== undefined) {
          record?.({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: id, content: event.output }] } });
        }
        emit({ type: "tool_end", tool: event.tool });
      } else {
        const turn = {
          turns: 1,
          tokensIn: event.usage.in,
          tokensOut: event.usage.out,
          tokensCacheRead: event.usage.cacheRead,
          tokensCacheWrite: event.usage.cacheWrite,
          costMicros: usdToMicros(event.usage.costUsd),
          costSource: "estimate",
        } satisfies Usage;
        addUsage(usage, turn);
        emit({ type: "usage", turn: usage.turns, usage: turn });
      }
    }

    if (result.status === "crash") {
      await waitUntil(result.at);
      throw new Error(result.message ?? `El guion ${script.file} simula una caída a los ${result.at} ms.`);
    }

    for (const patch of script.patches) await applyPatch(patch, cwd);
    for (const { path, content } of script.writes) {
      mkdirSync(dirname(join(cwd, path)), { recursive: true });
      writeFileSync(join(cwd, path), content);
    }
    record?.({
      type: "result",
      subtype: result.status === "success" ? "success" : result.status,
      is_error: result.status !== "success",
      num_turns: usage.turns,
      total_cost_usd: usage.costMicros / 1_000_000,
      result: result.text ?? "",
    });

    return {
      status: result.status,
      text: result.text ?? "",
      structured: result.structured,
      usage,
      ...(result.status === "success"
        ? {}
        : { message: result.message ?? `El guion ${script.file} termina con ${result.status}.` }),
      ...("resetsAt" in result && result.resetsAt !== undefined ? { resetsAt: result.resetsAt } : {}),
    };
  }

  return {
    id: "fake",
    capabilities: { costPerTurn: true },

    async start(spec) {
      const sessionId = `fake-${++started}`;
      const session: Session = { role: spec.role, cwd: spec.cwd, recipe: new Map() };
      const run = await serve(sessionId, session, spec.prompt, spec.outputSchema);
      sessions.set(sessionId, session);
      return run;
    },

    async resume(ref, message, spec) {
      const session = sessions.get(ref.sessionId);
      if (!session) {
        throw new Error(`El fake no conoce la sesión ${ref.sessionId}: solo retoma las que él mismo inició.`);
      }
      return serve(ref.sessionId, session, message, spec.outputSchema);
    },

    nextRecipeResult(sessionId, command) {
      const next = sessions.get(sessionId)?.recipe.get(command)?.shift();
      if (!next) {
        throw new Error(
          `No quedan resultados guionados para la receta "${command}" en la sesión ${sessionId}: agrega otro en run.${command} del guion.`,
        );
      }
      return next;
    },
  };
}

/** Agrega un mensaje por línea a `<dir>/<sessionId>.jsonl`, como el transcript del runtime de Claude. */
function transcriptWriter(dir: string, sessionId: string): (message: Record<string, unknown>) => void {
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `${sessionId}.jsonl`);
  return (message) => appendFileSync(file, `${JSON.stringify({ ...message, session_id: sessionId })}\n`);
}

/**
 * El resultado del guion con cada string `$brief.<ruta>` reemplazado por lo que el brief trae en esa ruta
 * (`$brief.payload.items.0.id`): el guion puede citar ids que solo existen en la corrida, como el de un
 * thread del PR que el triage recibe. Una ruta que el brief no tiene es un error del fixture.
 */
function fillFromBrief(script: Script, brief: Brief): ScriptResult {
  const { result } = script;
  if (result.status !== "success" || result.structured === undefined) return result;
  const fill = (value: unknown): unknown => {
    if (typeof value === "string") {
      const path = /^\$brief\.(.+)$/.exec(value)?.[1];
      if (path === undefined) return value;
      const found = path.split(".").reduce<unknown>((node, key) => (node as Record<string, unknown> | undefined)?.[key], brief);
      if (found === undefined) throw new Error(`El guion ${script.file} cita $brief.${path} y el brief no lo tiene.`);
      return found;
    }
    if (Array.isArray(value)) return value.map(fill);
    if (value !== null && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, fill(item)]));
    return value;
  };
  return { ...result, structured: fill(result.structured) };
}

/** El reporte guionado tiene que cumplir el mismo esquema que exigiría el modo a un agente real. */
function checkReport(script: Script, result: ScriptResult, outputSchema: JsonSchema): void {
  if (result.status !== "success") return;
  const parsed = compileJsonSchema(outputSchema).safeParse(result.structured);
  if (!parsed.success) {
    throw new Error(
      `El guion ${script.file} entrega un reporte que no cumple el esquema del modo:\n${z.prettifyError(parsed.error)}`,
    );
  }
}

async function applyPatch(patch: string, cwd: string): Promise<void> {
  try {
    await git("git", ["apply", "--whitespace=nowarn", patch], { cwd });
  } catch (error) {
    const { stderr } = error as { stderr?: string };
    throw new Error(`No se pudo aplicar ${patch} sobre ${cwd}: ${stderr?.trim() ?? String(error)}`, {
      cause: error,
    });
  }
}

function interrupted(usage: Usage): RunResult {
  return { status: "error", text: "", usage, message: "El run fue interrumpido." };
}

async function sleepUnlessAborted(ms: number, signal: AbortSignal): Promise<void> {
  try {
    await delay(ms, undefined, { signal });
  } catch (error) {
    if ((error as Error).name !== "AbortError") throw error;
  }
}

/** Una cola con un solo consumidor: los eventos se acumulan aunque nadie itere todavía. */
function channel<T extends object>() {
  const buffer: T[] = [];
  let closed = false;
  let wake: (() => void) | undefined;
  return {
    push(item: T) {
      buffer.push(item);
      wake?.();
    },
    close() {
      closed = true;
      wake?.();
    },
    async *[Symbol.asyncIterator](): AsyncGenerator<T> {
      for (;;) {
        const next = buffer.shift();
        if (next) {
          yield next;
        } else if (closed) {
          return;
        } else {
          await new Promise<void>((resolve) => (wake = resolve));
        }
      }
    },
  };
}

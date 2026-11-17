import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Brief } from "@clanker/api";
import type { AgentEvent, AgentRun, AgentRuntime } from "@clanker/core";
import type { FakeIssue } from "@clanker/core/testing";
import { vi } from "vitest";
import { createFakeRuntime } from "./fake-runtime";
import { startTechleadScenario, type TechleadScenario } from "./techlead-scenario";

// El escenario de la noche (`docs/design.html#fases`, criterio de la fase 2): el core real con el Scheduler y Watch
// encendidos, el runtime fake, el GitHub simulado, un remoto git real y Linear falso, con un reloj que corre
// rápido. Lo recorre `night.test.ts`.

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), "../fixtures/runs/noche");

/** Cuánto avanza el reloj falso en cada vuelta de `until` y cuánto se espera de verdad entre vueltas: unas 25 veces más rápido que el real. */
const STEP_MS = 250;
const POLL_MS = 10;
/** Antes de que un `until` se dé por colgado, en tiempo real. */
const GIVE_UP_MS = 60_000;

const realSetTimeout = globalThis.setTimeout;
const realSleep = (ms: number) => new Promise<void>((resolve) => realSetTimeout(resolve, ms));

const NO_USAGE = { turns: 0, tokensIn: 0, tokensOut: 0, tokensCacheRead: 0, tokensCacheWrite: 0, costMicros: 0, costSource: "estimate" } as const;

type Latch = { promise: Promise<void>; open(): void };

/**
 * Un runtime que retiene a los agentes que el test dice: el run corre entero (sus patches ya están en el worktree)
 * pero su resultado no llega hasta `release`, como un agente largo. Sirve para llenar el carril de dev, o para
 * cortar el core con un agente en curso. La clave es `<issue>:<modo>` (`WEB-4:plan`; `-:conflict` si el brief no
 * trae issue, como el de un rebase).
 */
export function holdingRuntime(inner: AgentRuntime) {
  const latches = new Map<string, Latch>();
  const inFlight = new Map<string, number>();

  /** El brief va al final del mensaje, tras una línea en blanco (lo mismo que lee el fake para elegir su guion). */
  const keyOf = (message: string) => {
    const start = message.lastIndexOf("\n\n{");
    if (start === -1) return undefined;
    try {
      const parsed = Brief.safeParse(JSON.parse(message.slice(start + 2)));
      return parsed.success ? `${parsed.data.issue?.key ?? "-"}:${parsed.data.mode}` : undefined;
    } catch {
      return undefined;
    }
  };

  function hold(key: string | undefined, run: AgentRun): AgentRun {
    const latch = key === undefined ? undefined : latches.get(key);
    if (key === undefined || latch === undefined) return run;
    inFlight.set(key, (inFlight.get(key) ?? 0) + 1);
    let interrupted!: () => void;
    const cut = new Promise<false>((resolve) => (interrupted = () => resolve(false)));
    /** `true` si el test lo liberó; `false` si el core lo interrumpió antes. */
    const released = Promise.race([latch.promise.then(() => true as const), cut]);
    const result = released
      .then(async (done) =>
        done
          ? run.result
          : { ...(await run.result), status: "error" as const, message: "El run fue interrumpido.", usage: { ...NO_USAGE } },
      )
      .finally(() => inFlight.set(key, (inFlight.get(key) ?? 1) - 1));
    result.catch(() => {});
    return {
      ...run,
      // Un agente largo no gasta de golpe: su uso sale al terminar, y un corte antes no lo deja contado dos veces.
      events: (async function* () {
        const usage: AgentEvent[] = [];
        for await (const event of run.events) {
          if (event.type === "usage") usage.push(event);
          else yield event;
        }
        if (await released) yield* usage;
      })(),
      result,
      interrupt: async () => {
        await run.interrupt();
        interrupted();
      },
    };
  }

  const runtime: AgentRuntime = {
    ...inner,
    start: async (spec) => hold(keyOf(spec.prompt), await inner.start(spec)),
    resume: async (ref, message, spec) => hold(keyOf(message), await inner.resume(ref, message, spec)),
  };
  return {
    runtime,
    /** Los agentes que lleguen a `key` quedan retenidos hasta `release(key)`. */
    hold(key: string) {
      let open!: () => void;
      latches.set(key, { promise: new Promise<void>((resolve) => (open = resolve)), open });
    },
    release(key: string) {
      latches.get(key)?.open();
      latches.delete(key);
    },
    /** Cuántos agentes están retenidos ahora en `key`. */
    held: (key: string) => inFlight.get(key) ?? 0,
  };
}

export interface NightScenario extends TechleadScenario {
  holds: ReturnType<typeof holdingRuntime>;
  /** Corre el reloj falso hasta que `check` no lance (y devuelve lo que devuelva), con vueltas de `STEP_MS` falsos. */
  until<T>(what: string, check: () => T | Promise<T>): Promise<T>;
  /** Crea una issue de Linear en el proyecto; `blockedBy` la deja bloqueada por otra. */
  addIssue(input: { title: string; priority?: number; blockedBy?: FakeIssue }): FakeIssue;
  /** El archivo cuya existencia es el entorno del repo (`requires` de la receta): borrarlo lo deja caído. */
  environmentFlag: { down(): void; up(): void };
  /** Un commit directo a `main` en el remoto. */
  pushToMain(files: Record<string, string>, message: string): void;
  /** Mergea el PR `number` con squash sobre `main`, como GitHub, y lo cierra en el simulador. */
  merge(number: number): void;
}

export async function startNightScenario(): Promise<NightScenario> {
  const work = mkdtempSync(join(tmpdir(), "clanker-night-"));
  const flag = join(work, "environment-up");
  const environmentFlag = {
    down: () => rmSync(flag, { force: true }),
    up: () => writeFileSync(flag, ""),
  };
  environmentFlag.up();

  // `setTimeout` no se falsea: `fetch` (undici) se queda esperando una de sus propias esperas, ~6 s reales cada dos requests.
  // Lo que corre con `setInterval` (el despachador, Watch, el Scheduler, los latidos) y con `Date` (los intervalos de Watch, los plazos) sí.
  vi.useFakeTimers({ toFake: ["setInterval", "clearInterval", "Date"] });
  const holds = holdingRuntime(createFakeRuntime({ fixtures: FIXTURES, speed: Infinity }));
  let scenario: TechleadScenario;
  try {
    scenario = await startTechleadScenario({
      tracker: "linear",
      scheduler: true,
      runtime: holds.runtime,
      // Un bot que siempre da LGTM: el feedback externo no es lo que se prueba aquí.
      bot: () => "lgtm",
      recipe: {
        version: 1,
        slots: { dev: 2, maintenance: 1 },
        requires: [{ name: "Entorno", check: `test -f ${flag}` }],
        commands: { test: "npm test -- {{files}}" },
        checks: ["test"],
      },
      project: { parallel: 2, maxCostUsd: 5, stackMode: "remote" },
      // La prueba de un breaker sale de un `setTimeout` real (el reloj falso no lo mueve): a los 250 ms, no al minuto.
      breakerBackoffMs: [250],
    });
  } catch (error) {
    vi.useRealTimers();
    rmSync(work, { recursive: true, force: true });
    throw error;
  }
  const { linear, team, linearProject } = scenario;
  await scenario.client.system.setLanes({ dev: 2, maintenance: 2 });

  /** Una vuelta del reloj: avanza `STEP_MS` falsos y deja respirar a lo que espera E/S real. */
  async function tick() {
    await vi.advanceTimersByTimeAsync(STEP_MS);
    await realSleep(POLL_MS);
  }

  async function until<T>(what: string, check: () => T | Promise<T>): Promise<T> {
    const started = process.hrtime.bigint();
    for (;;) {
      try {
        return await check();
      } catch (error) {
        if (Number(process.hrtime.bigint() - started) / 1e6 > GIVE_UP_MS) {
          throw new Error(`La noche se quedó esperando ${what}: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
        }
      }
      await tick();
    }
  }

  const clone = join(work, "clone");
  scenario.repo.git("clone", "--quiet", scenario.repo.remoteDir!, clone);
  const git = (...args: string[]) => scenario.repo.git("-C", clone, ...args);
  const syncMain = () => {
    git("fetch", "--quiet", "origin");
    git("checkout", "--quiet", "-B", "main", "origin/main");
  };

  const closeScenario = scenario.cleanup.bind(scenario);
  const extras: Omit<NightScenario, Exclude<keyof TechleadScenario, "cleanup">> = {
    holds,
    until,
    addIssue({ title, priority = 0, blockedBy }) {
      const issue = linear!.workspace.addIssue({ team: team!, title, priority, project: linearProject!, description: `${title}\n\nCriterios de aceptación\n- Funciona\n` });
      if (blockedBy) linear!.workspace.relate(blockedBy, "blocks", issue);
      return issue;
    },
    environmentFlag,
    pushToMain(files, message) {
      syncMain();
      for (const [path, content] of Object.entries(files)) {
        mkdirSync(dirname(join(clone, path)), { recursive: true });
        writeFileSync(join(clone, path), content);
      }
      git("add", "--all");
      git("commit", "--quiet", "--message", message);
      git("push", "--quiet", "origin", "main");
    },
    merge(number) {
      const branch = scenario.github.pr(number).node().headRefName;
      syncMain();
      git("merge", "--squash", "--quiet", `origin/${branch}`);
      git("commit", "--quiet", "--message", `${branch} (#${number})`);
      git("push", "--quiet", "origin", "main");
      scenario.github.pr(number).merge({ sha: git("rev-parse", "HEAD") });
    },
    async cleanup() {
      // El cierre del core espera timers reales (gracia, SIGKILL) y el reloj falso no los mueve, pero sigue corriendo lo demás.
      const closing = closeScenario();
      let done = false;
      void closing.finally(() => (done = true));
      while (!done) await tick();
      await closing;
      vi.useRealTimers();
      rmSync(work, { recursive: true, force: true });
    },
  };
  // El mismo objeto que `restart()` actualiza: `client` y `store` siempre son los del core de turno.
  return Object.assign(scenario, extras);
}

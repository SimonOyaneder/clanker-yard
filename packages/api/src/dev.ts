import { oc } from "@orpc/contract";
import * as z from "zod";
import { StepRunId } from "./domain";
import type { ContractMeta } from "./mcp";
import { RunDetail } from "./runs";

const base = oc.$meta<ContractMeta>({});

const NOT_DESTRUCTIVE = { destructiveHint: false, openWorldHint: false } as const;

/**
 * El router `dev` (`docs/design.html#devx`): lo que un agente que desarrolla la app necesita para probarla y
 * debuguearla por MCP. No forma parte de `contract`: un core solo lo monta si quien lo lanza lo pide con
 * `startCore({ dev })`, así que un core normal no lo sirve por `/rpc` ni por `/mcp` (404 y ausente de
 * `tools/list`). Sus tools salen de este contrato como las demás (`generateMcp`).
 */
export const devContract = {
  /**
   * Cierra con `outcome` el paso `action` o `wait` que la corrida tiene en marcha, sin ejecutarlo ni terminar de
   * esperarlo, y la corrida sigue el edge de ese outcome. Es `runs.forceOutcome`, que el MCP normal no expone a
   * propósito (un agente no decide por una persona); aquí un agente de desarrollo lo usa para avanzar una corrida
   * sin esperar a GitHub, a un reloj o a un guion. Nunca sirve para un paso de agente. `NOT_FOUND` si el paso no
   * existe; `BAD_REQUEST` si es de un agente, una rama de parallel, no declara ese outcome o ya no está en marcha.
   */
  injectStepResult: base
    .meta({
      mcp: {
        action: "inject_step_result",
        description:
          "Solo desarrollo. Cierra con `outcome` un paso action o wait en marcha, sin ejecutarlo ni esperarlo, y la corrida sigue el edge de ese outcome. No sirve para pasos de agente ni para un outcome que el nodo no declara.",
        annotations: { ...NOT_DESTRUCTIVE, idempotentHint: false },
      },
    })
    .input(z.object({ stepId: StepRunId, outcome: z.string().min(1) }))
    .output(RunDetail),
  /**
   * Siembra el escenario `name` encima de lo que ya hay en la base (proyectos, corridas, eventos...). Quién lo
   * lanzó decide cuáles existen (`StartCoreOptions.dev.fixtures`); el core de demo del testkit ofrece los
   * escenarios de `packages/testkit` (`loop-running`, `issue-blocked`, `summary`...). `BAD_REQUEST` con un
   * nombre desconocido: el mensaje lista los que hay.
   */
  loadFixture: base
    .meta({
      mcp: {
        action: "load_fixture",
        description:
          "Solo desarrollo. Siembra un escenario de datos (proyectos, corridas, eventos) encima de lo que ya hay en la base del core. Con un nombre que no existe, el error lista los disponibles.",
        annotations: { ...NOT_DESTRUCTIVE, idempotentHint: false },
      },
    })
    .input(z.object({ name: z.string().min(1) }))
    .output(z.object({ name: z.string() })),
  /**
   * Adelanta `ms` el reloj falso del core de desarrollo y devuelve la hora nueva. Hoy lo usan las conexiones
   * (vencimiento de tokens y de la cuenta de Claude); el motor de flujos sigue con el reloj real.
   */
  advanceClock: base
    .meta({
      mcp: {
        action: "advance_clock",
        description: "Solo desarrollo. Adelanta el reloj falso del core (hoy lo usan las conexiones: vencimiento de tokens y de la cuenta de Claude) y devuelve la hora nueva en ms epoch.",
        annotations: { ...NOT_DESTRUCTIVE, idempotentHint: false },
      },
    })
    .input(z.object({ ms: z.int().positive() }))
    .output(z.object({ now: z.int().nonnegative() })),
};

export type DevContract = typeof devContract;

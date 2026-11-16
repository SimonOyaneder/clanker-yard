import { PrRef, PrState } from "@clanker/api";
import * as z from "zod";
import type { ExternalEvent, WaitDef, WaitResult } from "../flows/catalog";
import type { Prs } from "./prs";

/**
 * Lo que `flows.signal` entrega a estos waits (Watch, fase 2): un hecho del PR con su estado ya
 * normalizado. El wait decide con el mismo `PrState` que lee `probe`, así que signal y sondeo no pueden
 * discrepar.
 */
const PrEvent = z.object({ pr: PrRef, state: PrState });

const sameRepoPr = (a: PrRef, b: PrRef) => a.repo === b.repo && a.number === b.number;

/**
 * Cuánto espera `pr.ci` a que aparezca el primer check de un head antes de dar por hecho que el repo no
 * tiene CI. GitHub registra los checks de un push en segundos, pero un CI externo puede tardar un par de
 * minutos en enterarse.
 */
export const NO_CI_GRACE_MS = 5 * 60_000;

/** Cuándo vio Watch (o `pr.publish`) por primera vez el head de un PR. `sha` es ese head; `at`, ms. */
export interface HeadSeen {
  sha: string;
  at: number;
}

export interface PrWaitsOptions {
  /**
   * El head que el caché de PRs tiene de `pr` y desde cuándo; `undefined` si no lo conoce. Sin esto un PR
   * sin checks nunca cuenta como "sin CI": `pr.ci` espera hasta su plazo.
   */
  headSeen?(pr: PrRef): HeadSeen | undefined;
  now?: () => number;
}

/** Los tipos de evento que cierran estos waits: el `name` de cada uno. */
const PR_EVENT_TYPES = ["pr.botReview", "pr.ci", "pr.merged"] as const;

/**
 * El hecho que Watch entrega a `flows.signal` cada vez que cambia el `PrState` de un PR: uno por tipo de
 * wait, todos con el mismo estado. Cada wait decide con su propia regla si eso es lo que esperaba.
 */
export function signalPr(signal: (event: ExternalEvent) => void, pr: PrRef, state: PrState): void {
  for (const type of PR_EVENT_TYPES) signal({ type, pr, state });
}

/** Cuál PR espera un wait según su clave (`WaitDef.key`), o `undefined` si no es de un PR. */
export function prOfWaitKey(key: string): { repo: string; number: number } | undefined {
  const match = /^pr:([^/\s#]+\/[^/\s#]+)#(\d+):/.exec(key);
  return match ? { repo: match[1]!, number: Number(match[2]) } : undefined;
}

/**
 * Un wait sobre el estado de un PR. `decide` mira el `PrState` y devuelve el resultado o `undefined` si lo
 * esperado todavía no pasó; `match` lo aplica al estado del evento y `probe` al que lee `prs.get`.
 */
function prWait<A extends z.ZodObject<{ pr: typeof PrRef }>>(wait: {
  name: (typeof PR_EVENT_TYPES)[number];
  args: A;
  outcomes: string[];
  key: string;
  decide(state: PrState, args: z.infer<A>): WaitResult | undefined;
  prs: Pick<Prs, "get">;
}): WaitDef<A> {
  const { name, args, outcomes, decide, prs } = wait;
  return {
    name,
    args,
    outcomes,
    key: ({ pr }) => `pr:${pr.repo}#${pr.number}:${wait.key}`,
    match(event: ExternalEvent, value) {
      if (event.type !== name) return undefined;
      const { pr, state } = PrEvent.parse(event);
      return sameRepoPr(pr, value.pr) ? decide(state, value) : undefined;
    },
    async probe(value) {
      return decide(await prs.get(value.pr), value);
    },
  };
}

/** Un ítem para el brief de triage (`TriageBrief`): lo que el bot o el CI piden arreglar. */
interface TriageItem {
  id: string;
  kind: "bot" | "ci";
  path?: string;
  line?: number;
  text: string;
  /** Solo un check de CI que el pack declara flaky conocido. */
  flaky?: true;
}

/**
 * Los waits sobre un PR (`docs/design.html#d-flows`): `pr.botReview`, `pr.ci` y `pr.merged`. Sin
 * efectos: solo leen. Un sondeo que falla (cuota, red) deja el wait esperando y se reintenta en el
 * siguiente.
 *
 * - `pr.botReview { pr, after }`: `after` es `requestedAt` (ms) de `review.requestBot`; solo cuenta una
 *   review del bot posterior. `lgtm` (solo si la regla del pack lo da: ver `PrState.bot`) o `findings`
 *   con `items` para triage. Sin bot en el pack nunca resuelve: el flujo no lo espera porque
 *   `review.requestBot` da `none`.
 * - `pr.ci { pr }`: `ok` con el CI verde, `fail` con `failures` apenas un check que cuenta falla (sin
 *   esperar a los pendientes). Con los checks pendientes sigue esperando. Cada falla trae `flaky: true` si
 *   el pack la declara flaky conocida. Un head sin ningún check que cuente (`ci.state === "none"`) también
 *   es `ok`, como en `ciGreen` del vigilante, pero solo cuando el caché lo conoce (`headSeen`, con ese mismo
 *   sha) desde hace `NO_CI_GRACE_MS`: antes puede ser un CI que aún no registra sus checks. Un PR que
 *   el caché no conoce, o con un head distinto del leído, sigue esperando. Watch solo avisa por `signal` los
 *   cambios del PR, y el tiempo sin checks no lo es: este caso lo cierra el sondeo del wait.
 * - `pr.merged { pr }`: `merged` (con `sha` del merge) o `closed` si lo cerraron sin mergear.
 */
export function prWaits(prs: Pick<Prs, "get">, { headSeen, now = Date.now }: PrWaitsOptions = {}) {
  const prArgs = z.object({ pr: PrRef });
  return {
    botReview: prWait({
      name: "pr.botReview",
      args: z.object({ pr: PrRef, after: z.number() }),
      outcomes: ["lgtm", "findings"],
      key: "botReview",
      prs,
      decide({ bot }, { after }) {
        if (bot.state === "none" || bot.at === undefined || Date.parse(bot.at) <= after) return undefined;
        if (bot.state === "lgtm") return { outcome: "lgtm", output: { sha: bot.sha, reviewId: bot.reviewId } };
        const items = bot.findings.map(({ id, path, line, text }): TriageItem => ({ id, kind: "bot", ...(path && { path }), ...(line && { line }), text }));
        return { outcome: "findings", output: { sha: bot.sha, reviewId: bot.reviewId, items } };
      },
    }),
    ci: prWait({
      name: "pr.ci",
      args: prArgs,
      outcomes: ["ok", "fail"],
      key: "ci",
      prs,
      decide({ ci }, { pr }) {
        if (ci.state === "green") return { outcome: "ok", output: { sha: ci.sha } };
        if (ci.state === "none") {
          const seen = headSeen?.(pr);
          return seen?.sha === ci.sha && now() - seen.at >= NO_CI_GRACE_MS ? { outcome: "ok", output: { sha: ci.sha } } : undefined;
        }
        if (ci.state !== "red") return undefined;
        const failures = ci.failing.map(
          (name): TriageItem => ({
            id: `ci:${name}`,
            kind: "ci",
            text: `El check ${name} falló en ${ci.sha.slice(0, 7)}.`,
            ...(ci.flaky.includes(name) && { flaky: true as const }),
          }),
        );
        return { outcome: "fail", output: { sha: ci.sha, failures } };
      },
    }),
    merged: prWait({
      name: "pr.merged",
      args: prArgs,
      outcomes: ["merged", "closed"],
      key: "merged",
      prs,
      decide({ state, mergeCommitSha }) {
        if (state === "merged") return { outcome: "merged", output: { sha: mergeCommitSha } };
        return state === "closed" ? { outcome: "closed" } : undefined;
      },
    }),
  };
}

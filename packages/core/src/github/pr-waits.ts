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
 * Un wait sobre el estado de un PR. `decide` mira el `PrState` y devuelve el resultado o `undefined` si lo
 * esperado todavía no pasó; `match` lo aplica al estado del evento y `probe` al que lee `prs.get`.
 */
function prWait<A extends z.ZodObject<{ pr: typeof PrRef }>>(wait: {
  name: "pr.botReview" | "pr.ci" | "pr.merged";
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
 *   esperar a los pendientes). Con los checks pendientes o todavía sin registrarse sigue esperando.
 *   Cada falla trae `flaky: true` si el pack la declara flaky conocida.
 * - `pr.merged { pr }`: `merged` (con `sha` del merge) o `closed` si lo cerraron sin mergear.
 */
export function prWaits(prs: Pick<Prs, "get">) {
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
      decide({ ci }) {
        if (ci.state === "green") return { outcome: "ok", output: { sha: ci.sha } };
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

import type { ClientOrigin, PrRef, PrState } from "@clanker/api";
import { eq } from "drizzle-orm";
import type { Packs } from "../../packs/packs";
import { runs } from "../../store/schema";
import type { Store } from "../../store/store";
import type { Connections } from "../../connections/connections";
import type { Repos } from "../../repos/repos";
import { commentOnPr } from "./comment";
import type { PrCache } from "../pr-cache";
import type { Prs } from "../prs";

// Lo que una persona le pide al core sobre un PR desde la app (`prs.setHold`, `prs.merge`,
// `prs.requestReview`, `prs.rebase`). Cada pedido relee el PR antes de actuar: lo que vale es lo que pasa
// ahora, no lo que la pantalla mostraba.

/** El pedido no se puede cumplir; el mensaje dice qué cambiar. */
export class PrCommandError extends Error {}

export interface PrCommandsDeps {
  store: Store;
  repos: Pick<Repos, "byRemote">;
  connections: Pick<Connections, "githubClient">;
  packs: Pick<Packs, "packFor">;
  prs: Pick<Prs, "get">;
  cache: Pick<PrCache, "refresh" | "setHold" | "row">;
}

export interface PrCommands {
  /** `PrCache.setHold`: solo para un PR que el core ya conoce. Emite `pr.hold_changed` con quién lo pidió. */
  setHold(ref: PrRef, hold: boolean, by: ClientOrigin): Promise<PrState>;
  /**
   * Comenta el comando de la estrategia de merge del pack y devuelve el PR releído. Rechaza si el repo se
   * mergea con el botón de GitHub, si el PR no está `merge.ready` (con lo que falta), si tiene `hold` o si
   * ya está en cola.
   */
  merge(ref: PrRef, by: ClientOrigin): Promise<PrState>;
  /** Comenta el comando del bot de review del pack. */
  requestReview(ref: PrRef, by: ClientOrigin): Promise<void>;
  /**
   * Anota un `pr.conflict` sobre el PR para que arranque el flujo del pack que lo atiende, como si Watch lo
   * hubiera visto en conflicto: sirve también para un PR solo atrasado. Rechaza un PR que el sistema no abrió,
   * cerrado o con threads de council.
   */
  rebase(ref: PrRef, by: ClientOrigin): Promise<void>;
}

export function createPrCommands({ store, repos, connections, packs, prs, cache }: PrCommandsDeps): PrCommands {
  const packOf = (ref: PrRef) => packs.packFor({ githubOrg: ref.repo.split("/")[0]! });
  const label = ({ repo, number }: PrRef) => `${repo}#${number}`;
  /** La fila del PR en el caché; los pedidos que la necesitan solo valen para PRs que Watch o `pr.publish` ya registraron. */
  function knownRow(ref: PrRef) {
    const repo = repos.byRemote(ref.repo);
    const row = repo && cache.row(repo.id, ref.number);
    if (!row) throw new PrCommandError(`El core no conoce el PR ${label(ref)}: registra el repo y espera a que Watch lo vea.`);
    return row;
  }

  /** Lo que se comentó a pedido de una persona queda en los eventos con quién lo pidió (`pr.commented`). */
  async function comment(ref: PrRef, body: string, by: ClientOrigin): Promise<void> {
    await commentOnPr(connections, ref, body);
    const row = repos.byRemote(ref.repo) && cache.row(repos.byRemote(ref.repo)!.id, ref.number);
    store.tx((tx) =>
      tx.emit({ type: "pr.commented", origin: by, ...(row && { subject: { type: "pr", id: row.id } }), payload: { repo: ref.repo, number: ref.number, body } }),
    );
  }

  return {
    async setHold(ref, hold, by) {
      const row = knownRow(ref);
      const state = await cache.setHold(ref, hold);
      store.tx((tx) => tx.emit({ type: "pr.hold_changed", origin: by, subject: { type: "pr", id: row.id }, payload: { repo: ref.repo, number: ref.number, hold } }));
      return state;
    },

    async merge(ref, by) {
      const state = await prs.get(ref);
      const strategy = packOf(ref).mergeStrategy;
      if (state.merge.via !== "comment" || !strategy) {
        throw new PrCommandError(`${label(ref)} se mergea con el botón de GitHub: la estrategia del pack no aplica a este repo.`);
      }
      if (state.hold) throw new PrCommandError(`${label(ref)} tiene hold ("no mergear nunca"): quítalo antes de mergear.`);
      if (state.merge.queue === "queued") throw new PrCommandError(`${label(ref)} ya está en cola: el merge ya se pidió.`);
      if (state.merge.queue === "failed") {
        throw new PrCommandError(`El merge de ${label(ref)} ya se pidió y falló en la cola: revisa por qué en GitHub antes de volver a pedirlo.`);
      }
      if (!state.merge.ready) throw new PrCommandError(`${label(ref)} no está listo para mergear: ${state.merge.blockers.join(", ") || "ya no está abierto"}.`);
      await comment(ref, strategy.command, by);
      return cache.refresh(ref);
    },

    async requestReview(ref, by) {
      const bot = packOf(ref).reviewBot;
      if (!bot) throw new PrCommandError(`El pack de la organización de ${ref.repo} no define un bot de review.`);
      const state = await prs.get(ref);
      if (state.state === "merged" || state.state === "closed") throw new PrCommandError(`${label(ref)} ya está ${state.state === "merged" ? "mergeado" : "cerrado"}.`);
      await comment(ref, bot.request.body, by);
    },

    async rebase(ref, by) {
      const row = knownRow(ref);
      if (!row.owned) throw new PrCommandError(`${label(ref)} no lo abrió el sistema: el core nunca reescribe la branch de un PR ajeno.`);
      const state = await prs.get(ref);
      if (state.state === "merged" || state.state === "closed") throw new PrCommandError(`${label(ref)} ya está ${state.state === "merged" ? "mergeado" : "cerrado"}.`);
      if (state.threads.councilEver) throw new PrCommandError(`${label(ref)} tiene threads de council: rebasear reescribiría su historia y eso nunca se fuerza.`);
      const projectId = row.runId ? store.db.select({ id: runs.projectId }).from(runs).where(eq(runs.id, row.runId)).get()?.id : undefined;
      store.tx((tx) =>
        tx.emit({
          type: "pr.conflict",
          origin: by,
          ...(projectId && { projectId }),
          subject: { type: "pr", id: row.id },
          payload: { repo: ref.repo, number: ref.number, sha: state.headSha, base: state.baseRef },
        }),
      );
    },
  };
}

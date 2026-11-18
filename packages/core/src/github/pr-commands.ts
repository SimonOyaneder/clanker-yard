import { mergeBlocker, rebaseBlocker, type ClientOrigin, type LocalPrMetadata, type LocalPrPatch, type LocalPrUpdate, type PrRef, type PrState, type RunId } from "@clanker/api";
import { eq } from "drizzle-orm";
import { cleanMessage } from "../commits/apply";
import type { Packs } from "../packs/packs";
import { pullRequests, runs } from "../store/schema";
import type { Store } from "../store/store";
import type { Connections } from "../connections/connections";
import type { Repos } from "../repos/repos";
import type { Engine } from "../flows/engine";
import type { Projects } from "../projects/projects";
import { livePrFlow, prById } from "./pr-rows";
import { commentOnPr } from "./comment";
import type { PrCache, PrRow } from "./pr-cache";
import type { Prs } from "./prs";
import { BadRequestError, NotFoundError, requireUiOrigin } from "../errors/domain";

// Lo que una persona le pide al core sobre un PR desde la app (`prs.setHold`, `prs.merge`,
// `prs.requestReview`, `prs.rebase`). Cada pedido relee el PR antes de actuar: lo que vale es lo que pasa
// ahora, no lo que la pantalla mostraba.

/** El pedido no se puede cumplir; el mensaje dice qué cambiar. */
export class PrCommandError extends BadRequestError {}

export function ownedLocalPr(row: PrRow | undefined, id: string): PrRow {
  if (!row) throw new NotFoundError(`No existe el PR ${id}.`);
  if (row.state !== "local" || !row.owned) throw new PrCommandError(`${row.headRef} no es un PR local del sistema.`);
  return row;
}

export interface PrCommandsDeps {
  store: Store;
  repos: Pick<Repos, "byRemote">;
  connections: Pick<Connections, "githubClient">;
  packs: Pick<Packs, "packFor">;
  prs: Pick<Prs, "get">;
  cache: Pick<PrCache, "refresh" | "setHold" | "row">;
  /** Para `publishLocal`, que arranca `promote-local`. */
  flows: Pick<Engine, "start">;
  projects: Pick<Projects, "get">;
}

export interface PrCommands {
  /** `PrCache.setHold`: solo para un PR que el core ya conoce. Emite `pr.hold_changed` con quién lo pidió. */
  setHold(ref: PrRef, hold: boolean, by: ClientOrigin): Promise<PrState>;
  /**
   * Comenta el comando de la estrategia de merge del pack y devuelve el PR releído. Mergear lo decide una persona:
   * solo con `by: "ui"` (`UiOnlyError` si no; un agente no lo hace por su cuenta por el CLI o el MCP). Rechaza si el repo se
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
  /**
   * Arranca `promote-local` sobre un PR local con su base de hoy: sale en GitHub apilado sobre su padre. Publica con la
   * identidad del usuario sin preguntar: solo con `by: "ui"` (`UiOnlyError` si no).
   */
  publishLocal(id: string, by: ClientOrigin): RunId;
  /** Edita solo título y descripción; nunca toca Git. */
  updateLocal(input: LocalPrUpdate, by: ClientOrigin): LocalPrMetadata;
  /** Encola un commit local con un lease; no reutiliza una edición anterior con otro patch. */
  applyLocalPatch(input: LocalPrPatch, by: ClientOrigin): RunId;
}

export function createPrCommands({ store, repos, connections, packs, prs, cache, flows, projects }: PrCommandsDeps): PrCommands {
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
      requireUiOrigin(by, "Mergear lo pide una persona desde la app: un agente no lo hace por su cuenta.");
      const state = await prs.get(ref);
      const strategy = packOf(ref).mergeStrategy;
      if (state.merge.via !== "comment" || !strategy) {
        throw new PrCommandError(`${label(ref)} se mergea con el botón de GitHub: la estrategia del pack no aplica a este repo.`);
      }
      const blocked = mergeBlocker(state);
      if (blocked) throw new PrCommandError(`${label(ref)}: ${blocked}.`);
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
      const state = await prs.get(ref);
      const blocked = rebaseBlocker(state, row.owned);
      if (blocked) throw new PrCommandError(`${label(ref)}: ${blocked}.`);
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

    publishLocal(id, by) {
      requireUiOrigin(by, "Publicar un PR local lo pide una persona desde la app: sale en GitHub con tu cuenta.");
      const row = prById(store.db, id);
      if (!row) throw new PrCommandError(`No existe el PR ${id}.`);
      if (row.state !== "local" || !row.owned) throw new PrCommandError(`${row.headRef} ya no es un PR local: no hay nada que publicar.`);
      const publishing = livePrFlow(store.db, id, ["promote-approved-local"]);
      if (publishing) return publishing.id;
      const projectId = row.runId ? store.db.select({ id: runs.projectId }).from(runs).where(eq(runs.id, row.runId)).get()?.id : undefined;
      const project = projectId ? projects.get(projectId) : undefined;
      return flows.start(
        "promote-local",
        { type: "pr", id: row.id },
        { prId: row.id, repo: row.repoId, branch: row.headRef, base: row.baseRef },
        { ...(projectId && { projectId }), repoId: row.repoId, ...(project?.defaultProfileId && { profile: project.defaultProfileId }), by },
      );
    },

    updateLocal({ id, title, body }, by) {
      return store.tx((tx) => {
        const row = ownedLocalPr(prById(tx.db, id), id);
        const publishing = livePrFlow(tx.db, id, ["promote-local", "promote-approved-local"]);
        if (publishing) throw new PrCommandError(`Este PR se está publicando en la corrida ${publishing.id}. Espera a que termine para editarlo.`);
        const nextTitle = title === undefined ? row.title ?? row.headRef : cleanMessage(title);
        const nextBody = body === undefined ? row.body ?? "" : cleanMessage(body);
        if (!nextTitle) throw new PrCommandError("El título del PR no puede quedar vacío.");
        if (nextTitle !== row.title || nextBody !== (row.body ?? "")) {
          tx.db.update(pullRequests).set({ title: nextTitle, body: nextBody }).where(eq(pullRequests.id, id)).run();
          tx.emit({ type: "pr.changed", origin: by, subject: { type: "pr", id } });
        }
        return { id, title: nextTitle, body: nextBody };
      });
    },

    applyLocalPatch({ id, head, patch }, by) {
      const row = ownedLocalPr(prById(store.db, id), id);
      const editing = livePrFlow(store.db, id, ["apply-local-patch"]);
      if (editing) throw new PrCommandError(`Ya hay una edición en la corrida ${editing.id}: espera a que termine antes de aplicar otro patch.`);
      const projectId = row.runId ? store.db.select({ id: runs.projectId }).from(runs).where(eq(runs.id, row.runId)).get()?.id : undefined;
      return flows.start(
        "apply-local-patch",
        { type: "pr", id },
        { prId: id, repo: row.repoId, branch: row.headRef, base: row.baseRef, head, patch },
        { ...(projectId && { projectId }), repoId: row.repoId, by },
      );
    },
  };
}

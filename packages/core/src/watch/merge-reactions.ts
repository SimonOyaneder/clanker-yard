import type { DecisionId, EventOf, MergeStrategy, PrRef, PrState } from "@clanker/api";
import { and, eq } from "drizzle-orm";
import type { Connections } from "../connections/connections";
import { closeDecision, openDecision } from "../decisions/decisions";
import { commentOnPr } from "../github/comment";
import type { PrRow } from "../github/pr-cache";
import type { Prs } from "../github/prs";
import type { Packs } from "../packs/packs";
import { decisions, mergeOffers, runs } from "../store/schema";
import type { Store, Tx } from "../store/store";
import type { Repos } from "../repos/repos";
import type { ErrorReporter } from "../errors/reporter";
import { prById, prRefOf } from "../github/pr-rows";

// Lo que el core hace cuando la estrategia de merge dice que un PR está listo (`docs/design.html#d-ops`,
// "Watch: eventos y qué disparan", `pr.mergeReady`): según el pack, nada, comentar el comando de merge solo
// (`auto`: sin preguntar, solo si el pack lo pide) o abrir una decisión (`offer`) que no estaciona ninguna
// corrida: solo ese PR espera. Sin estrategia, la decisión avisa que se mergea con el botón de GitHub.
//
// Todo es sobre PRs del sistema (`owned`) y nunca confía en el evento: antes de actuar lee el PR de nuevo y
// vuelve a evaluar. El comando de merge solo sale solo con `auto`; con `offer` sale cuando una persona aprueba
// la decisión desde la app, y únicamente si el PR sigue igual a como se ofreció.

export const WAIT_OPTION = "Todavía no";
/** La opción que aprueba una oferta con comando: lo que se comenta es `command`. */
export const approveOption = (command: string) => `Comentar ${command}`;
/** La opción de una oferta sin comando: no hace nada, el merge lo da la persona en GitHub. */
export const BUTTON_OPTION = "Lo mergeo yo en GitHub";

/**
 * Si la decisión es una oferta de merge: aprobarla comenta el comando de merge con la identidad del usuario,
 * así que solo vale desde la app (`origin: "ui"`). La API la rechaza con otro origin en vez de cerrarla sin efecto.
 */
export function isMergeOffer(store: Pick<Store, "db">, decisionId: DecisionId): boolean {
  return store.db.select({ id: mergeOffers.decisionId }).from(mergeOffers).where(eq(mergeOffers.decisionId, decisionId)).get() !== undefined;
}

export interface MergeReactionsDeps {
  store: Store;
  repos: Pick<Repos, "get" | "config">;
  packs: Pick<Packs, "packFor">;
  prs: Pick<Prs, "get">;
  connections: Pick<Connections, "githubClient">;
  errors: ErrorReporter;
}

export interface MergeReactions {
  /** Espera a que terminen las reacciones en curso (para los tests). */
  idle(): Promise<void>;
  /** Deja de escuchar. */
  stop(): void;
}

export function startMergeReactions({ store, repos, packs, prs, connections, errors }: MergeReactionsDeps): MergeReactions {
  // Una reacción a la vez: así dos eventos de un mismo PR no comentan dos veces.
  let queue: Promise<void> = Promise.resolve();
  const enqueue = (scope: string, work: () => Promise<void>) => {
    queue = queue.then(work).then(
      () => errors.clear(scope),
      (error: unknown) => errors.report(scope, error),
    );
  };

  /** El PR `id` si lo abrió el sistema (los demás nunca se comentan), con su ref de GitHub. */
  function ownedPr(id: string) {
    const row = prById(store.db, id);
    const ref = row?.owned ? prRefOf(repos, row) : undefined;
    return row && ref ? { row, ref } : undefined;
  }

  const strategyOf = (ref: PrRef) => packs.packFor({ githubOrg: ref.repo.split("/")[0]! }).mergeStrategy;

  const offersOf = (tx: Tx, prId: string) =>
    tx.db
      .select({ decisionId: mergeOffers.decisionId, headSha: mergeOffers.headSha })
      .from(mergeOffers)
      .innerJoin(decisions, eq(decisions.id, mergeOffers.decisionId))
      .where(and(eq(mergeOffers.prId, prId), eq(decisions.status, "pending")))
      .all();

  /** Las ofertas pendientes de un PR (salvo las de `keepSha`) ya no tienen nada que decidir. */
  function supersedeOffers(tx: Tx, prId: string, keepSha?: string): void {
    for (const offer of offersOf(tx, prId)) {
      if (offer.headSha !== keepSha) closeDecision(tx, offer.decisionId, { status: "superseded", by: "core" });
    }
  }

  function offer(row: PrRow, ref: PrRef, state: PrState, strategy: MergeStrategy | undefined): void {
    const approvers = state.approvers.map((login) => `@${login}`).join(", ");
    const risk = Object.entries(state.signals).map(([signal, level]) => `${signal} ${level}`);
    const body = [
      `Aprobado por ${approvers || "nadie"}, CI verde y sin comentarios pendientes de humanos.`,
      ...(risk.length > 0 ? [`Señales: ${risk.join(", ")}.`] : []),
      `https://github.com/${ref.repo}/pull/${ref.number} (head ${state.headSha.slice(0, 7)})`,
      "Estaciona solo este PR: nada más espera.",
    ].join("\n");
    const projectId = row.runId ? store.db.select({ id: runs.projectId }).from(runs).where(eq(runs.id, row.runId)).get()?.id : undefined;

    store.tx((tx) => {
      supersedeOffers(tx, row.id, state.headSha);
      if (offersOf(tx, row.id).length > 0) return;
      const decision = openDecision(tx, {
        kind: "question",
        title: strategy ? `${approveOption(strategy.command)} en ${state.key}` : `Mergear ${state.key} en GitHub`,
        body,
        options: [strategy ? approveOption(strategy.command) : BUTTON_OPTION, WAIT_OPTION],
        subject: { type: "pr", id: row.id },
        ...(projectId && { projectId }),
      });
      tx.db.insert(mergeOffers).values({ decisionId: decision.id, prId: row.id, headSha: state.headSha }).run();
    });
  }

  async function onMergeReady(event: EventOf<"pr.mergeReady">): Promise<void> {
    const found = event.subject?.type === "pr" ? ownedPr(event.subject.id) : undefined;
    if (!found) return;
    const { row, ref } = found;
    // El evento dice qué pasaba cuando se leyó el PR; lo que vale es lo que pasa ahora.
    const state = await prs.get(ref);
    if (!state.merge.offer || state.headSha !== event.payload.sha) return;

    const strategy = state.merge.via === "comment" ? strategyOf(ref) : undefined;
    const reaction = strategy ? (state.merge.auto ? strategy.onAuto : strategy.onOffer) : "gate";
    if (reaction === "none") return;
    if (reaction === "act" && strategy) {
      if (state.merge.queue === null) await commentOnPr(connections, ref, strategy.command);
      return;
    }
    offer(row, ref, state, strategy);
  }

  /** Una persona respondió una oferta: con la opción que comenta, se comenta si el PR sigue como se ofreció. */
  async function onDecisionResolved(event: EventOf<"decision.resolved">): Promise<void> {
    const { decisionId } = event.payload;
    const row = store.db.select().from(mergeOffers).where(eq(mergeOffers.decisionId, decisionId)).get();
    const decision = row && store.db.select().from(decisions).where(eq(decisions.id, row.decisionId)).get();
    if (!row || decision?.status !== "answered") return;
    // Solo una persona en la app aprueba: un agente puede usar el CLI o el MCP, y lo que resuelve el core o Watch no es una persona.
    if (decision.resolvedBy !== "ui") return;

    const found = ownedPr(row.prId);
    if (!found) return;
    const { row: pr, ref } = found;
    const command = strategyOf(ref)?.command;
    if (command === undefined || decision.resolution?.option !== approveOption(command)) return;

    const state = await prs.get(ref);
    const still = state.headSha === row.headSha && state.merge.offer && state.merge.via === "comment" && state.merge.queue === null;
    if (still) {
      await commentOnPr(connections, ref, command);
      return;
    }
    // La aprobación vale para ese contenido: si cambió, se pide de nuevo (un `pr.mergeReady` nuevo la reabre).
    store.tx((tx) =>
      openDecision(tx, {
        kind: "note",
        title: `No se comentó ${command} en ${state.key}`,
        body: `El PR cambió desde que se ofreció (${row.headSha.slice(0, 7)} → ${state.headSha.slice(0, 7)}) o ya no cumple las condiciones: aprobar la oferta vale solo para ese contenido. Si vuelve a estar listo, se pregunta de nuevo.`,
        subject: { type: "pr", id: pr.id },
      }),
    );
  }

  return {
    idle: () => queue,
    stop: store.events.subscribe(
      (event) => {
        const scope = `merge ${event.type}`;
        if (event.type === "pr.mergeReady") enqueue(scope, () => onMergeReady(event));
        else if (event.type === "decision.resolved") enqueue(scope, () => onDecisionResolved(event));
        else if (event.subject?.type === "pr") {
          const id = event.subject.id;
          enqueue(scope, async () => void store.tx((tx) => supersedeOffers(tx, id)));
        }
      },
      { types: ["pr.mergeReady", "decision.resolved", "pr.merged"] },
    ),
  };
}

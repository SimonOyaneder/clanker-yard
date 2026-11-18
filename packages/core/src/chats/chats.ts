import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  type AgentRuntimeId,
  type ArtifactHash,
  type Brief,
  type ChatMessage,
  type ChatProposal,
  type ChatRef,
  type Effort,
  type LocalPrFile,
  type Origin,
  type PrChat,
  type PrState,
  type RunId,
  ChatId,
  DEFAULT_AGENT_RUNTIME,
  Profile,
} from "@clanker/api";
import { and, desc, eq, isNotNull, sql } from "drizzle-orm";
import type { Agents, AgentResult } from "../agents/agents";
import type { RuntimeRegistry } from "../agents/runtime";
import type { Artifacts } from "../artifacts/artifacts";
import type { Breakers } from "../breakers/breakers";
import type { Defs } from "../defs/defs";
import { BadRequestError, NotFoundError, requireUiOrigin } from "../errors/domain";
import type { ErrorReporter } from "../errors/reporter";
import type { Engine } from "../flows/engine";
import { git, gitRaw } from "../git/git";
import { diffBetween, snapshotTree } from "../git/tree";
import type { PrDetails } from "../github/pr-detail";
import { prById } from "../github/pr-rows";
import type { PrRow } from "../github/pr-cache";
import { newId } from "../store/conventions";
import type { Projects } from "../projects/projects";
import type { RepoConfig } from "../repos/repos";
import { agentSessions, issues, prChatMessages, prChatProposals, prChats, runs } from "../store/schema";
import type { Store, Tx } from "../store/store";
import type { ChatScratch, ScratchSyncResult } from "../workspaces/scratch";
import { applyMessage, applySummaryOf } from "./apply-summary";

/**
 * El chat de un PR (`docs/design.html#d-agents`, proyecto Chat de PR): la persona conversa con un agente que trabaja
 * en un borrador propio del PR (`ChatScratch`), y lo que el agente cambia queda como propuesta versionada (el diff
 * real del borrador contra la punta del PR) hasta que la persona la aplica.
 *
 * La conversación no es un flujo, a propósito: una corrida que espera el próximo mensaje ocuparía un cupo de carril
 * mientras está `waiting`, y un gate por mensaje llenaría la bandeja. Cada mensaje es un turno suelto de `Agents`
 * (rol `chat`, modo `turn`) que retoma la sesión del anterior. Lo que sí es un flujo es aplicar la propuesta
 * (`chat-aplicar` y `chat-aplicar-local`, carril maintenance): ahí se escribe en el worktree del PR y se publica, y
 * eso necesita leases, préstamo, reintentos, breakers y recuperación tras un corte.
 */
export interface PrChats {
  /** El chat activo del PR (lo abre si no hay), con sus mensajes y la propuesta vigente. */
  get(prId: string): Promise<ChatSnapshot>;
  /** Guarda el mensaje y lanza el turno sin esperarlo; el resultado llega por los eventos `chat.*`. */
  send(input: SendInput, origin: Origin): Promise<PrChat>;
  /** Corta el turno en curso: queda un mensaje `system` y la sesión se puede retomar. */
  interrupt(chatId: ChatId, origin: Origin): PrChat;
  /** Archiva el chat (y su borrador) y abre uno nuevo para el mismo PR, con el mismo runtime y modelo. */
  reset(chatId: ChatId, origin: Origin): Promise<PrChat>;
  /** El patch de la propuesta `rev` contra su `base_sha`, con sus archivos; con `since`, solo lo que cambió desde esa rev. */
  proposal(chatId: ChatId, rev: number, since?: number): Promise<{ patch: string; files: LocalPrFile[] }>;
  /** Devuelve el borrador a la punta del PR y deja la propuesta vigente `discarded`. */
  discard(chatId: ChatId, origin: Origin): Promise<PrChat>;
  /** Lanza la corrida que aplica la propuesta `rev` al PR; solo `origin: "ui"`. */
  apply(input: { chatId: ChatId; rev: number }, origin: Origin): { runId: RunId };
  /** Cierra los turnos que un core anterior dejó a medias. Va antes de levantar la API. */
  recover(): void;
  /** Interrumpe los turnos en curso y deja de escuchar las corridas de aplicar. */
  close(): Promise<void>;
}

export interface SendInput {
  chatId: ChatId;
  text: string;
  refs?: ChatRef[];
  runtime?: AgentRuntimeId;
  model?: string;
  effort?: Effort;
}

export interface ChatSnapshot {
  chat: PrChat;
  messages: ChatMessage[];
  proposal: ChatProposal | null;
}

/** El rol y el modo de un turno; los define la plantilla. */
export const CHAT_ROLE = "chat";
export const CHAT_MODE = "turn";
/** Cuántos mensajes lleva el handoff de una sesión nueva (cambio de runtime o modelo, o sesión compactada). */
export const CHAT_HANDOFF_MESSAGES = 12;
/** Los flujos que aplican una propuesta (`template/flows.ts`). */
export const CHAT_APPLY_FLOWS = { remote: "chat-aplicar", local: "chat-aplicar-local" } as const;

type ChatRow = typeof prChats.$inferSelect;
type ProposalRow = typeof prChatProposals.$inferSelect;

export interface PrChatsDeps {
  store: Store;
  agents: Pick<Agents, "run" | "resume">;
  runtimes: Pick<RuntimeRegistry, "get" | "idFor">;
  scratch: ChatScratch;
  defs: Defs;
  projects: Pick<Projects, "get" | "defaults">;
  breakers: Pick<Breakers, "openReason">;
  artifacts: Artifacts;
  details: Pick<PrDetails, "get">;
  repoConfig: (repoId: PrRow["repoId"]) => RepoConfig;
  flows: Pick<Engine, "start">;
  errors: ErrorReporter;
  now?: () => number;
}

export function createPrChats(deps: PrChatsDeps): PrChats {
  const { store, scratch, now = Date.now } = deps;
  /** Los turnos en curso de este core: `interrupt` aborta su `signal`. */
  const turns = new Map<ChatId, { abort: AbortController; done: Promise<void>; interrupted: boolean }>();

  function chatRow(chatId: ChatId): ChatRow {
    const row = store.db.select().from(prChats).where(eq(prChats.id, chatId)).get();
    if (!row) throw new NotFoundError(`No existe el chat ${chatId}.`);
    return row;
  }

  function prOf(row: ChatRow): PrRow {
    const pr = prById(store.db, row.prId);
    if (!pr) throw new NotFoundError(`No existe el PR ${row.prId}.`);
    return pr;
  }

  /** El proyecto del PR: el de la corrida que lo abrió. */
  function projectOf(pr: PrRow) {
    if (!pr.runId) return undefined;
    const projectId = store.db.select({ id: runs.projectId }).from(runs).where(eq(runs.id, pr.runId)).get()?.id;
    return projectId ? deps.projects.get(projectId) : undefined;
  }

  /** El perfil de los turnos: el del proyecto del PR, el de los proyectos nuevos o, sin ninguno, el primero que exista. */
  function profileOf(pr: PrRow): string {
    const slug = projectOf(pr)?.defaultProfileId ?? deps.projects.defaults().defaultProfileId;
    if (slug && deps.defs.resolve("profile", slug, { repoId: pr.repoId })) return slug;
    const first = deps.defs.list("profile").map((def) => def.slug).sort()[0];
    if (!first) throw new BadRequestError("No hay ningún perfil de agentes: crea uno en Ajustes > Perfiles para chatear.");
    return first;
  }

  /** La entrada `chat` del perfil: el runtime y el modelo con que abre un chat nuevo. */
  function chatEntry(pr: PrRow) {
    const profile = profileOf(pr);
    const def = deps.defs.resolve("profile", profile, { repoId: pr.repoId });
    const entry = def ? Profile.safeParse(def.body).data?.roles[CHAT_ROLE] : undefined;
    if (!entry) throw new BadRequestError(`El perfil "${profile}" no define el rol ${CHAT_ROLE}: agrégalo en Ajustes > Perfiles.`);
    return { profile, runtime: entry.runtime ?? DEFAULT_AGENT_RUNTIME, model: entry.model, effort: entry.effort };
  }

  function messagesOf(chatId: ChatId): ChatMessage[] {
    return store.db.select().from(prChatMessages).where(eq(prChatMessages.chatId, chatId)).orderBy(sql`rowid`).all()
      .map((m) => ({
        id: m.id,
        role: m.role,
        text: m.text,
        ...(m.sessionId && { sessionId: m.sessionId as ChatMessage["sessionId"] }),
        ...(m.proposalRev !== null && { proposalRev: m.proposalRev }),
        ...(m.refs && m.refs.length > 0 && { refs: m.refs }),
        at: m.at,
      }));
  }

  function latestProposal(chatId: ChatId): ProposalRow | undefined {
    return store.db.select().from(prChatProposals).where(eq(prChatProposals.chatId, chatId)).orderBy(desc(prChatProposals.rev)).limit(1).get();
  }

  /** Una propuesta `draft` cuya base ya no es la punta del PR está `stale`: aplicarla podría no calzar. */
  function viewOf(row: ProposalRow, pr: PrRow): ChatProposal {
    const stale = row.status === "draft" && pr.headSha !== null && pr.headSha !== row.baseSha;
    return {
      rev: row.rev,
      baseSha: row.baseSha,
      summary: row.summary,
      items: row.items,
      files: row.files,
      status: stale ? "stale" : row.status,
      ...(row.runId && { runId: row.runId }),
      ...(row.note && { note: row.note }),
      ...(row.result && { result: row.result }),
    };
  }

  /** Por qué no se puede aplicar nada en este PR, o `undefined`. Lo de la propuesta (estado, turno) lo dice la UI. */
  function applyBlocker(pr: PrRow): string | undefined {
    if (!pr.owned) return "Clanker Yard no abrió este PR: aplica los cambios a mano o pídeselos a su autor.";
    if (pr.state === "merged" || pr.state === "closed") return `El PR ya está ${pr.state === "merged" ? "mergeado" : "cerrado"}.`;
    return undefined;
  }

  function toChat(row: ChatRow, pr: PrRow): PrChat {
    const reason = applyBlocker(pr);
    return {
      id: row.id,
      prId: row.prId,
      status: row.status,
      runtime: row.runtime,
      model: row.model,
      ...(row.effort && { effort: row.effort }),
      busy: row.turnStartedAt !== null,
      ...(row.turnStartedAt !== null && row.turnSessionId && { turnSessionId: row.turnSessionId as PrChat["turnSessionId"] }),
      costMicros: row.costMicros,
      canApply: reason === undefined,
      ...(reason && { applyReason: reason }),
    };
  }

  const chatOfRow = (row: ChatRow) => toChat(row, prOf(row));

  function addMessage(tx: Tx, chat: ChatRow, message: Omit<typeof prChatMessages.$inferInsert, "id" | "chatId" | "at">, origin: Origin = "core"): void {
    tx.db.insert(prChatMessages).values({ id: newId("msg"), chatId: chat.id, at: now(), ...message }).run();
    tx.emit({ type: "chat.message", origin, subject: { type: "pr", id: chat.prId }, payload: { chatId: chat.id, prId: chat.prId } });
  }

  function openChat(pr: PrRow, from?: Pick<ChatRow, "runtime" | "model" | "effort">): ChatRow {
    const entry = from ?? chatEntry(pr);
    const at = now();
    const row: ChatRow = {
      id: newId("chat"),
      prId: pr.id,
      status: "active",
      runtime: entry.runtime,
      model: entry.model,
      effort: entry.effort ?? null,
      sessionId: null,
      turnStartedAt: null,
      turnSessionId: null,
      costMicros: 0,
      createdAt: at,
      updatedAt: at,
    };
    store.tx(({ db }) => db.insert(prChats).values(row).run());
    return row;
  }

  function activeChat(prId: string): ChatRow | undefined {
    return store.db.select().from(prChats).where(and(eq(prChats.prId, prId), eq(prChats.status, "active"))).get();
  }

  // ---- Turnos ----

  /** Lo que el agente lee del PR en `.clanker-run/`: descripción, contexto de GitHub, diff e issue. */
  async function writeBrief(path: string, pr: PrRow, text: string, refs: ChatRef[] | undefined): Promise<Record<string, string>> {
    const detail = await deps.details.get(pr.id);
    const dir = join(path, ".clanker-run");
    mkdirSync(dir, { recursive: true });
    const artifacts: Record<string, string> = {};
    const write = (name: string, content: string) => {
      writeFileSync(join(dir, name), content);
      artifacts[name.replace(/\.[^.]+$/, "").replace(/-/g, "_")] = `.clanker-run/${name}`;
    };
    write("pr.md", prMarkdown(pr, detail.title, detail.body, pr.detail ?? undefined));
    const from = await git(path, ["merge-base", detail.baseSha, detail.head]);
    write("diff.patch", await gitRaw(path, ["diff", "--no-color", "--no-renames", from, detail.head]));
    const issue = pr.issueId ? store.db.select().from(issues).where(eq(issues.id, pr.issueId)).get() : undefined;
    if (issue) write("issue.md", `# ${issue.key}: ${issue.title}\n\n${issue.body}\n`);
    if (refs && refs.length > 0) write("refs.md", refsMarkdown(refs));
    void text;
    return artifacts;
  }

  /** El aviso de un `sync` que movió el borrador: el agente tiene que saber que la punta cambió y qué chocó. */
  function syncNotice(result: ScratchSyncResult): string | undefined {
    if (result.outcome === "same") return undefined;
    const moved = `El PR avanzó de ${result.from.slice(0, 12)} a ${result.headSha.slice(0, 12)} desde el turno anterior: el borrador ya está sobre la punta nueva con tus cambios reaplicados.`;
    if (result.outcome === "moved") return moved;
    return `${moved}\n\nAlgunos cambios del borrador chocaron con la punta nueva (${result.conflicts.join(", ")}); esos archivos quedaron con marcas de conflicto o con su versión anterior. Resuélvelos antes de seguir.\n${result.failures}`;
  }

  /** El handoff de una sesión nueva: los últimos mensajes y lo que tiene el borrador contra la punta del PR. */
  async function handoffOf(chat: ChatRow, path: string, head: string, reason: string): Promise<string> {
    const recent = messagesOf(chat.id).slice(-CHAT_HANDOFF_MESSAGES - 1, -1);
    const stat = (await git(path, ["diff", "--stat", head]).catch(() => "")).trim() || "(el borrador no tiene cambios)";
    return [
      `Handoff: esta conversación ${reason}, así que esta sesión parte de cero. Los últimos mensajes:`,
      recent.map((m) => `**${m.role}**: ${m.text}`).join("\n\n") || "(sin mensajes anteriores)",
      `Lo que tiene el borrador contra la punta del PR (git diff --stat):\n${stat}`,
    ].join("\n\n");
  }

  /** Por qué el próximo turno abre una sesión nueva en vez de retomar la anterior, o `undefined`. */
  function whyNewSession(chat: ChatRow): string | undefined {
    if (!chat.sessionId) return undefined;
    const session = store.db.select().from(agentSessions).where(eq(agentSessions.id, chat.sessionId)).get();
    if (!session) return "perdió su sesión anterior";
    if (session.runtime !== effectiveRuntime(chat.runtime)) return `cambió de runtime (${session.runtime} a ${chat.runtime})`;
    if (session.model !== chat.model) return `cambió de modelo (${session.model} a ${chat.model})`;
    if ((session.effort ?? null) !== (chat.effort ?? null)) return "cambió de esfuerzo";
    if (session.compactions > 0) return "se compactó";
    return undefined;
  }

  /** Si este core corre `runtime` (con `CORE_RUNTIME`, todo corre en el forzado). */
  function hasRuntime(runtime: AgentRuntimeId): boolean {
    try {
      deps.runtimes.get(runtime);
      return true;
    } catch {
      return false;
    }
  }

  /** El runtime que de verdad corre un turno del chat: el elegido si este core lo tiene, si no el que use por defecto. */
  const effectiveRuntime = (runtime: AgentRuntimeId) => (hasRuntime(runtime) ? deps.runtimes.get(runtime).id : deps.runtimes.idFor(undefined));

  const turnNumber = (chatId: ChatId) =>
    store.db.select({ id: prChatMessages.id }).from(prChatMessages).where(and(eq(prChatMessages.chatId, chatId), eq(prChatMessages.role, "user"))).all().length;

  async function runTurn(chatId: ChatId, text: string, refs: ChatRef[] | undefined, signal: AbortSignal): Promise<{ result: AgentResult; head: string; path: string }> {
    let chat = chatRow(chatId);
    const pr = prOf(chat);
    if (!pr.headSha) throw new BadRequestError("El PR todavía no tiene una punta conocida: actualízalo y vuelve a enviar el mensaje.");
    const path = await scratch.create(pr.repoId, chatId, pr.headSha);
    const synced = await scratch.sync(chatId, pr.headSha);
    const artifacts = await writeBrief(path, pr, text, refs);
    const turnRunId = newId("run");
    store.tx(({ db }) => db.update(prChats).set({ turnSessionId: null }).where(eq(prChats.id, chatId)).run());
    chat = chatRow(chatId);
    const issue = pr.issueId ? store.db.select().from(issues).where(eq(issues.id, pr.issueId)).get() : undefined;
    const brief: Brief = {
      run: { id: turnRunId, subject: { type: "pr", id: pr.id }, round: turnNumber(chatId), attempt: 0 },
      ...(issue && { issue: { key: issue.key, title: issue.title, criteria: [] } }),
      worktree: path,
      base: pr.headSha,
      mode: CHAT_MODE,
      artifacts,
      payload: { text: refs && refs.length > 0 ? `${text}\n\n(La persona citó lo que está en .clanker-run/refs.md.)` : text },
    };
    // Mientras el turno corre, `agent.started` dice su sesión: la UI la sigue en vivo.
    const stop = store.events.subscribe(
      ({ payload }) => {
        const { sessionId } = payload as { sessionId: string };
        store.tx((tx) => {
          tx.db.update(prChats).set({ turnSessionId: sessionId }).where(eq(prChats.id, chatId)).run();
          tx.emit({ type: "chat.turn_started", origin: "core", subject: { type: "pr", id: pr.id }, payload: { chatId, prId: pr.id } });
        });
      },
      { types: ["agent.started"], runId: turnRunId },
    );
    try {
      const placement = { profile: profileOf(pr), repoId: pr.repoId, signal, ...(projectOf(pr) && { projectId: projectOf(pr)!.id }) };
      const notices = [syncNotice(synced)];
      const fresh = whyNewSession(chat);
      if (chat.sessionId && fresh === undefined) {
        const notice = notices.filter(Boolean).join("\n\n") || undefined;
        return { result: await deps.agents.resume({ ...placement, sessionId: chat.sessionId, mode: CHAT_MODE, brief, ...(notice && { notice }) }), head: pr.headSha, path };
      }
      if (fresh !== undefined) notices.push(await handoffOf(chat, path, pr.headSha, fresh));
      const notice = notices.filter(Boolean).join("\n\n") || undefined;
      const result = await deps.agents.run({
        ...placement,
        role: CHAT_ROLE,
        mode: CHAT_MODE,
        brief,
        workspace: path,
        entry: { ...(hasRuntime(chat.runtime) && { runtime: chat.runtime }), model: chat.model, ...(chat.effort && { effort: chat.effort }) },
        ...(notice && { notice }),
      });
      return { result, head: pr.headSha, path };
    } finally {
      stop();
    }
  }

  /** Lo que el turno dejó en el borrador: una propuesta nueva si su árbol no es el de la anterior ni el de la punta. */
  async function proposalOfTurn(chat: ChatRow, path: string, head: string, described: { summary: string; items: ChatProposal["items"] } | null) {
    const tree = await snapshotTree(path);
    const headTree = await git(path, ["rev-parse", `${head}^{tree}`]);
    if (tree === headTree) return undefined;
    const previous = latestProposal(chat.id);
    if (previous && previous.status === "draft" && previous.baseSha === head) {
      const previousTree = await git(path, ["rev-parse", `${previous.snapshotSha}^{tree}`]);
      if (previousTree === tree) return undefined;
    }
    const rev = (previous?.rev ?? 0) + 1;
    const snap = await scratch.snapshot(chat.id, rev);
    const files = await filesOf(path, head, snap.sha);
    const hash = deps.artifacts.put(snap.patch, "snapshot", { mime: "text/x-diff" });
    deps.artifacts.ref(hash, { type: "chat", id: chat.id, role: `p${rev}` });
    return {
      rev,
      baseSha: head,
      snapshotRef: snap.ref,
      snapshotSha: snap.sha,
      patchHash: hash,
      summary: described?.summary ?? "El agente cambió el borrador sin describir el cambio: revisa el diff antes de aplicarlo.",
      items: described?.items ?? [],
      files,
    };
  }

  async function finishTurn(chatId: ChatId, outcome: { result: AgentResult; head: string; path: string } | { error: unknown }, interrupted: boolean): Promise<void> {
    const chat = chatRow(chatId);
    const subject = { type: "pr" as const, id: chat.prId };
    const payload = { chatId, prId: chat.prId };
    let proposal: Awaited<ReturnType<typeof proposalOfTurn>>;
    let reply: string | undefined;
    let failure: string | undefined;
    let sessionId: string | undefined;
    if ("error" in outcome) {
      failure = `El turno falló: ${messageOf(outcome.error)}`;
    } else {
      sessionId = outcome.result.sessionId;
      if (outcome.result.status === "success") {
        const report = outcome.result.report.payload as { reply?: string; proposal?: { summary: string; items: ChatProposal["items"] } | null };
        reply = report.reply ?? outcome.result.report.summary;
        try {
          proposal = await proposalOfTurn(chat, outcome.path, outcome.head, report.proposal ?? null);
        } catch (error) {
          failure = `No se pudo guardar la propuesta del turno: ${messageOf(error)}`;
        }
      } else if (interrupted) {
        failure = "Interrumpiste el turno. El borrador conserva lo que el agente alcanzó a cambiar; envía otro mensaje para seguir.";
        try {
          proposal = await proposalOfTurn(chat, outcome.path, outcome.head, null);
        } catch {
          // Lo que no se pudo guardar sigue en el borrador y entra en la próxima propuesta.
        }
      } else {
        failure = turnFailure(outcome.result);
      }
    }
    const cost = sessionId ? store.db.select({ cost: agentSessions.costMicros }).from(agentSessions).where(eq(agentSessions.id, sessionId)).get()?.cost ?? 0 : 0;
    const before = chat.sessionId === sessionId ? sessionCostBefore.get(chatId) ?? 0 : 0;
    store.tx((tx) => {
      tx.db.update(prChats).set({
        turnStartedAt: null,
        turnSessionId: null,
        ...(sessionId && { sessionId }),
        costMicros: chat.costMicros + Math.max(0, cost - before),
        updatedAt: now(),
      }).where(eq(prChats.id, chatId)).run();
      if (proposal) {
        const at = now();
        tx.db.insert(prChatProposals).values({ chatId, ...proposal, status: "draft", createdAt: at, updatedAt: at }).run();
      }
      if (reply !== undefined) addMessage(tx, chat, { role: "assistant", text: reply, sessionId: sessionId ?? null, proposalRev: proposal?.rev ?? null });
      if (failure !== undefined) addMessage(tx, chat, { role: "system", text: failure, sessionId: sessionId ?? null, proposalRev: reply === undefined ? proposal?.rev ?? null : null });
      if (proposal) tx.emit({ type: "chat.proposal", origin: "core", subject, payload });
      tx.emit({ type: "chat.turn_finished", origin: "core", subject, payload });
    });
    sessionCostBefore.delete(chatId);
  }

  /** El costo que la sesión ya tenía al empezar el turno: una sesión retomada acumula en la misma fila. */
  const sessionCostBefore = new Map<ChatId, number>();

  function startTurn(chatId: ChatId, text: string, refs: ChatRef[] | undefined): void {
    const abort = new AbortController();
    const chat = chatRow(chatId);
    if (chat.sessionId) {
      sessionCostBefore.set(chatId, store.db.select({ cost: agentSessions.costMicros }).from(agentSessions).where(eq(agentSessions.id, chat.sessionId)).get()?.cost ?? 0);
    }
    const entry = { abort, interrupted: false, done: Promise.resolve() };
    entry.done = (async () => {
      let outcome: Parameters<typeof finishTurn>[1];
      try {
        outcome = await runTurn(chatId, text, refs, abort.signal);
      } catch (error) {
        outcome = { error };
      }
      try {
        await finishTurn(chatId, outcome, entry.interrupted);
      } catch (error) {
        deps.errors.report("chats.turn", error);
        store.tx(({ db }) => db.update(prChats).set({ turnStartedAt: null, turnSessionId: null }).where(eq(prChats.id, chatId)).run());
      } finally {
        turns.delete(chatId);
      }
    })();
    turns.set(chatId, entry);
  }

  // ---- Aplicar ----

  function proposalRow(chatId: ChatId, rev: number): ProposalRow {
    const row = store.db.select().from(prChatProposals).where(and(eq(prChatProposals.chatId, chatId), eq(prChatProposals.rev, rev))).get();
    if (!row) throw new NotFoundError(`El chat ${chatId} no tiene la propuesta ${rev}.`);
    return row;
  }

  /** Al terminar una corrida de aplicar: el mensaje con el resultado y la propuesta `applied`, `stale` o `failed`. */
  async function onApplyFinished(runId: RunId, outcome: string): Promise<void> {
    const proposal = store.db.select().from(prChatProposals).where(eq(prChatProposals.runId, runId)).get();
    if (!proposal || proposal.status !== "applying") return;
    const chat = chatRow(proposal.chatId);
    const pr = prOf(chat);
    const summary = applySummaryOf(store, deps.artifacts, runId);
    const next: ChatProposal["status"] = outcome === "done" && summary.applied ? "applied" : summary.stale ? "stale" : "failed";
    const result = summary.applied ? { sha: summary.sha ?? pr.headSha ?? "", children: summary.children } : undefined;
    store.tx((tx) => {
      tx.db.update(prChatProposals).set({ status: next, ...(result && { result }), note: summary.note ?? null, updatedAt: now() })
        .where(and(eq(prChatProposals.chatId, proposal.chatId), eq(prChatProposals.rev, proposal.rev))).run();
      addMessage(tx, chat, { role: "system", text: applyMessage(next, summary, outcome), proposalRev: proposal.rev });
      tx.emit({ type: "chat.apply_finished", origin: "core", subject: { type: "pr", id: chat.prId }, payload: { chatId: chat.id, prId: chat.prId } });
    });
    // Aplicada, el borrador sigue a la punta nueva: la próxima propuesta parte de ahí.
    if (next === "applied" && chat.status === "active") {
      const head = prById(store.db, chat.prId)?.headSha;
      await scratch.discard(chat.id);
      if (head) await scratch.sync(chat.id, head);
    }
  }

  /** Una corrida de aplicar que se estacionó sigue `applying`: el chat avisa que espera una decisión. */
  function onApplyParked(runId: RunId): void {
    const proposal = store.db.select().from(prChatProposals).where(eq(prChatProposals.runId, runId)).get();
    if (!proposal || proposal.status !== "applying") return;
    const chat = chatRow(proposal.chatId);
    store.tx((tx) => addMessage(tx, chat, { role: "system", text: "La corrida que aplica la propuesta quedó esperando una decisión: respóndela en la bandeja.", proposalRev: proposal.rev }));
  }

  /** Lo que se hace al terminar una corrida de aplicar sigue en curso al cerrar: `close` lo espera. */
  const pendingApplies = new Set<Promise<void>>();
  function track(work: Promise<void>): void {
    const tracked = work.catch((error: unknown) => deps.errors.report("chats.apply", error)).finally(() => pendingApplies.delete(tracked));
    pendingApplies.add(tracked);
  }

  const stopApplyWatch = store.events.subscribe(
    (event) => {
      const runId = event.runId;
      if (!runId) return;
      if (event.type === "run.parked") return onApplyParked(runId);
      const outcome = (event.payload as { outcome?: string }).outcome ?? "failed";
      track(onApplyFinished(runId, outcome));
    },
    { types: ["run.finished", "run.parked"] },
  );

  return {
    async get(prId) {
      const pr = prById(store.db, prId);
      if (!pr) throw new NotFoundError(`No existe el PR ${prId}.`);
      const chat = activeChat(prId) ?? openChat(pr);
      const latest = latestProposal(chat.id);
      return { chat: toChat(chat, pr), messages: messagesOf(chat.id), proposal: latest ? viewOf(latest, pr) : null };
    },

    async send(input, origin) {
      const chat = chatRow(input.chatId);
      if (chat.status !== "active") throw new BadRequestError("Este chat está archivado: abre el chat vigente del PR para seguir.");
      if (chat.turnStartedAt !== null || turns.has(chat.id)) throw new BadRequestError("Ya hay un turno en curso: espera a que termine o interrúmpelo.");
      const applying = latestProposal(chat.id);
      if (applying?.status === "applying") throw new BadRequestError("Se está aplicando la propuesta: espera a que termine para seguir conversando.");
      const pr = prOf(chat);
      if (pr.state === "merged" || pr.state === "closed") throw new BadRequestError(`El PR ya está ${pr.state === "merged" ? "mergeado" : "cerrado"}: no hay nada más que cambiar en él.`);
      const runtime = input.runtime ?? chat.runtime;
      if (input.runtime !== undefined && !hasRuntime(input.runtime)) throw new BadRequestError(`Este core no tiene el runtime ${input.runtime}: elige otro.`);
      const breaker = deps.breakers.openReason(`runtime:${effectiveRuntime(runtime)}`);
      if (breaker) throw new BadRequestError(`El runtime ${runtime} está en pausa: ${breaker} Cuando se resuelva, vuelve a enviar el mensaje o cambia de runtime.`);
      const at = now();
      store.tx((tx) => {
        tx.db.update(prChats).set({
          runtime,
          ...(input.model !== undefined && { model: input.model }),
          ...(input.effort !== undefined && { effort: input.effort }),
          // Cambiar de runtime sin decir modelo toma el de la entrada del perfil para ese runtime... si es el mismo runtime.
          ...(input.runtime !== undefined && input.runtime !== chat.runtime && input.model === undefined && { model: modelFor(input.runtime, pr) }),
          turnStartedAt: at,
          turnSessionId: null,
          updatedAt: at,
        }).where(eq(prChats.id, chat.id)).run();
        addMessage(tx, chat, { role: "user", text: input.text, refs: input.refs ?? null }, origin);
        tx.emit({ type: "chat.turn_started", origin, subject: { type: "pr", id: chat.prId }, payload: { chatId: chat.id, prId: chat.prId } });
      });
      startTurn(chat.id, input.text, input.refs);
      return chatOfRow(chatRow(chat.id));
    },

    interrupt(chatId, origin) {
      const chat = chatRow(chatId);
      const turn = turns.get(chatId);
      if (!turn) {
        if (chat.turnStartedAt === null) throw new BadRequestError("No hay un turno en curso.");
        // El turno es de un core anterior (no debería pasar tras `recover`): se cierra igual.
        store.tx((tx) => {
          tx.db.update(prChats).set({ turnStartedAt: null, turnSessionId: null }).where(eq(prChats.id, chatId)).run();
          addMessage(tx, chat, { role: "system", text: "Interrumpiste el turno." }, origin);
          tx.emit({ type: "chat.turn_finished", origin, subject: { type: "pr", id: chat.prId }, payload: { chatId, prId: chat.prId } });
        });
        return chatOfRow(chatRow(chatId));
      }
      turn.interrupted = true;
      turn.abort.abort();
      return chatOfRow(chat);
    },

    async reset(chatId, origin) {
      const chat = chatRow(chatId);
      if (chat.turnStartedAt !== null || turns.has(chatId)) throw new BadRequestError("Hay un turno en curso: interrúmpelo antes de reiniciar el chat.");
      if (latestProposal(chatId)?.status === "applying") throw new BadRequestError("Se está aplicando la propuesta: espera a que termine para reiniciar el chat.");
      if (chat.status !== "active") throw new BadRequestError("Este chat ya está archivado.");
      const pr = prOf(chat);
      store.tx((tx) => {
        tx.db.update(prChats).set({ status: "archived", updatedAt: now() }).where(eq(prChats.id, chatId)).run();
        tx.emit({ type: "chat.message", origin, subject: { type: "pr", id: chat.prId }, payload: { chatId, prId: chat.prId } });
      });
      await scratch.remove(chatId).catch((error: unknown) => deps.errors.report("chats.reset", error));
      return toChat(openChat(pr, chat), pr);
    },

    async proposal(chatId, rev, since) {
      const row = proposalRow(chatId, rev);
      if (since !== undefined) {
        if (since >= rev) throw new BadRequestError(`La propuesta ${since} no es anterior a la ${rev}.`);
        const previous = proposalRow(chatId, since);
        const repo = deps.repoConfig(prOf(chatRow(chatId)).repoId).path;
        return { patch: await diffBetween(repo, previous.snapshotSha, row.snapshotSha), files: await filesOf(repo, previous.snapshotSha, row.snapshotSha) };
      }
      const artifact = deps.artifacts.get(row.patchHash as ArtifactHash);
      if (!artifact) throw new NotFoundError(`El patch de la propuesta ${rev} ya no está guardado.`);
      return { patch: Buffer.from(artifact.content).toString("utf8"), files: row.files };
    },

    async discard(chatId, origin) {
      const chat = chatRow(chatId);
      if (chat.turnStartedAt !== null || turns.has(chatId)) throw new BadRequestError("El agente está trabajando: interrumpe el turno antes de descartar.");
      const latest = latestProposal(chatId);
      if (latest?.status === "applying") throw new BadRequestError("La propuesta se está aplicando: ya no se puede descartar.");
      await scratch.discard(chatId);
      const pr = prOf(chat);
      if (pr.headSha) await scratch.sync(chatId, pr.headSha);
      store.tx((tx) => {
        if (latest && (latest.status === "draft" || latest.status === "stale" || latest.status === "failed")) {
          tx.db.update(prChatProposals).set({ status: "discarded", updatedAt: now() })
            .where(and(eq(prChatProposals.chatId, chatId), eq(prChatProposals.rev, latest.rev))).run();
        }
        addMessage(tx, chat, { role: "system", text: latest ? `Descartaste la propuesta ${latest.rev}: el borrador volvió a la punta del PR.` : "El borrador volvió a la punta del PR." , ...(latest && { proposalRev: latest.rev }) }, origin);
      });
      return chatOfRow(chatRow(chatId));
    },

    apply({ chatId, rev }, origin) {
      requireUiOrigin(origin, "Aplicar la propuesta lo pide una persona desde la app: publica con tu cuenta.");
      const chat = chatRow(chatId);
      const pr = prOf(chat);
      const blocker = applyBlocker(pr);
      if (blocker) throw new BadRequestError(blocker);
      if (chat.turnStartedAt !== null || turns.has(chatId)) throw new BadRequestError("El agente está trabajando: espera a que termine el turno para aplicar.");
      const latest = latestProposal(chatId);
      if (!latest || latest.rev !== rev) throw new BadRequestError(`La propuesta ${rev} ya no es la vigente${latest ? `: aplica la ${latest.rev}` : ""}.`);
      const view = viewOf(latest, pr);
      if (view.status !== "draft") throw new BadRequestError(view.status === "stale" ? "El PR cambió desde la propuesta: pídele al agente que la rehaga sobre el PR actual." : `La propuesta está ${view.status}: no se puede aplicar.`);
      const project = projectOf(pr);
      const local = pr.state === "local";
      const params = {
        prId: pr.id,
        chatId,
        rev,
        repo: pr.repoId,
        branch: pr.headRef,
        base: pr.baseRef,
        ...(!local && { pr: { account: deps.repoConfig(pr.repoId).remote?.account, repo: deps.repoConfig(pr.repoId).remote?.repo, number: pr.number } }),
      };
      const runId = deps.flows.start(local ? CHAT_APPLY_FLOWS.local : CHAT_APPLY_FLOWS.remote, { type: "pr", id: pr.id }, params, {
        ...(project && { projectId: project.id }),
        repoId: pr.repoId,
        profile: profileOf(pr),
        by: origin,
      });
      store.tx((tx) => {
        tx.db.update(prChatProposals).set({ status: "applying", runId, updatedAt: now() })
          .where(and(eq(prChatProposals.chatId, chatId), eq(prChatProposals.rev, rev))).run();
        addMessage(tx, chat, { role: "system", text: `Aplicando la propuesta ${rev} al PR.`, proposalRev: rev }, origin);
        tx.emit({ type: "chat.apply_started", origin, subject: { type: "pr", id: chat.prId }, payload: { chatId, prId: chat.prId } });
      });
      return { runId };
    },

    recover() {
      const cut = store.db.select().from(prChats).where(isNotNull(prChats.turnStartedAt)).all();
      for (const chat of cut) {
        store.tx((tx) => {
          tx.db.update(prChats).set({ turnStartedAt: null, turnSessionId: null }).where(eq(prChats.id, chat.id)).run();
          addMessage(tx, chat, { role: "system", text: "El turno se interrumpió porque la app se reinició: vuelve a enviar el mensaje." });
          tx.emit({ type: "chat.turn_finished", origin: "core", subject: { type: "pr", id: chat.prId }, payload: { chatId: chat.id, prId: chat.prId } });
        });
      }
      // Una corrida de aplicar que terminó con el core apagado no llegó a avisar.
      const applying = store.db.select().from(prChatProposals).where(eq(prChatProposals.status, "applying")).all();
      for (const proposal of applying) {
        const run = proposal.runId && store.db.select().from(runs).where(eq(runs.id, proposal.runId)).get();
        if (run && (run.status === "done" || run.status === "failed" || run.status === "canceled")) {
          track(onApplyFinished(proposal.runId!, run.outcome ?? run.status));
        }
      }
    },

    async close() {
      stopApplyWatch();
      for (const turn of turns.values()) {
        turn.interrupted = true;
        turn.abort.abort();
      }
      await Promise.all([...turns.values()].map((turn) => turn.done));
      await Promise.all([...pendingApplies]);
    },
  };

  /** El modelo de la entrada `chat` del perfil si usa ese runtime; si no, el que ya tenía el chat (la persona lo cambia). */
  function modelFor(runtime: AgentRuntimeId, pr: PrRow): string {
    const entry = chatEntry(pr);
    return entry.runtime === runtime ? entry.model : chatRowModel(pr);
  }

  function chatRowModel(pr: PrRow): string {
    return activeChat(pr.id)?.model ?? chatEntry(pr).model;
  }
}

/** Los archivos de `from..to` con +/−, como los de `prs.detail`. */
async function filesOf(path: string, from: string, to: string): Promise<LocalPrFile[]> {
  return (await gitRaw(path, ["diff", "--numstat", "-z", "--no-renames", from, to]))
    .split("\0")
    .filter((line) => line.length > 0)
    .map((line) => {
      const [additions = "-", deletions = "-", ...rest] = line.split("\t");
      return { path: rest.join("\t"), additions: additions === "-" ? null : Number(additions), deletions: deletions === "-" ? null : Number(deletions) };
    });
}

function prMarkdown(pr: PrRow, title: string, body: string, state: PrState | undefined): string {
  const lines = [`# ${title}`, "", `Branch \`${pr.headRef}\` sobre \`${pr.baseRef}\`${pr.state === "local" ? " (PR local, todavía no está en GitHub)" : pr.number ? `, PR #${pr.number}` : ""}.`, "", body.trim() || "(sin descripción)"];
  if (state && pr.state !== "local") {
    if (state.ci.failing.length > 0) {
      lines.push("", "## CI en rojo", ...state.ci.failing.map((check) => `- ${check}${state.ci.details?.[check]?.description ? `: ${state.ci.details[check]!.description}` : ""}`));
    }
    if (state.bot.state === "findings" && state.bot.findings.length > 0) {
      lines.push("", "## Hallazgos del bot de review", ...state.bot.findings.map((f) => `- ${f.path ? `\`${f.path}${f.line ? `:${f.line}` : ""}\`: ` : ""}${f.text}`));
    }
    if (state.threads.unresolved > 0) lines.push("", `## Threads`, `Hay ${state.threads.unresolved} threads sin resolver en GitHub.`);
  }
  return `${lines.join("\n")}\n`;
}

function refsMarkdown(refs: ChatRef[]): string {
  return `${refs.map((ref) =>
    ref.kind === "lines"
      ? `## \`${ref.path}:${ref.start}${ref.end !== ref.start ? `-${ref.end}` : ""}\`\n\n\`\`\`\n${ref.text}\n\`\`\``
      : `## Thread ${ref.id}${ref.path ? ` en \`${ref.path}${ref.line ? `:${ref.line}` : ""}\`` : ""}${ref.author ? ` (de ${ref.author})` : ""}\n\n${ref.text}`,
  ).join("\n\n")}\n`;
}

function turnFailure(result: Exclude<AgentResult, { status: "success" }>): string {
  switch (result.status) {
    case "login_expired":
      return `El runtime ${result.runtime ?? ""} no tiene sesión: vuelve a conectarlo en Conexiones y reenvía el mensaje. (${result.message})`;
    case "quota_exhausted":
      return `Se agotó la cuota del runtime ${result.runtime ?? ""}${result.resetsAt ? ` hasta ${new Date(result.resetsAt).toLocaleString()}` : ""}: cambia de runtime o espera y reenvía el mensaje.`;
    case "error_max_turns":
    case "error_max_budget_usd":
      return `El turno llegó al tope del perfil (${result.status === "error_max_turns" ? "turnos" : "gasto"}): pide algo más acotado o sube el tope del rol chat en el perfil.`;
    case "report_invalid":
      return `El agente no entregó una respuesta válida: vuelve a enviar el mensaje. (${result.message})`;
    default:
      return `El turno falló: ${result.message}`;
  }
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}


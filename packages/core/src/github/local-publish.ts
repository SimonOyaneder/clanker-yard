import { createHash } from "node:crypto";
import { APPROVE_LOCAL_PUBLISH, DECLINE_LOCAL_PUBLISH, type ClientOrigin, type Decision, type DecisionId } from "@clanker/api";
import { and, eq } from "drizzle-orm";
import { closeDecision, openDecision } from "../decisions/decisions";
import { BadRequestError, requireUiOrigin } from "../errors/domain";
import type { Engine } from "../flows/engine";
import { tryGit } from "../git/git";
import type { RepoConfig, Repos } from "../repos/repos";
import { decisions, localPublishRequests, pullRequests, runs } from "../store/schema";
import type { Store } from "../store/store";
import type { PrRow } from "./pr-cache";
import { ownedLocalPr } from "./pr-commands";
import { livePrFlow, prById } from "./pr-rows";

const FLOW = "promote-approved-local";
type Remote = NonNullable<RepoConfig["remote"]>;

/** Vincula la aprobación al contenido y destino que la persona vio, no solo al id del PR. */
export function localPublishFingerprint(row: PrRow, remote: Remote, head: string): string {
  return createHash("sha256").update(JSON.stringify([row.id, row.headRef, row.baseRef, head, row.title, row.body, remote.repo, remote.account])).digest("hex");
}

export function createLocalPublish({ store, repos, flows }: { store: Store; repos: Pick<Repos, "config">; flows: Pick<Engine, "start"> }) {
  function publishing(id: string) {
    const live = livePrFlow(store.db, id, ["promote-local", FLOW]);
    if (live) throw new BadRequestError(`El PR ya se está publicando en la corrida ${live.id}.`);
  }

  async function snapshot(id: string) {
    const row = ownedLocalPr(prById(store.db, id), id);
    const { path, remote } = repos.config(row.repoId);
    if (!remote) throw new BadRequestError("Conecta GitHub para publicar este PR local.");
    const head = await tryGit(path, ["rev-parse", "--verify", "--quiet", `refs/heads/${row.headRef}^{commit}`]);
    if (!head) throw new BadRequestError(`No existe la rama local ${row.headRef}: restáurala antes de publicar.`);
    const fingerprint = localPublishFingerprint(row, remote, head);
    // Durante la lectura de Git pudo cambiar el PR o la cuenta conectada.
    const current = ownedLocalPr(prById(store.db, id), id);
    const target = repos.config(current.repoId).remote;
    if (!target || localPublishFingerprint(current, target, head) !== fingerprint) throw changed();
    const localBase = store.db.select({ id: pullRequests.id }).from(pullRequests)
      .where(and(eq(pullRequests.repoId, row.repoId), eq(pullRequests.headRef, row.baseRef), eq(pullRequests.state, "local"))).get();
    if (localBase) throw new BadRequestError(`La rama base ${row.baseRef} todavía es local. Publica primero su PR (${localBase.id}) o espera a que se integre.`);
    return { row, remote, head, fingerprint };
  }

  /** La solicitud solo crea una pregunta; repetirla para la misma revisión no duplica la entrada. */
  async function request(id: string, by: ClientOrigin): Promise<DecisionId> {
    const { row, remote, head, fingerprint } = await snapshot(id);
    publishing(id);
    return store.tx((tx) => {
      const pending = tx.db.select({ id: decisions.id, fingerprint: localPublishRequests.fingerprint }).from(localPublishRequests)
        .innerJoin(decisions, eq(decisions.id, localPublishRequests.decisionId))
        .where(and(eq(localPublishRequests.prId, id), eq(decisions.status, "pending"))).all();
      const same = pending.find((p) => p.fingerprint === fingerprint);
      if (same) return same.id;
      for (const p of pending) closeDecision(tx, p.id, { status: "superseded", by: "core" });
      const projectId = row.runId ? tx.db.select({ id: runs.projectId }).from(runs).where(eq(runs.id, row.runId)).get()?.id : undefined;
      const decision = openDecision(tx, {
        kind: "question",
        title: `¿Publicar ${row.title ?? row.headRef} en GitHub?`,
        body: [
          `Destino: ${remote.repo} · cuenta: ${remote.account}`,
          `Rama: ${row.headRef} → ${row.baseRef} · commit: ${head.slice(0, 12)}`,
          "Revisa el diff y la descripción en Stacks de PR. Al aprobar, se ejecutan los checks del repo. Si pasan y el PR no cambió, se publica como borrador con tu cuenta.",
        ].join("\n"),
        subject: { type: "pr", id },
        projectId,
        options: [APPROVE_LOCAL_PUBLISH, DECLINE_LOCAL_PUBLISH],
      }, by);
      tx.db.insert(localPublishRequests).values({ decisionId: decision.id, prId: id, fingerprint }).run();
      return decision.id;
    });
  }

  /** `undefined` para decisiones ajenas a publicación. No se puede aprobar ni descartar desde CLI o MCP. */
  async function resolve(id: DecisionId, option: string, by: ClientOrigin): Promise<Decision | undefined> {
    const offer = store.db.select().from(localPublishRequests).where(eq(localPublishRequests.decisionId, id)).get();
    if (!offer) return undefined;
    requireUiOrigin(by, "La publicación se decide en la Bandeja de la app y usa tu cuenta de GitHub.");
    if (option !== APPROVE_LOCAL_PUBLISH && option !== DECLINE_LOCAL_PUBLISH) throw new BadRequestError("Elige Publicar borrador en GitHub o No publicar.");
    const current = () => {
      const decision = store.db.select().from(decisions).where(eq(decisions.id, id)).get();
      if (!decision || decision.status !== "pending") throw new BadRequestError("Esta solicitud ya no está pendiente.");
      return decision;
    };
    current();
    if (option === DECLINE_LOCAL_PUBLISH) return store.tx((tx) => closeDecision(tx, id, { status: "answered", resolution: { option }, by })!);
    const { row, fingerprint } = await snapshot(offer.prId);
    if (fingerprint !== offer.fingerprint) throw changed();
    return store.tx((tx) => {
      const decision = current();
      publishing(row.id);
      const runId = flows.start(FLOW, { type: "pr", id: row.id },
        { prId: row.id, repo: row.repoId, branch: row.headRef, base: row.baseRef, approval: id },
        { by, tx, repoId: row.repoId, ...(decision.projectId && { projectId: decision.projectId }) });
      return closeDecision(tx, id, { status: "answered", resolution: { option }, by, runId })!;
    });
  }

  return { request, resolve };
}

function changed() {
  return new BadRequestError("El PR o su destino cambió. Revisa el PR y solicita la publicación otra vez.");
}

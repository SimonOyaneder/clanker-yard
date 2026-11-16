import type { Learning, LearningFilter, LearningVerdict, LearningId, LearningPatch, LearningSource, Origin, ProjectId, RepoId, RunId } from "@clanker/api";
import { and, desc, eq, inArray, isNull, or } from "drizzle-orm";
import type { AgentRuntime } from "../agents/runtime";
import { newId } from "../store/conventions";
import { learnings } from "../store/schema";
import type { Store, Tx } from "../store/store";
import { LearningScreenError, screenLearnings } from "./screen";
import { BadRequestError, NotFoundError, UiOnlyError } from "../errors/domain";

/** El learning pedido no existe. */
export class LearningNotFoundError extends NotFoundError {
  constructor(id: LearningId) {
    super(`No existe el learning ${id}.`);
  }
}

export { LearningScreenError };

/** El cambio pedido choca con otro learning: ya existe el mismo texto en el mismo alcance. */
export class LearningUpdateError extends BadRequestError {}

/** Dónde y para quién aplica un brief: el proyecto de la corrida, el repo de su worktree y el rol del paso. */
export interface BriefScope {
  projectId?: ProjectId;
  repoId?: RepoId;
  role: string;
}

export interface Learnings {
  /** De la más reciente a la más antigua. */
  list(filter?: LearningFilter): Learning[];
  get(id: LearningId): Learning | undefined;
  /** El mismo texto en el mismo alcance devuelve el que ya había, sin evento. */
  propose(input: { projectId?: ProjectId; repoId?: RepoId; text: string; roles: string[]; tags: string[] }, by: Origin): Learning;
  /**
   * Lo aprobado entra a los briefs de las corridas que siguen sin otra revisión: solo lo aprueba una persona desde la
   * app (`by: "ui"`). Otro origin lanza `UiOnlyError`: un agente que aprobara por el CLI se dejaría instrucciones a sí mismo.
   */
  approve(id: LearningId, by: Origin): Learning;
  /** Un `proposed` queda `rejected` y un `approved` queda `archived`. */
  reject(id: LearningId, by: Origin): Learning;
  /**
   * Cambia texto, roles o tags y emite `learning.updated` con los campos que llegaron y quién lo pidió. Uno aprobado
   * solo lo edita la app (`UiOnlyError` si no): el texto nuevo entraría a los briefs sin otra aprobación.
   */
  update(patch: LearningPatch, by: Origin): Learning;
  /**
   * Los textos `approved` que entran al brief de ese alcance: los del repo primero y luego los del
   * proyecto, cada grupo del más reciente al más antiguo. El brief corta en `MAX_LEARNINGS`.
   */
  forBrief(scope: BriefScope): string[];
  /** Los textos `proposed` del alcance, del más reciente al más antiguo: el brief de quien propone los lleva para no repetirlos. */
  pendingFor(scope: Pick<BriefScope, "projectId" | "repoId">): string[];
  /**
   * Un veredicto por cada `proposed` de un agente (de `projectId` si se da), con un agente barato y el criterio de
   * `LEARNING_CRITERIA`. No cambia nada: archivar lo que una persona confirme es `archive`.
   */
  screen(filter?: { projectId?: ProjectId }): Promise<LearningVerdict[]>;
  /** Un `proposed` pasa a `archived` (se puede volver a aprobar); cualquier otro se devuelve igual. Emite `learning.rejected`. */
  archive(ids: LearningId[], by: Origin): Learning[];
}

/** Con `runtime` el core puede filtrar los propuestos (`screen`); sin él, `screen` falla. */
/** Sin `runtime` no se pueden filtrar los propuestos (`screen`). */
export function createLearnings({ store, runtime }: { store: Store; runtime?: AgentRuntime }): Learnings {
  const find = (db: Store["db"] | Tx["db"], id: LearningId) => db.select().from(learnings).where(eq(learnings.id, id)).get();
  const need = (db: Store["db"] | Tx["db"], id: LearningId) => {
    const learning = find(db, id);
    if (!learning) throw new LearningNotFoundError(id);
    return learning;
  };

  /** Cambia el estado de un learning y emite el evento; `next` devuelve `undefined` si ya no hay nada que cambiar. */
  function move(id: LearningId, by: Origin, next: (status: Learning["status"]) => { to: Learning["status"]; type: "learning.approved" | "learning.rejected" } | undefined): Learning {
    return store.tx((tx) => {
      const learning = need(tx.db, id);
      const step = next(learning.status);
      if (!step) return learning;
      tx.emit({ type: step.type, origin: by, projectId: learning.projectId ?? undefined, payload: { learningId: id } });
      tx.db.update(learnings).set({ status: step.to }).where(eq(learnings.id, id)).run();
      return need(tx.db, id);
    });
  }

  const inScope = ({ projectId, repoId }: Pick<BriefScope, "projectId" | "repoId">) =>
    [projectId && eq(learnings.projectId, projectId), repoId && eq(learnings.repoId, repoId)].filter((c) => c !== undefined);

  return {
    list: (filter = {}) =>
      store.db
        .select()
        .from(learnings)
        .where(
          and(
            filter.projectId === undefined ? undefined : eq(learnings.projectId, filter.projectId),
            filter.repoId === undefined ? undefined : eq(learnings.repoId, filter.repoId),
            filter.status === undefined ? undefined : inArray(learnings.status, filter.status),
          ),
        )
        .orderBy(desc(learnings.id))
        .all(),
    get: (id) => find(store.db, id),
    propose: (input, by) => store.tx((tx) => proposeLearning(tx, { ...input, source: by === "import" ? "import" : "human", origin: by })),
    approve: (id, by) => {
      if (by !== "ui") throw new UiOnlyError("Un learning lo aprueba una persona desde la app.");
      return move(id, by, (status) => (status === "approved" ? undefined : { to: "approved", type: "learning.approved" }));
    },
    reject: (id, by) =>
      move(id, by, (status) => {
        if (status === "proposed") return { to: "rejected", type: "learning.rejected" };
        return status === "approved" ? { to: "archived", type: "learning.rejected" } : undefined;
      }),
    update: (patch, by) =>
      store.tx((tx) => {
        const learning = need(tx.db, patch.id);
        if (learning.status === "approved" && by !== "ui") {
          throw new UiOnlyError("Un learning aprobado solo se edita desde la app: el texto nuevo entra a los briefs sin otra aprobación.");
        }
        const { id, ...changes } = patch;
        const text = changes.text ?? learning.text;
        const clash = sameText(tx, text, learning.projectId, learning.repoId);
        if (clash && clash.id !== id) throw new LearningUpdateError(`Ya existe ese texto en el mismo alcance (${clash.id}).`);
        tx.db
          .update(learnings)
          .set({ text, roles: changes.roles ?? learning.roles, tags: changes.tags ?? learning.tags })
          .where(eq(learnings.id, id))
          .run();
        tx.emit({ type: "learning.updated", origin: by, projectId: learning.projectId ?? undefined, payload: { learningId: id, fields: Object.keys(changes).sort() } });
        return need(tx.db, id);
      }),
    screen: async ({ projectId } = {}) => {
      if (!runtime) throw new LearningScreenError("No hay un runtime de agentes para filtrar los learnings.");
      const proposed = store.db
        .select()
        .from(learnings)
        .where(and(eq(learnings.status, "proposed"), eq(learnings.source, "agent"), projectId === undefined ? undefined : eq(learnings.projectId, projectId)))
        .orderBy(desc(learnings.id))
        .all();
      return screenLearnings(runtime, proposed);
    },
    archive: (ids, by) =>
      ids.map((id) =>
        move(id, by, (status) => (status === "proposed" ? { to: "archived", type: "learning.rejected" } : undefined)),
      ),
    pendingFor: (scope) => {
      const where = inScope(scope);
      if (where.length === 0) return [];
      return store.db
        .select()
        .from(learnings)
        .where(and(eq(learnings.status, "proposed"), or(...where)))
        .orderBy(desc(learnings.id))
        .all()
        .map((l) => l.text);
    },
    forBrief: ({ projectId, repoId, role }) => {
      // Sin proyecto ni repo no hay alcance: un `or` vacío no filtraría nada y traería los de todos.
      const scope = inScope({ projectId, repoId });
      if (scope.length === 0) return [];
      return store.db
        .select()
        .from(learnings)
        .where(and(eq(learnings.status, "approved"), or(...scope)))
        .orderBy(desc(learnings.id))
        .all()
        .filter((l) => l.roles.length === 0 || l.roles.includes(role))
        .sort((a, b) => Number(b.repoId !== null) - Number(a.repoId !== null))
        .map((l) => l.text);
    },
  };
}

/** Minúsculas, sin backticks ni puntuación y con los espacios colapsados: dos textos que difieren solo en eso son el mismo learning. */
export function normalizeLearning(text: string): string {
  return text.toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, "").replace(/\s+/g, " ").trim();
}

/** El learning con ese texto (normalizado) en ese alcance, si lo hay. */
function sameText(tx: Tx, text: string, projectId: ProjectId | null, repoId: RepoId | null): Learning | undefined {
  const wanted = normalizeLearning(text);
  return tx.db
    .select()
    .from(learnings)
    .where(
      and(
        projectId === null ? isNull(learnings.projectId) : eq(learnings.projectId, projectId),
        repoId === null ? isNull(learnings.repoId) : eq(learnings.repoId, repoId),
      ),
    )
    .all()
    .find((l) => normalizeLearning(l.text) === wanted);
}

/**
 * Deja un learning `proposed` en la transacción de quien lo propone y emite `learning.proposed`. Si
 * el mismo texto (normalizado) ya está en ese alcance (en cualquier estado) devuelve el que había y no emite: el
 * reporte de un paso reintentado o la importación repetida no duplican, y lo rechazado no vuelve.
 */
export function proposeLearning(
  tx: Tx,
  input: {
    projectId?: ProjectId;
    repoId?: RepoId;
    text: string;
    roles?: string[];
    tags?: string[];
    source: LearningSource;
    sourceRunId?: RunId;
    origin: Origin;
  },
): Learning {
  const projectId = input.projectId ?? null;
  const repoId = input.repoId ?? null;
  const existing = sameText(tx, input.text, projectId, repoId);
  if (existing) return existing;

  const id = newId("lrn");
  const proposed = tx.emit({
    type: "learning.proposed",
    origin: input.origin,
    projectId: projectId ?? undefined,
    runId: input.sourceRunId,
    payload: { learningId: id },
  });
  return tx.db
    .insert(learnings)
    .values({
      id,
      projectId,
      repoId,
      text: input.text,
      roles: input.roles ?? [],
      tags: input.tags ?? [],
      status: "proposed",
      source: input.source,
      sourceRunId: input.sourceRunId ?? null,
      createdAt: proposed.ts,
    })
    .returning()
    .get();
}

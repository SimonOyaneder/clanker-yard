import type {
  CachedIssue,
  Issue,
  IssueFilter,
  IssueId,
  NewLocalIssue,
  Origin,
  ProjectId,
  ProjectRef,
} from "@clanker/api";
import { and, asc, eq, inArray, sql } from "drizzle-orm";
import { isDeepStrictEqual } from "node:util";
import { newId } from "../store/conventions";
import { issues, syncCursors } from "../store/schema";
import type { Store } from "../store/store";
import { createLocalTracker, type LocalTracker } from "./local";
import { matchesIssueFilter, type Tracker } from "./tracker";

/** Un proyecto de Clanker y el proyecto del tracker del que sale su cola. */
export interface ProjectBinding {
  projectId: ProjectId;
  project: ProjectRef;
}

type IssueRow = typeof issues.$inferSelect;

export interface Issues {
  /** Del caché, no del tracker. Urgente primero y sin prioridad al final; a igual prioridad, la más antigua. */
  list(filter?: IssueFilter & { projectId?: ProjectId }): CachedIssue[];
  get(id: IssueId): CachedIssue | undefined;
  /**
   * Trae al caché lo que cambió en el proyecto desde el último sync (todas sus issues la primera vez) y
   * emite `issue.synced` por cada issue nueva o modificada. Devuelve cuántas fueron. Si el tracker falla
   * no escribe nada y el próximo sync reintenta desde el mismo cursor.
   */
  sync(
    tracker: Tracker,
    binding: ProjectBinding,
    origin?: Origin,
  ): Promise<number>;
  /**
   * Si el tracker tiene algo que `sync` todavía no trajo al caché del proyecto: pregunta por los cambios
   * desde su cursor sin moverlo. `true` también si nunca se sincronizó.
   */
  hasChanges(tracker: Tracker, binding: ProjectBinding): Promise<boolean>;
  /** Crea una issue en el tracker local y la deja en el caché. El proyecto local se llama como `projectId`. */
  createLocal(
    input: NewLocalIssue & { projectId: ProjectId },
    origin: Origin,
  ): Promise<CachedIssue>;
}

/** La clave del cursor de `sync` de un proyecto del tracker (`ProjectRef.id`). */
export const issuesCursorKey = (tracker: string, projectRef: string) => `issues:${tracker}:${projectRef}`;

/** Sin `local`, el tracker local sobre el mismo store. */
export function createIssues({ store, local = createLocalTracker({ store }) }: { store: Store; local?: LocalTracker }): Issues {
  const { db } = store;

  const cursorKeyOf = (tracker: Tracker, project: ProjectRef) => issuesCursorKey(tracker.id, project.id);
  const savedCursor = (key: string) => db.select().from(syncCursors).where(eq(syncCursors.key, key)).get()?.cursor;

  const self: Issues = {
    list({ projectId, ...filter } = {}) {
      return (
        db
          .select()
          .from(issues)
          .where(
            and(
              projectId === undefined
                ? undefined
                : eq(issues.projectId, projectId),
              filter.status === undefined
                ? undefined
                : inArray(issues.status, filter.status),
            ),
          )
          // Prioridad 0 es "sin prioridad": va después de la 4.
          .orderBy(
            sql`CASE ${issues.priority} WHEN 0 THEN 5 ELSE ${issues.priority} END`,
            asc(issues.id),
          )
          .all()
          .map(toCachedIssue)
          .filter((issue) => matchesIssueFilter(issue, filter))
      );
    },

    get(id) {
      const row = db.select().from(issues).where(eq(issues.id, id)).get();
      return row && toCachedIssue(row);
    },

    async hasChanges(tracker, { project }) {
      const saved = savedCursor(cursorKeyOf(tracker, project));
      return saved == null || (await tracker.changesSince(saved)).changed.length > 0;
    },

    async sync(tracker, { projectId, project }, origin = "core") {
      const cursorKey = cursorKeyOf(tracker, project);
      const saved = savedCursor(cursorKey);

      let fetched: Issue[] = [];
      let cursor: string;
      if (saved == null) {
        // El cursor se pide antes de listar: lo que cambie mientras se lista entra en el próximo sync.
        cursor = await tracker.currentCursor();
        fetched = await tracker.listIssues(project, {});
      } else {
        const changes = await tracker.changesSince(saved);
        cursor = changes.cursor;
        // `changesSince` trae las issues de todos los proyectos del tracker.
        for (const ref of changes.changed) {
          const issue = await tracker.getIssue(ref);
          if (issue.project === project.id) fetched.push(issue);
        }
      }

      return store.tx((tx) => {
        let synced = 0;
        for (const issue of fetched) {
          const values = toRow(issue, projectId);
          const existing = findCached(tx.db, values);
          const changed =
            existing === undefined
              ? ["created"]
              : changedFields(existing, values);
          if (changed.length === 0) continue;
          const id =
            existing === undefined
              ? tx.db
                  .insert(issues)
                  .values({ ...values, id: newId("iss") })
                  .returning({ id: issues.id })
                  .get().id
              : existing.id;
          if (existing !== undefined)
            tx.db.update(issues).set(values).where(eq(issues.id, id)).run();
          tx.emit({
            type: "issue.synced",
            origin,
            projectId,
            subject: { type: "issue", id },
            payload: { issueId: id, changed },
          });
          synced++;
        }
        const row = { key: cursorKey, cursor, checkedAt: Date.now() };
        tx.db
          .insert(syncCursors)
          .values(row)
          .onConflictDoUpdate({ target: syncCursors.key, set: row })
          .run();
        return synced;
      });
    },

    async createLocal({ projectId, ...fields }, origin) {
      const { ref } = await local.createIssue(projectId, fields);
      await self.sync(
        local,
        { projectId, project: { tracker: "local", id: projectId } },
        origin,
      );
      const row = db
        .select()
        .from(issues)
        .where(
          and(eq(issues.tracker, ref.tracker), eq(issues.trackerId, ref.id)),
        )
        .get();
      if (!row)
        throw new Error(
          `La issue ${ref.key} se creó pero no quedó en el caché.`,
        );
      return toCachedIssue(row);
    },
  };
  return self;
}

/**
 * La issue del caché que corresponde a la que trae el tracker. Una que importó `clanker import legacy`
 * se guardó con su key como `tracker_id` (el loop viejo no sabía el id del tracker): el primer sync la
 * adopta por key en vez de duplicarla, y desde ahí su `tracker_id` es el real.
 */
function findCached(db: Store["db"], values: Omit<IssueRow, "id">): IssueRow | undefined {
  const byId = db
    .select()
    .from(issues)
    .where(and(eq(issues.tracker, values.tracker), eq(issues.trackerId, values.trackerId)))
    .get();
  return (
    byId ??
    db
      .select()
      .from(issues)
      .where(and(eq(issues.tracker, values.tracker), eq(issues.trackerId, values.key), eq(issues.key, values.key)))
      .get()
  );
}

function toRow(issue: Issue, projectId: ProjectId): Omit<IssueRow, "id"> {
  return {
    tracker: issue.ref.tracker,
    trackerId: issue.ref.id,
    key: issue.ref.key,
    url: issue.ref.url,
    projectId,
    trackerProject: issue.project,
    title: issue.title,
    body: issue.body,
    status: issue.status,
    rawStatus: issue.rawStatus,
    priority: issue.priority,
    assignee: issue.assignee ?? null,
    labels: issue.labels,
    estimate: issue.estimate ?? null,
    branchName: issue.branchName ?? null,
    parent: issue.parent ?? null,
    milestone: issue.milestone ?? null,
    relations: issue.relations,
    remoteUpdatedAt: issue.updatedAt,
  };
}

function toCachedIssue(row: IssueRow): CachedIssue {
  return {
    id: row.id,
    projectId: row.projectId,
    ref: {
      tracker: row.tracker,
      id: row.trackerId,
      key: row.key,
      url: row.url,
    },
    project: row.trackerProject,
    title: row.title,
    body: row.body,
    status: row.status,
    rawStatus: row.rawStatus,
    priority: row.priority,
    labels: row.labels,
    ...(row.assignee === null ? {} : { assignee: row.assignee }),
    ...(row.estimate === null ? {} : { estimate: row.estimate }),
    ...(row.branchName === null ? {} : { branchName: row.branchName }),
    ...(row.parent === null ? {} : { parent: row.parent }),
    ...(row.milestone === null ? {} : { milestone: row.milestone }),
    relations: row.relations,
    updatedAt: row.remoteUpdatedAt,
  };
}

function changedFields(
  existing: IssueRow,
  values: Omit<IssueRow, "id">,
): string[] {
  return (Object.keys(values) as (keyof typeof values)[]).filter(
    (field) => !isDeepStrictEqual(existing[field], values[field]),
  );
}

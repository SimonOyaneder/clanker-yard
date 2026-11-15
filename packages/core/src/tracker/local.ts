import {
  NewLocalIssue,
  type Issue,
  type IssueDetail,
  type IssueFilter,
  type IssueRef,
  type Person,
  type Project,
  type ProjectRef,
  type StatusCategory,
} from "@clanker/api";
import { and, asc, eq, max, sql } from "drizzle-orm";
import { newId } from "../store/conventions";
import { localComments, localIssues, localRelations } from "../store/schema";
import type { Store, StoreDb, Tx } from "../store/store";
import {
  IssueNotFoundError,
  matchesIssueFilter,
  type Tracker,
} from "./tracker";

export type RelationKind = "blocks" | "related";

/** El adapter `local` con lo que solo él ofrece: crear issues y relacionarlas, para demos y fixtures. */
export interface LocalTracker extends Tracker {
  id: "local";
  /** La crea en `project` (que existe desde su primera issue) con la key `<PROJECT>-<n>`. */
  createIssue(project: string, input: NewLocalIssue): Promise<Issue>;
  /** `from` bloquea a `to` (que queda `blockedBy` `from`), o ambas quedan `related`. Repetirla no hace nada. */
  relate(from: IssueRef, kind: RelationKind, to: IssueRef): Promise<void>;
}

export interface LocalTrackerOptions {
  /** La persona que reclama issues y comenta. */
  me?: Person;
  now?: () => number;
}

const RAW_STATUS: Record<StatusCategory, string> = {
  backlog: "Backlog",
  todo: "Todo",
  in_progress: "In Progress",
  in_review: "In Review",
  done: "Done",
  canceled: "Canceled",
};

type IssueRow = typeof localIssues.$inferSelect;

/**
 * Guarda las issues en la propia base: es la fuente de verdad del tracker `local`, separada del caché
 * `issues`. Cada cambio de una issue (también un comentario o una relación) le sube `rev`, y `rev` es
 * el cursor de `changesSince`.
 */
export function createLocalTracker(
  store: Store,
  {
    me = { id: "local", name: "Local" },
    now = Date.now,
  }: LocalTrackerOptions = {},
): LocalTracker {
  const { db } = store;

  function byId(from: StoreDb, id: string): IssueRow | undefined {
    return from.select().from(localIssues).where(eq(localIssues.id, id)).get();
  }

  function find(from: StoreDb, ref: IssueRef): IssueRow {
    const row = ref.tracker === "local" ? byId(from, ref.id) : undefined;
    if (!row) throw new IssueNotFoundError(ref);
    return row;
  }

  /** Marca la issue como cambiada: nueva `rev` y `updatedAt`. */
  function touch(tx: Tx, id: string): void {
    tx.db
      .update(localIssues)
      .set({ rev: latestRev(tx.db) + 1, updatedAt: now() })
      .where(eq(localIssues.id, id))
      .run();
  }

  function refsOf(rows: IssueRow[]): IssueRef[] {
    return rows
      .map(toRef)
      .sort((a, b) => a.key.localeCompare(b.key, undefined, { numeric: true }));
  }

  function toIssue(row: IssueRow): Issue {
    const linked = (
      own: "fromId" | "toId",
      other: "fromId" | "toId",
      kind: RelationKind,
    ) =>
      db
        .select({ issue: localIssues })
        .from(localRelations)
        .innerJoin(localIssues, eq(localIssues.id, localRelations[other]))
        .where(
          and(eq(localRelations[own], row.id), eq(localRelations.kind, kind)),
        )
        .all()
        .map((r) => r.issue);
    const parent = row.parentId === null ? undefined : byId(db, row.parentId);
    return {
      ref: toRef(row),
      project: row.project,
      title: row.title,
      body: row.body,
      status: row.status,
      rawStatus: row.rawStatus,
      priority: row.priority,
      labels: row.labels,
      ...(row.assignee === null ? {} : { assignee: row.assignee }),
      ...(row.estimate === null ? {} : { estimate: row.estimate }),
      ...(parent === undefined ? {} : { parent: toRef(parent) }),
      ...(row.milestone === null ? {} : { milestone: row.milestone }),
      relations: {
        blocks: refsOf(linked("fromId", "toId", "blocks")),
        blockedBy: refsOf(linked("toId", "fromId", "blocks")),
        related: refsOf([
          ...linked("fromId", "toId", "related"),
          ...linked("toId", "fromId", "related"),
        ]),
      },
      updatedAt: row.updatedAt,
    };
  }

  return {
    id: "local",
    capabilities: {
      relations: true,
      subIssues: true,
      milestones: true,
      priorities: true,
      estimates: true,
    },

    async listProjects() {
      return db
        .selectDistinct({ project: localIssues.project })
        .from(localIssues)
        .orderBy(asc(localIssues.project))
        .all()
        .map(({ project }): Project => ({
          ref: { tracker: "local", id: project },
          name: project,
        }));
    },

    async listIssues(project: ProjectRef, filter: IssueFilter) {
      return db
        .select()
        .from(localIssues)
        .where(eq(localIssues.project, project.id))
        .orderBy(asc(localIssues.number))
        .all()
        .map(toIssue)
        .filter((issue) => matchesIssueFilter(issue, filter));
    },

    async getIssue(ref): Promise<IssueDetail> {
      const row = find(db, ref);
      const comments = db
        .select()
        .from(localComments)
        .where(eq(localComments.issueId, row.id))
        .orderBy(asc(localComments.createdAt), asc(localComments.id))
        .all()
        .map(({ id, author, text, createdAt }) => ({
          id,
          author,
          text,
          createdAt,
        }));
      return { ...toIssue(row), comments };
    },

    async viewer() {
      return me;
    },

    async claim(ref) {
      store.tx((tx) => {
        const row = find(tx.db, ref);
        if (row.assignee !== null && row.assignee.id !== me.id) {
          throw new Error(
            `La issue ${toRef(row).key} ya está asignada a ${row.assignee.name}: no se puede reclamar.`,
          );
        }
        tx.db
          .update(localIssues)
          .set({
            assignee: me,
            status: "in_progress",
            rawStatus: RAW_STATUS.in_progress,
          })
          .where(eq(localIssues.id, row.id))
          .run();
        touch(tx, row.id);
      });
    },

    async setStatus(ref, status) {
      store.tx((tx) => {
        const row = find(tx.db, ref);
        tx.db
          .update(localIssues)
          .set({ status, rawStatus: RAW_STATUS[status] })
          .where(eq(localIssues.id, row.id))
          .run();
        touch(tx, row.id);
      });
    },

    async comment(ref, text) {
      if (text.trim() === "")
        throw new Error("Un comentario no puede estar vacío.");
      store.tx((tx) => {
        const row = find(tx.db, ref);
        tx.db
          .insert(localComments)
          .values({
            id: newId("lcm"),
            issueId: row.id,
            author: me,
            text,
            createdAt: now(),
          })
          .run();
        touch(tx, row.id);
      });
    },

    async changesSince(cursor) {
      const since = parseCursor(cursor);
      const changed = db
        .select()
        .from(localIssues)
        .where(sql`${localIssues.rev} > ${since}`)
        .orderBy(asc(localIssues.rev))
        .all();
      return { changed: changed.map(toRef), cursor: String(latestRev(db)) };
    },

    async createIssue(project, input) {
      const fields = NewLocalIssue.parse(input);
      if (project === "")
        throw new Error("Una issue local necesita un proyecto.");
      const row = store.tx((tx) => {
        const parent =
          fields.parent === undefined ? undefined : find(tx.db, fields.parent);
        const last =
          tx.db
            .select({ number: max(localIssues.number) })
            .from(localIssues)
            .where(eq(localIssues.project, project))
            .get()?.number ?? 0;
        return tx.db
          .insert(localIssues)
          .values({
            id: newId("lis"),
            project,
            title: fields.title,
            body: fields.body,
            status: fields.status,
            priority: fields.priority,
            labels: fields.labels,
            estimate: fields.estimate,
            milestone: fields.milestone,
            number: last + 1,
            rawStatus: RAW_STATUS[fields.status],
            parentId: parent?.id ?? null,
            rev: latestRev(tx.db) + 1,
            updatedAt: now(),
          })
          .returning()
          .get();
      });
      return toIssue(row);
    },

    async relate(from, kind, to) {
      store.tx((tx) => {
        const [a, b] = [find(tx.db, from), find(tx.db, to)];
        if (a.id === b.id)
          throw new Error(
            `La issue ${toRef(a).key} no se puede relacionar consigo misma.`,
          );
        // `related` es simétrica: se guarda una sola vez, con los ids en orden.
        const [fromId, toId] =
          kind === "related" && a.id > b.id ? [b.id, a.id] : [a.id, b.id];
        const { changes } = tx.db
          .insert(localRelations)
          .values({ fromId, toId, kind })
          .onConflictDoNothing()
          .run();
        if (changes > 0) for (const id of [a.id, b.id]) touch(tx, id);
      });
    },
  };
}

function latestRev(from: StoreDb): number {
  return (
    from
      .select({ rev: max(localIssues.rev) })
      .from(localIssues)
      .get()?.rev ?? 0
  );
}

function toRef(row: IssueRow): IssueRef {
  return {
    tracker: "local",
    id: row.id,
    key: `${row.project.toUpperCase()}-${row.number}`,
    url: `clanker-local:///issues/${row.id}`,
  };
}

function parseCursor(cursor: string | undefined): number {
  if (cursor === undefined) return 0;
  if (!/^\d+$/.test(cursor)) {
    throw new Error(
      `El cursor "${cursor}" no es de este tracker: pide changesSince() sin cursor para empezar de cero.`,
    );
  }
  return Number(cursor);
}

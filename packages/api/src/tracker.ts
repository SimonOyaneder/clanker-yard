import * as z from "zod";
import { IssueId, ProjectId } from "./domain";

export const TrackerId = z.enum(["linear", "github-issues", "jira", "local"]);
export type TrackerId = z.infer<typeof TrackerId>;

/**
 * Lo que un tracker sabe hacer. Si una capacidad es `false`, el scheduler no calcula lo que depende de
 * ella (bloqueos, stacking) y la UI no ofrece esas opciones (`docs/design.html#tracker`).
 */
export const TrackerCapabilities = z.object({
  relations: z.boolean(),
  subIssues: z.boolean(),
  milestones: z.boolean(),
  priorities: z.boolean(),
  estimates: z.boolean(),
});
export type TrackerCapabilities = z.infer<typeof TrackerCapabilities>;

/**
 * Las categorías en que cada adapter traduce los estados de su tracker; el estado original queda en
 * `rawStatus`.
 */
export const StatusCategory = z.enum([
  "backlog",
  "todo",
  "in_progress",
  "in_review",
  "done",
  "canceled",
]);
export type StatusCategory = z.infer<typeof StatusCategory>;

export const IssueRef = z.object({
  tracker: TrackerId,
  /** El id de la issue dentro del tracker. */
  id: z.string().min(1),
  /** Lo que ve la gente: `ENG-9171`. */
  key: z.string().min(1),
  url: z.url(),
});
export type IssueRef = z.infer<typeof IssueRef>;

export const ProjectRef = z.object({
  tracker: TrackerId,
  id: z.string().min(1),
});
export type ProjectRef = z.infer<typeof ProjectRef>;

export const Project = z.object({
  ref: ProjectRef,
  name: z.string().min(1),
  /** La persona de la conexión es la lead o miembro del proyecto. Un tracker que no lo sabe lo omite. */
  mine: z.boolean().optional(),
});
export type Project = z.infer<typeof Project>;

/** Un proyecto del tracker como lo ofrece el selector de `projects.create`: con la cuenta (workspace) de la que sale. */
export const TrackerProject = Project.extend({
  account: z.string().min(1),
});
export type TrackerProject = z.infer<typeof TrackerProject>;

export const Person = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
});
export type Person = z.infer<typeof Person>;

/** 0 = sin prioridad, 1 = urgente. */
export const Priority = z.literal([0, 1, 2, 3, 4]);
export type Priority = z.infer<typeof Priority>;

export const Milestone = z.object({
  name: z.string().min(1),
  /** Fecha ISO (`2026-12-31`). */
  due: z.string().optional(),
});
export type Milestone = z.infer<typeof Milestone>;

/** La issue normalizada: el scheduler y los flujos no ven nada más del tracker. */
export const Issue = z.object({
  ref: IssueRef,
  /** El proyecto de la issue dentro del tracker (`ProjectRef.id`): `changesSince` trae issues de todos. */
  project: z.string().min(1),
  title: z.string().min(1),
  body: z.string(),
  status: StatusCategory,
  rawStatus: z.string().min(1),
  priority: Priority,
  labels: z.array(z.string()),
  assignee: Person.optional(),
  estimate: z.number().nonnegative().optional(),
  /** El nombre de branch que sugiere el tracker (Linear: `usuario/eng-1234-slug`). */
  branchName: z.string().min(1).optional(),
  parent: IssueRef.optional(),
  milestone: Milestone.optional(),
  relations: z.object({
    blocks: z.array(IssueRef),
    blockedBy: z.array(IssueRef),
    related: z.array(IssueRef),
  }),
  /** ms epoch de la última modificación en el tracker. */
  updatedAt: z.int().nonnegative(),
});
export type Issue = z.infer<typeof Issue>;

export const Comment = z.object({
  id: z.string().min(1),
  author: Person,
  text: z.string().min(1),
  /** ms epoch */
  createdAt: z.int().nonnegative(),
});
export type Comment = z.infer<typeof Comment>;

/** Lo que devuelve `Tracker.getIssue`: la issue con sus comentarios. */
export const IssueDetail = Issue.extend({ comments: z.array(Comment) });
export type IssueDetail = z.infer<typeof IssueDetail>;

/** Reglas de la cola en términos normalizados. Los campos presentes se combinan con AND. */
export const IssueFilter = z.object({
  /** Cualquiera de estas categorías. */
  status: z.array(StatusCategory).min(1).optional(),
  /** La issue tiene todos estos labels. */
  labels: z.array(z.string()).min(1).optional(),
  /** La issue no tiene ninguno de estos labels (`no-clanker`). */
  excludeLabels: z.array(z.string()).min(1).optional(),
});
export type IssueFilter = z.infer<typeof IssueFilter>;

/** Una issue del caché `issues`: la normalizada, más su id y el proyecto de Clanker al que pertenece. */
export const CachedIssue = Issue.extend({ id: IssueId, projectId: ProjectId });
export type CachedIssue = z.infer<typeof CachedIssue>;

/** Los campos que se pueden dar al crear una issue local; el resto lo pone el adapter. */
export const NewLocalIssue = z.object({
  title: z.string().min(1),
  body: z.string().default(""),
  status: StatusCategory.default("todo"),
  priority: Priority.default(0),
  labels: z.array(z.string()).default([]),
  estimate: z.number().nonnegative().optional(),
  parent: IssueRef.optional(),
  milestone: Milestone.optional(),
});
export type NewLocalIssue = z.input<typeof NewLocalIssue>;

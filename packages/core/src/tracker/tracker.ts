import type {
  Issue,
  IssueDetail,
  IssueFilter,
  IssueRef,
  Person,
  Project,
  ProjectRef,
  StatusCategory,
  TrackerCapabilities,
  TrackerId,
} from "@clanker/api";

/**
 * Un tracker de issues (Linear, local...). El scheduler y los flujos solo conocen esta interfaz y el
 * modelo normalizado de `@clanker/api`; lo propio de cada tracker se queda dentro de su adapter
 * (`docs/design.html#tracker`).
 */
export interface Tracker {
  id: TrackerId;
  capabilities: TrackerCapabilities;
  listProjects(): Promise<Project[]>;
  listIssues(project: ProjectRef, filter: IssueFilter): Promise<Issue[]>;
  /** Con relaciones y comentarios. Lanza `IssueNotFoundError` si no existe. */
  getIssue(ref: IssueRef): Promise<IssueDetail>;
  /** La persona de la conexión: a quien asigna `claim` y cuyas issues el scheduler considera propias. */
  viewer(): Promise<Person>;
  /** Asigna la issue a la persona de la conexión y la pasa a `in_progress`. */
  claim(ref: IssueRef): Promise<void>;
  setStatus(ref: IssueRef, status: StatusCategory): Promise<void>;
  comment(ref: IssueRef, text: string): Promise<void>;
  /**
   * Las issues modificadas después de `cursor`, de todos los proyectos, y el cursor para la próxima
   * llamada. Sin cursor devuelve todas. El cursor es opaco: solo sirve el que devolvió el mismo tracker.
   */
  changesSince(
    cursor?: string,
  ): Promise<{ changed: IssueRef[]; cursor: string }>;
}

export class IssueNotFoundError extends Error {
  constructor(ref: IssueRef) {
    super(
      `La issue ${ref.key} (${ref.tracker}:${ref.id}) no existe en el tracker.`,
    );
  }
}

/** Las reglas de la cola en términos normalizados: se aplican igual a cualquier tracker y al caché. */
export function matchesIssueFilter(issue: Issue, filter: IssueFilter): boolean {
  return (
    (filter.status === undefined || filter.status.includes(issue.status)) &&
    (filter.labels === undefined ||
      filter.labels.every((label) => issue.labels.includes(label))) &&
    (filter.excludeLabels === undefined ||
      !filter.excludeLabels.some((label) => issue.labels.includes(label)))
  );
}

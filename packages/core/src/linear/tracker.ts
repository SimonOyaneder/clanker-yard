import {
  Priority,
  type Comment,
  type Issue,
  type IssueDetail,
  type IssueFilter,
  type IssueRef,
  type Person,
  type Project,
  type ProjectRef,
  type StatusCategory,
} from "@clanker/api";
import type { Connections } from "../connections/connections";
import { IssueNotFoundError, matchesIssueFilter, type Tracker } from "../tracker/tracker";
import { createLinearGraphql, LinearApiError, type LinearGraphql } from "./graphql";
import { LINEAR_ENDPOINTS } from "./oauth";

/** El `Issue.project` de una issue que no está en ningún proyecto de Linear: nunca coincide con un `ProjectRef`. */
export const NO_PROJECT = "no-project";

/** Lo que una issue trae por página y por lista anidada (labels, relaciones): acotado por el costo de la query. */
const ISSUES_PER_PAGE = 25;
/** Proyectos por página y miembros por proyecto al listar proyectos: acotados por el costo de la query. */
const PROJECTS_PER_PAGE = 50;
const MEMBERS_PER_PROJECT = 25;
const NESTED_PER_ISSUE = 25;

/** Todo comentario de Clanker Yard en Linear empieza así (sale con la identidad de la persona). */
const COMMENT_PREFIX = "[clanker]";

/** Estado de Linear (por nombre) a categoría; pisa el mapeo por defecto de ese proyecto. */
export type StatusMapping = Readonly<Record<string, StatusCategory>>;

export interface LinearTrackerOptions {
  connections: Pick<Connections, "list" | "token">;
  /** El workspace (`urlKey`) cuyo token se usa. Sin él se usa la única cuenta de Linear conectada. */
  account?: string;
  /** El GraphQL de Linear; en tests, un servidor local. */
  endpoint?: string;
  fetch?: typeof fetch;
  /**
   * El mapeo ajustado de un proyecto (`Issue.project`), si lo tiene. Los estados que no nombra siguen el
   * mapeo por defecto: por tipo de estado de Linear, y un estado `started` cuyo nombre dice "review" es
   * `in_review`.
   */
  statusMapping?: (project: string) => StatusMapping | undefined;
}

const ISSUE_FIELDS = `
  id identifier url title description priority estimate branchName updatedAt
  state { name type }
  team { id }
  assignee { id name }
  project { id }
  projectMilestone { name targetDate }
  parent { id identifier url }
  labels(first: ${NESTED_PER_ISSUE}) { nodes { name } pageInfo { hasNextPage } }
  relations(first: ${NESTED_PER_ISSUE}) { nodes { type relatedIssue { id identifier url } } pageInfo { hasNextPage } }
  inverseRelations(first: ${NESTED_PER_ISSUE}) { nodes { type issue { id identifier url } } pageInfo { hasNextPage } }
`;

const QUERIES = {
  viewer: `query Viewer { viewer { id name } }`,
  projects: `query Projects($after: String) {
    projects(first: ${PROJECTS_PER_PAGE}, after: $after) {
      nodes { id name lead { id } members(first: ${MEMBERS_PER_PROJECT}) { nodes { id } } }
      pageInfo { hasNextPage endCursor }
    }
  }`,
  project: `query ProjectByRef($id: String!) { project(id: $id) { id name } }`,
  issues: `query Issues($filter: IssueFilter, $after: String) {
    issues(filter: $filter, first: ${ISSUES_PER_PAGE}, after: $after, orderBy: updatedAt) {
      nodes { ${ISSUE_FIELDS} } pageInfo { hasNextPage endCursor }
    }
  }`,
  issue: `query Issue($id: String!) { issue(id: $id) { ${ISSUE_FIELDS} } }`,
  comments: `query IssueComments($id: String!, $after: String) {
    issue(id: $id) {
      comments(first: 100, after: $after) {
        nodes { id body createdAt user { id name } botActor { name } } pageInfo { hasNextPage endCursor }
      }
    }
  }`,
  changes: `query Changes($filter: IssueFilter, $after: String) {
    issues(filter: $filter, first: 100, after: $after, orderBy: updatedAt) {
      nodes { id identifier url updatedAt } pageInfo { hasNextPage endCursor }
    }
  }`,
  latest: `query Latest {
    issues(first: 1, orderBy: updatedAt) { nodes { updatedAt } }
  }`,
  states: `query States($team: ID, $after: String) {
    workflowStates(filter: { team: { id: { eq: $team } } }, first: 100, after: $after) {
      nodes { id name type position } pageInfo { hasNextPage endCursor }
    }
  }`,
  update: `mutation Update($id: String!, $input: IssueUpdateInput!) { issueUpdate(id: $id, input: $input) { success } }`,
  comment: `mutation Comment($input: CommentCreateInput!) { commentCreate(input: $input) { success } }`,
};

interface Page<T> {
  nodes: T[];
  pageInfo: { hasNextPage: boolean; endCursor: string | null };
}

interface RawProject {
  id: string;
  name: string;
  lead: { id: string } | null;
  members: { nodes: { id: string }[] };
}

interface RawRef {
  id: string;
  identifier: string;
  url: string;
}

interface RawState {
  id: string;
  name: string;
  type: string;
  position: number;
}

interface RawComment {
  id: string;
  body: string;
  createdAt: string;
  user: Person | null;
  botActor: { name: string | null } | null;
}

interface RawIssue extends RawRef {
  title: string;
  description: string | null;
  priority: number;
  estimate: number | null;
  branchName: string;
  updatedAt: string;
  state: { name: string; type: string };
  team: { id: string };
  assignee: Person | null;
  project: { id: string } | null;
  projectMilestone: { name: string; targetDate: string | null } | null;
  parent: RawRef | null;
  labels: Page<{ name: string }>;
  relations: Page<{ type: string; relatedIssue: RawRef }>;
  inverseRelations: Page<{ type: string; issue: RawRef }>;
}

/**
 * El adapter `linear`: habla con el GraphQL de Linear con el token de `connections.token("linear", cuenta)`
 * (que se refresca solo). Los proyectos son los proyectos de Linear y `Issue.project` es el id del proyecto
 * de la issue. `changesSince` usa `updatedAt` de las issues como cursor; no ve los comentarios, que no
 * cambian la issue.
 */
/** El `Tracker` de Linear, que además resuelve lo que una persona pega para nombrar un proyecto. */
export type LinearTracker = Tracker & {
  /**
   * El proyecto que `ref` nombra: su id (UUID), su slugId (`e12b20e7b4ad`), su identificador (`P-ENG-1525`) o la URL
   * del proyecto (`https://linear.app/acme/project/mi-proyecto-e12b20e7b4ad/overview`), todo vía `project(id:)`.
   * `undefined` si el workspace no lo tiene.
   */
  resolveProject(ref: string): Promise<Project | undefined>;
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const isLinearId = (ref: string): boolean => UUID.test(ref);

/** Lo que `project(id:)` recibe: de una URL de proyecto, su slugId (lo que sigue al último guion del slug). */
function projectToken(ref: string): string {
  const text = ref.trim();
  const slug = /^https?:\/\/[^/]+\/[^/]+\/project\/([^/?#]+)/.exec(text)?.[1];
  return slug === undefined ? text : (slug.split("-").at(-1) ?? slug);
}

export function createLinearTracker({
  connections,
  account,
  endpoint = LINEAR_ENDPOINTS.graphql,
  fetch,
  statusMapping,
}: LinearTrackerOptions): LinearTracker {
  const gql: LinearGraphql = createLinearGraphql({ endpoint, fetch, token: () => connections.token("linear", accountName()) });

  function accountName(): string {
    if (account !== undefined) return account;
    const accounts = connections.list().filter((c) => c.provider === "linear");
    if (accounts.length === 1) return accounts[0]!.account;
    throw new LinearApiError(
      accounts.length === 0
        ? "No hay una cuenta de Linear conectada: conéctala en Conexiones (connections.linearAuth)."
        : `Hay varias cuentas de Linear conectadas (${accounts.map((c) => c.account).join(", ")}): indica con cuál trabajar.`,
    );
  }

  async function all<T>(fetchPage: (after: string | null) => Promise<Page<T>>): Promise<T[]> {
    const items: T[] = [];
    let after: string | null = null;
    for (;;) {
      const page = await fetchPage(after);
      items.push(...page.nodes);
      if (!page.pageInfo.hasNextPage) return items;
      if (page.pageInfo.endCursor === null) throw new LinearApiError("Linear indicó otra página pero no dio su cursor.");
      after = page.pageInfo.endCursor;
    }
  }

  async function readIssue(ref: IssueRef): Promise<{ issue: Issue; teamId: string }> {
    let raw: RawIssue;
    try {
      raw = (await gql<{ issue: RawIssue }>(QUERIES.issue, { id: ref.id })).issue;
    } catch (error) {
      if (error instanceof LinearApiError && /Entity not found/i.test(error.message)) throw new IssueNotFoundError(ref);
      throw error;
    }
    return { issue: toIssue(raw), teamId: raw.team.id };
  }

  function toIssue(raw: RawIssue): Issue {
    for (const [name, nested] of [["labels", raw.labels], ["relaciones", raw.relations], ["relaciones inversas", raw.inverseRelations]] as const) {
      if (nested.pageInfo.hasNextPage) {
        throw new LinearApiError(`La issue ${raw.identifier} tiene más de ${NESTED_PER_ISSUE} ${name}: el adapter no las lee completas.`);
      }
    }
    const project = raw.project?.id ?? NO_PROJECT;
    const relatedRefs = [
      ...raw.relations.nodes.filter((r) => r.type === "related").map((r) => r.relatedIssue),
      ...raw.inverseRelations.nodes.filter((r) => r.type === "related").map((r) => r.issue),
    ];
    return {
      ref: toRef(raw),
      project,
      title: raw.title,
      body: raw.description ?? "",
      status: categoryOf(raw.state, statusMapping?.(project)),
      rawStatus: raw.state.name,
      priority: Priority.parse(raw.priority),
      labels: raw.labels.nodes.map((l) => l.name),
      ...(raw.assignee === null ? {} : { assignee: { id: raw.assignee.id, name: raw.assignee.name } }),
      ...(raw.estimate === null ? {} : { estimate: raw.estimate }),
      branchName: raw.branchName,
      ...(raw.parent === null ? {} : { parent: toRef(raw.parent) }),
      ...(raw.projectMilestone === null
        ? {}
        : {
            milestone: {
              name: raw.projectMilestone.name,
              ...(raw.projectMilestone.targetDate === null ? {} : { due: raw.projectMilestone.targetDate }),
            },
          }),
      relations: {
        blocks: raw.relations.nodes.filter((r) => r.type === "blocks").map((r) => toRef(r.relatedIssue)),
        blockedBy: raw.inverseRelations.nodes.filter((r) => r.type === "blocks").map((r) => toRef(r.issue)),
        related: [...new Map(relatedRefs.map((r) => [r.id, toRef(r)])).values()],
      },
      updatedAt: Date.parse(raw.updatedAt),
    };
  }

  /**
   * El estado del equipo que corresponde a `status` en el mapeo del proyecto: el de menor posición, y los
   * estados de triage y duplicado solo si no hay otro.
   */
  async function stateFor(issue: Issue, teamId: string, status: StatusCategory): Promise<RawState> {
    const states = await all((after) =>
      gql<{ workflowStates: Page<RawState> }>(QUERIES.states, { team: teamId, after }).then((d) => d.workflowStates),
    );
    const mapping = statusMapping?.(issue.project);
    const rank = (state: RawState) => (state.type === "triage" || state.type === "duplicate" ? 1 : 0);
    const found = states
      .filter((s) => categoryOf(s, mapping) === status)
      .sort((a, b) => rank(a) - rank(b) || a.position - b.position)[0];
    if (!found) {
      throw new LinearApiError(
        `El equipo de ${issue.ref.key} no tiene un estado de categoría "${status}" (tiene ${states.map((s) => `"${s.name}"`).join(", ")}): agrégalo en Linear o ajusta el mapeo de estados del proyecto.`,
      );
    }
    return found;
  }

  async function update(ref: IssueRef, input: { assigneeId?: string; stateId?: string }): Promise<void> {
    const { issueUpdate } = await gql<{ issueUpdate: { success: boolean } }>(QUERIES.update, { id: ref.id, input });
    if (!issueUpdate.success) throw new LinearApiError(`Linear no aplicó el cambio en ${ref.key} (success: false).`);
  }

  async function viewer(): Promise<Person> {
    return (await gql<{ viewer: Person }>(QUERIES.viewer)).viewer;
  }

  return {
    id: "linear",
    capabilities: { relations: true, subIssues: true, milestones: true, priorities: true, estimates: true },

    /**
     * `mine` es que la persona de la conexión lidera el proyecto o está entre sus primeros
     * `MEMBERS_PER_PROJECT` miembros (leer todos los miembros de todos los proyectos no cabe en una query).
     */
    async listProjects() {
      const [me, projects] = await Promise.all([
        viewer(),
        all((after) => gql<{ projects: Page<RawProject> }>(QUERIES.projects, { after }).then((d) => d.projects)),
      ]);
      return projects.map(
        (p): Project => ({
          ref: { tracker: "linear", id: p.id },
          name: p.name,
          mine: p.lead?.id === me.id || p.members.nodes.some((m) => m.id === me.id),
        }),
      );
    },

    async resolveProject(ref) {
      try {
        const { project } = await gql<{ project: { id: string; name: string } }>(QUERIES.project, { id: projectToken(ref) });
        return { ref: { tracker: "linear", id: project.id }, name: project.name };
      } catch (error) {
        if (error instanceof LinearApiError && /Entity not found/i.test(error.message)) return undefined;
        throw error;
      }
    },

    async listIssues(project: ProjectRef, filter: IssueFilter) {
      if (!isLinearId(project.id)) {
        throw new LinearApiError(
          `El proyecto del tracker "${project.id}" no es el id de un proyecto de Linear (un UUID): elígelo de nuevo en Ajustes, en "Proyecto del tracker".`,
        );
      }
      const raw = await all((after) =>
        gql<{ issues: Page<RawIssue> }>(QUERIES.issues, { filter: { project: { id: { eq: project.id } } }, after }).then((d) => d.issues),
      );
      return raw.map(toIssue).filter((issue) => matchesIssueFilter(issue, filter));
    },

    async getIssue(ref): Promise<IssueDetail> {
      const { issue } = await readIssue(ref);
      const raw = await all((after) =>
        gql<{ issue: { comments: Page<RawComment> } }>(QUERIES.comments, { id: ref.id, after }).then((d) => d.issue.comments),
      );
      const comments = raw
        .filter((c) => c.body.trim() !== "")
        .map(
          (c): Comment => ({
            id: c.id,
            author: c.user ?? { id: "linear-bot", name: c.botActor?.name ?? "Linear" },
            text: c.body,
            createdAt: Date.parse(c.createdAt),
          }),
        )
        .sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id));
      return { ...issue, comments };
    },

    viewer,

    async claim(ref) {
      const me = await viewer();
      const { issue, teamId } = await readIssue(ref);
      if (issue.assignee !== undefined && issue.assignee.id !== me.id) {
        throw new LinearApiError(`La issue ${ref.key} ya está asignada a ${issue.assignee.name}: no se puede reclamar.`);
      }
      const target = await stateFor(issue, teamId, "in_progress");
      await update(ref, { assigneeId: me.id, stateId: target.id });

      // Linear puede aceptar el cambio y no aplicarlo (ENG-9084): solo vale lo que se relee.
      const { issue: after } = await readIssue(ref);
      const problems = [
        ...(after.assignee?.id === me.id ? [] : [`sigue asignada a ${after.assignee?.name ?? "nadie"}`]),
        ...(after.status === "in_progress" ? [] : [`sigue en "${after.rawStatus}"`]),
      ];
      if (problems.length > 0) {
        throw new LinearApiError(`Linear ignoró el claim de ${ref.key}: ${problems.join(" y ")}.`);
      }
    },

    async setStatus(ref, status) {
      const { issue, teamId } = await readIssue(ref);
      const target = await stateFor(issue, teamId, status);
      await update(ref, { stateId: target.id });
      const { issue: after } = await readIssue(ref);
      if (after.status !== status) {
        throw new LinearApiError(`Linear ignoró el cambio de ${ref.key} a "${status}": sigue en "${after.rawStatus}".`);
      }
    },

    async comment(ref, text) {
      if (text.trim() === "") throw new Error("Un comentario no puede estar vacío.");
      // Sale con la identidad de la persona: el prefijo avisa que lo escribió Clanker Yard.
      const body = text.startsWith(COMMENT_PREFIX) ? text : `${COMMENT_PREFIX} ${text}`;
      const { commentCreate } = await gql<{ commentCreate: { success: boolean } }>(QUERIES.comment, { input: { issueId: ref.id, body } });
      if (!commentCreate.success) throw new LinearApiError(`Linear no creó el comentario en ${ref.key} (success: false).`);
    },

    async changesSince(cursor) {
      const since = cursor === undefined ? undefined : parseCursor(cursor);
      const changed = await all((after) =>
        gql<{ issues: Page<RawRef & { updatedAt: string }> }>(QUERIES.changes, {
          filter: since === undefined ? undefined : { updatedAt: { gt: since } },
          after,
        }).then((d) => d.issues),
      );
      // El cursor es el `updatedAt` más reciente que se vio (no el reloj local, que puede ir desfasado).
      // Sin issues todavía, el epoch: la próxima llamada trae todo lo que aparezca.
      const latest = changed.map((c) => c.updatedAt).sort().at(-1) ?? since ?? new Date(0).toISOString();
      return { changed: changed.map(toRef), cursor: latest };
    },

    async currentCursor() {
      // `orderBy: updatedAt` trae primero la más reciente: su `updatedAt` es el cursor que daría `changesSince()`.
      const { issues } = await gql<{ issues: { nodes: { updatedAt: string }[] } }>(QUERIES.latest, {});
      return issues.nodes[0]?.updatedAt ?? new Date(0).toISOString();
    },
  };
}

function toRef(raw: RawRef): IssueRef {
  return { tracker: "linear", id: raw.id, key: raw.identifier, url: raw.url };
}

/** Un estado de Linear a su categoría: el mapeo del proyecto, o por el tipo del estado. */
function categoryOf(state: { name: string; type: string }, mapping: StatusMapping | undefined): StatusCategory {
  const mapped = mapping?.[state.name];
  if (mapped !== undefined) return mapped;
  switch (state.type) {
    case "triage":
    case "backlog":
      return "backlog";
    case "unstarted":
      return "todo";
    case "started":
      return /review/i.test(state.name) ? "in_review" : "in_progress";
    case "completed":
      return "done";
    case "canceled":
    case "duplicate":
      return "canceled";
    default:
      throw new LinearApiError(`El estado "${state.name}" tiene un tipo que el adapter no conoce: "${state.type}".`);
  }
}

function parseCursor(cursor: string): string {
  if (!/^\d{4}-\d{2}-\d{2}T[\d:.]+Z$/.test(cursor) || Number.isNaN(Date.parse(cursor))) {
    throw new Error(`El cursor "${cursor}" no es de este tracker: pide changesSince() sin cursor para empezar de cero.`);
  }
  return cursor;
}

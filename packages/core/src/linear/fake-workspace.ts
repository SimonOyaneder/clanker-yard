import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { buildSchema, graphql, GraphQLError, type GraphQLSchema } from "graphql";

/**
 * Un workspace de Linear en memoria detrás del esquema GraphQL real (`fixtures/schema.graphql`, el subconjunto
 * que usa el adapter, con los tipos exactos de Linear): una query con un campo o argumento que Linear no
 * tiene no valida, y las que sí valen se ejecutan con la semántica de Linear que el adapter necesita
 * (conexiones con `first`/`after`, `orderBy`, filtros, `issueUpdate`, `commentCreate`). Es el `/graphql` de
 * `startFakeLinear`; el test arma los datos con esta API.
 */

export interface FakeUser {
  id: string;
  name: string;
}

export interface FakeState {
  id: string;
  name: string;
  /** `triage`, `backlog`, `unstarted`, `started`, `completed`, `canceled` o `duplicate`. */
  type: string;
  position: number;
  team: FakeTeam;
}

export interface FakeTeam {
  id: string;
  key: string;
  states: FakeState[];
  issueCount: number;
}

export interface FakeProject {
  id: string;
  name: string;
  /** Los 12 caracteres hex del final de la URL del proyecto. */
  slugId: string;
  /** El identificador visible (`P-ENG-1525`) que algunos workspaces muestran; Linear lo acepta en `project(id:)`. */
  identifier: string | null;
  lead: FakeUser | null;
  members: FakeUser[];
}

export interface FakeIssue {
  id: string;
  identifier: string;
  title: string;
  description: string | null;
  priority: number;
  estimate: number | null;
  labels: string[];
  assignee: FakeUser | null;
  state: FakeState;
  team: FakeTeam;
  project: FakeProject | null;
  milestone: { name: string; targetDate: string | null } | null;
  parent: FakeIssue | null;
  /** ms epoch; lo mueve cada cambio de la issue (no los comentarios). */
  updatedAt: number;
  createdAt: number;
  archived: boolean;
}

interface FakeRelation {
  id: string;
  type: "blocks" | "related";
  issue: FakeIssue;
  relatedIssue: FakeIssue;
}

interface FakeComment {
  id: string;
  issue: FakeIssue;
  user: FakeUser | null;
  botName: string | null;
  body: string;
  createdAt: number;
}

export interface NewFakeIssue {
  team: FakeTeam;
  title: string;
  /** Nombre del estado; por defecto el primero de tipo `unstarted`. */
  state?: string;
  description?: string;
  priority?: number;
  estimate?: number;
  labels?: string[];
  assignee?: FakeUser;
  project?: FakeProject;
  milestone?: { name: string; targetDate?: string };
  parent?: FakeIssue;
}

export interface FakeWorkspace {
  /** Quien autorizó el token: lo que devuelve `viewer` y a quien asigna un claim. */
  viewer: FakeUser;
  /**
   * El caso ENG-9084: Linear acepta `issueUpdate` (`success: true`) pero ignora el cambio de `stateId`
   * (por ejemplo, una automatización lo revierte).
   */
  ignoreStateUpdates: boolean;
  /** Las operaciones GraphQL que llegaron, en orden. */
  operations: { query: string; variables: Record<string, unknown> | undefined }[];
  addUser(name: string): FakeUser;
  /** Los estados salen de una lista de `{ name, type }` en el orden del equipo (`fixtures/states.*.json`). */
  addTeam(key: string, states: readonly { name: string; type: string }[]): FakeTeam;
  addProject(name: string, extra?: { lead?: FakeUser; members?: FakeUser[]; identifier?: string }): FakeProject;
  addIssue(input: NewFakeIssue): FakeIssue;
  /** `from` bloquea a `to`, o ambas quedan relacionadas. */
  relate(from: FakeIssue, type: "blocks" | "related", to: FakeIssue): void;
  addComment(issue: FakeIssue, comment: { user?: FakeUser; botName?: string; body: string }): FakeComment;
  /** Un cambio hecho desde fuera del adapter (otra persona, una automatización): sube `updatedAt`. */
  update(issue: FakeIssue, changes: { state?: string; assignee?: FakeUser | null; title?: string; labels?: string[] }): void;
  archive(issue: FakeIssue): void;
  /** Ejecuta una operación como lo haría `/graphql`. */
  execute(query: string, variables?: Record<string, unknown>): ReturnType<typeof graphql>;
}

const SCHEMA = readFileSync(new URL("./fixtures/schema.graphql", import.meta.url), "utf8");
const MAX_PAGE = 250;
const DEFAULT_PAGE = 50;
const BASE_TIME = Date.UTC(2026, 0, 1);

export function createFakeWorkspace({ workspace = "clanker-yard" }: { workspace?: string } = {}): FakeWorkspace {
  const schema: GraphQLSchema = buildSchema(SCHEMA);
  const teams: FakeTeam[] = [];
  const projects: FakeProject[] = [];
  const issues: FakeIssue[] = [];
  const relations: FakeRelation[] = [];
  const comments: FakeComment[] = [];
  let clock = BASE_TIME;
  // Un reloj lógico: cada cambio avanza un segundo, así los timestamps son únicos y ordenados.
  const tick = () => (clock += 1000);

  const fake: FakeWorkspace = {
    viewer: { id: randomUUID(), name: "Persona de prueba" },
    ignoreStateUpdates: false,
    operations: [],
    addUser: (name) => ({ id: randomUUID(), name }),
    addTeam(key, states) {
      const team: FakeTeam = { id: randomUUID(), key, states: [], issueCount: 0 };
      team.states = states.map((s, position) => ({ id: randomUUID(), ...s, position, team }));
      teams.push(team);
      return team;
    },
    addProject(name, { lead, members = [], identifier } = {}) {
      const id = randomUUID();
      const project = { id, name, slugId: id.replaceAll("-", "").slice(0, 12), identifier: identifier ?? null, lead: lead ?? null, members };
      projects.push(project);
      return project;
    },
    addIssue(input) {
      const state = input.state === undefined ? input.team.states.find((s) => s.type === "unstarted") : stateNamed(input.team, input.state);
      if (!state) throw new Error(`El equipo ${input.team.key} no tiene un estado "unstarted".`);
      const at = tick();
      input.team.issueCount += 1;
      const issue: FakeIssue = {
        id: randomUUID(),
        identifier: `${input.team.key}-${input.team.issueCount}`,
        title: input.title,
        description: input.description ?? null,
        priority: input.priority ?? 0,
        estimate: input.estimate ?? null,
        labels: input.labels ?? [],
        assignee: input.assignee ?? null,
        state,
        team: input.team,
        project: input.project ?? null,
        milestone: input.milestone ? { name: input.milestone.name, targetDate: input.milestone.targetDate ?? null } : null,
        parent: input.parent ?? null,
        updatedAt: at,
        createdAt: at,
        archived: false,
      };
      issues.push(issue);
      return issue;
    },
    relate(from, type, to) {
      relations.push({ id: randomUUID(), type, issue: from, relatedIssue: to });
      from.updatedAt = to.updatedAt = tick();
    },
    addComment(issue, { user, botName, body }) {
      const comment: FakeComment = {
        id: randomUUID(),
        issue,
        user: user ?? (botName === undefined ? fake.viewer : null),
        botName: botName ?? null,
        body,
        createdAt: tick(),
      };
      comments.push(comment);
      return comment;
    },
    update(issue, changes) {
      if (changes.state !== undefined) issue.state = stateNamed(issue.team, changes.state);
      if (changes.assignee !== undefined) issue.assignee = changes.assignee;
      if (changes.title !== undefined) issue.title = changes.title;
      if (changes.labels !== undefined) issue.labels = changes.labels;
      issue.updatedAt = tick();
    },
    archive(issue) {
      issue.archived = true;
      issue.updatedAt = tick();
    },
    execute(query, variables) {
      fake.operations.push({ query, variables });
      return graphql({ schema, source: query, rootValue: root, variableValues: variables });
    },
  };

  function stateNamed(team: FakeTeam, name: string): FakeState {
    const state = team.states.find((s) => s.name === name);
    if (!state) throw new Error(`El equipo ${team.key} no tiene un estado "${name}".`);
    return state;
  }

  /** `issue(id:)` acepta el id o el identificador (`CLA-57`). */
  function findIssue(id: string): FakeIssue {
    const found = issues.find((i) => !i.archived && (i.id === id || i.identifier === id));
    // El mensaje es el de Linear para una entidad que no existe.
    if (!found) throw new GraphQLError("Entity not found: Issue - Could not find referenced Issue.");
    return found;
  }

  interface Page {
    first?: number | null;
    after?: string | null;
  }

  /** Una conexión de Linear: `first` (50 por defecto, 250 como máximo) y `after` con un cursor opaco. */
  function connection<T>(items: T[], { first, after }: Page) {
    const size = first ?? DEFAULT_PAGE;
    if (size > MAX_PAGE) throw new GraphQLError(`Argument Validation Error: first no puede ser mayor que ${MAX_PAGE}.`);
    const start = after == null ? 0 : Number(after.replace(/^cursor:/, "")) + 1;
    if (!Number.isInteger(start) || start < 0) throw new GraphQLError("Argument Validation Error: cursor inválido.");
    const nodes = items.slice(start, start + size);
    const end = start + nodes.length;
    return {
      nodes,
      pageInfo: { hasNextPage: end < items.length, endCursor: nodes.length === 0 ? null : `cursor:${end - 1}` },
    };
  }

  /** Lo que `orderBy` ordena: de lo más reciente a lo más antiguo, `createdAt` por defecto. */
  function newestFirst<T extends { createdAt: number; updatedAt?: number }>(items: T[], orderBy: string | null | undefined): T[] {
    const key = (item: T) => (orderBy === "updatedAt" ? (item.updatedAt ?? item.createdAt) : item.createdAt);
    return [...items].sort((a, b) => key(b) - key(a));
  }

  const iso = (ms: number) => new Date(ms).toISOString();
  const projectNode = (p: FakeProject) => ({
    id: p.id,
    name: p.name,
    slugId: p.slugId,
    lead: userNode(p.lead),
    members: (members: Page) => connection(p.members.map(userNode), members),
  });
  const userNode = (user: FakeUser | null) => user && { id: user.id, name: user.name };
  const teamNode = (team: FakeTeam) => ({ id: team.id, key: team.key });
  const stateNode = (state: FakeState) => ({ id: state.id, name: state.name, type: state.type, position: state.position, team: teamNode(state.team) });
  const relationNode = (relation: FakeRelation) => ({
    id: relation.id,
    type: relation.type,
    issue: issueNode(relation.issue),
    relatedIssue: issueNode(relation.relatedIssue),
  });

  function issueNode(issue: FakeIssue): object {
    return {
      id: issue.id,
      identifier: issue.identifier,
      url: `https://linear.app/${workspace}/issue/${issue.identifier}`,
      title: issue.title,
      description: issue.description,
      priority: issue.priority,
      estimate: issue.estimate,
      labels: (page: Page) => connection(issue.labels.map((name) => ({ id: `label:${name}`, name })), page),
      assignee: userNode(issue.assignee),
      state: stateNode(issue.state),
      team: teamNode(issue.team),
      project: issue.project,
      projectMilestone: issue.milestone,
      parent: issue.parent && issueNode(issue.parent),
      relations: (page: Page) => connection(relations.filter((r) => r.issue === issue).map(relationNode), page),
      inverseRelations: (page: Page) => connection(relations.filter((r) => r.relatedIssue === issue).map(relationNode), page),
      updatedAt: iso(issue.updatedAt),
      archivedAt: issue.archived ? iso(issue.updatedAt) : null,
      comments: ({ orderBy, ...page }: Page & { orderBy?: string | null }) =>
        connection(
          newestFirst(comments.filter((c) => c.issue === issue), orderBy).map((c) => ({
            id: c.id,
            body: c.body,
            user: userNode(c.user),
            botActor: c.botName === null ? null : { name: c.botName },
            createdAt: iso(c.createdAt),
          })),
          page,
        ),
    };
  }

  interface IssueFilterArg {
    project?: { id?: { eq?: string } };
    updatedAt?: { gt?: string };
  }

  const root = {
    viewer: () => userNode(fake.viewer),
    organization: () => ({ urlKey: workspace }),
    issue: ({ id }: { id: string }) => issueNode(findIssue(id)),
    project: ({ id }: { id: string }) => {
      const found = projects.find((p) => p.id === id || p.slugId === id || p.identifier === id);
      if (!found) throw new GraphQLError("Entity not found: Project - Could not find referenced Project.");
      return projectNode(found);
    },
    projects: (page: Page) => connection(projects.map(projectNode), page),
    workflowStates: ({ filter, ...page }: Page & { filter?: { team?: { id?: { eq?: string } } } }) => {
      const teamId = filter?.team?.id?.eq;
      const states = teams.filter((t) => teamId === undefined || t.id === teamId).flatMap((t) => t.states);
      return connection(states.map(stateNode), page);
    },
    issues: ({ filter, orderBy, ...page }: Page & { filter?: IssueFilterArg; orderBy?: string | null }) => {
      const projectId = filter?.project?.id?.eq;
      const after = filter?.updatedAt?.gt === undefined ? undefined : Date.parse(filter.updatedAt.gt);
      if (after !== undefined && Number.isNaN(after)) throw new GraphQLError("Argument Validation Error: updatedAt no es una fecha ISO.");
      const matching = issues.filter(
        (i) => !i.archived && (projectId === undefined || i.project?.id === projectId) && (after === undefined || i.updatedAt > after),
      );
      return connection(newestFirst(matching, orderBy).map(issueNode), page);
    },
    issueUpdate: ({ id, input }: { id: string; input: { assigneeId?: string | null; stateId?: string | null } }) => {
      const issue = findIssue(id);
      if (input.assigneeId != null) {
        if (input.assigneeId !== fake.viewer.id) throw new GraphQLError("Entity not found: User - Could not find referenced User.");
        issue.assignee = fake.viewer;
      }
      if (input.stateId != null && !fake.ignoreStateUpdates) {
        const state = issue.team.states.find((s) => s.id === input.stateId);
        if (!state) throw new GraphQLError("Entity not found: WorkflowState - Could not find referenced WorkflowState.");
        issue.state = state;
      }
      issue.updatedAt = tick();
      return { success: true, issue: issueNode(issue) };
    },
    commentCreate: ({ input }: { input: { issueId?: string | null; body?: string | null } }) => {
      if (!input.issueId || !input.body) throw new GraphQLError("Argument Validation Error: falta issueId o body.");
      const comment = fake.addComment(findIssue(input.issueId), { body: input.body });
      return { success: true, comment: { id: comment.id, body: comment.body, user: userNode(comment.user), botActor: null, createdAt: iso(comment.createdAt) } };
    },
  };

  return fake;
}

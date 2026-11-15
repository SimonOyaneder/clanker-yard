import { FlowDef, type ClankerProject, type Origin, type StartRun } from "@clanker/api";
import type * as z from "zod";
import type { Defs } from "../defs/defs";
import { RunStartError, type Engine, type RunView } from "../flows/engine";
import type { Store } from "../store/store";
import type { Issues } from "../tracker/issues";
import type { Tracker } from "../tracker/tracker";
import type { Repos } from "../workspaces/repos";
import { ProjectNotFoundError, type Projects } from "./projects";

/** La issue no está en el caché de issues. */
export class IssueNotCachedError extends Error {}

export interface RunStarterDeps {
  store: Store;
  defs: Defs;
  projects: Projects;
  repos: Repos;
  issues: Issues;
  flows: Engine;
  /** Los adapters que este core conoce, por id de tracker (`local` y `linear`). */
  trackers: Readonly<Record<string, Tracker>>;
}

export interface RunStarter {
  /**
   * Reclama la issue en su tracker y lanza el flujo del proyecto (o `flow`) sobre ella. El flujo recibe
   * `repo` (el primero de `project.repos` con algún label de la issue; si ninguno calza, el primero) y
   * `base` (su branch por defecto) si los declara; `flowParams` del proyecto (solo con su flujo por
   * defecto) y `params` los pisan, en ese orden. Lanza `ProjectNotFoundError`, `IssueNotCachedError` o
   * `RunStartError` (con un mensaje que dice qué cambiar). Si el flujo no arranca, la issue queda
   * reclamada: reclamar es idempotente, así que basta corregir y reintentar.
   */
  start(input: z.output<typeof StartRun>, origin: Origin): Promise<RunView>;
}

export function createRunStarter({ store, defs, projects, repos, issues, flows, trackers }: RunStarterDeps): RunStarter {
  return {
    async start(input, origin) {
      const project = projects.get(input.projectId);
      if (!project) throw new ProjectNotFoundError(input.projectId);
      if (project.status !== "active") {
        throw new RunStartError(
          `El proyecto ${project.slug} está ${project.status}: reactívalo (projects.update) antes de lanzar corridas.`,
        );
      }
      const issue = issues.get(input.issueId);
      if (!issue) throw new IssueNotCachedError(`No hay una issue ${input.issueId} en el caché.`);
      if (issue.projectId !== project.id) {
        throw new RunStartError(`La issue ${issue.ref.key} es de otro proyecto, no de ${project.slug}.`);
      }
      const flow = input.flow ?? project.defaultFlowId;
      if (flow === null) {
        throw new RunStartError(
          `El proyecto ${project.slug} no tiene flujo por defecto: pasa \`flow\` o fija defaultFlowId con projects.update.`,
        );
      }

      const repoId = repoOf(project, issue.labels);
      const def = defs.resolve("flow", flow, { repoId });
      // Antes de reclamar: un flujo que no existe no debería dejar la issue tomada.
      if (!def) throw new RunStartError(`No existe el flujo "${flow}".`);
      const declared = FlowDef.parse(def.body).params ?? {};
      const params: Record<string, unknown> = {
        ...(repoId !== undefined && "repo" in declared ? { repo: repoId } : {}),
        ...(repoId !== undefined && "base" in declared ? { base: repos.config(repoId).defaultBranch } : {}),
        // Los flowParams del proyecto son del flujo por defecto: otro flujo no los declara.
        ...(flow === project.defaultFlowId ? project.flowParams : {}),
        ...input.params,
      };
      if (typeof declared.repo === "string" && params.repo === undefined) {
        throw new RunStartError(
          `El flujo "${flow}" necesita un repo y el proyecto ${project.slug} no tiene ninguno: regístralo con repos.add y agrégalo a \`repos\` con projects.update.`,
        );
      }

      const tracker = trackers[issue.ref.tracker];
      if (!tracker) {
        throw new RunStartError(`Este core todavía no tiene un adapter de ${issue.ref.tracker}: no puede reclamar ${issue.ref.key}.`);
      }
      try {
        await tracker.claim(issue.ref);
      } catch (error) {
        throw new RunStartError(`No se pudo reclamar ${issue.ref.key}: ${(error as Error).message}`, { cause: error });
      }
      // El caché ve la issue en progreso antes de que arranque la corrida.
      await issues.sync(tracker, { projectId: project.id, project: { tracker: project.tracker, id: project.trackerRef } }, origin);
      store.tx((tx) =>
        tx.emit({
          type: "issue.claimed",
          origin,
          projectId: project.id,
          subject: { type: "issue", id: issue.id },
          payload: { issueId: issue.id },
        }),
      );

      const runId = flows.start(flow, { type: "issue", id: issue.id }, params, {
        projectId: project.id,
        repoId,
        profile: project.defaultProfileId ?? undefined,
      });
      return flows.getRun(runId);
    },
  };
}

function repoOf(project: ClankerProject, labels: readonly string[]): string | undefined {
  const byLabel = project.repos.find((bound) => bound.labels.some((label) => labels.includes(label)));
  return (byLabel ?? project.repos[0])?.repoId;
}

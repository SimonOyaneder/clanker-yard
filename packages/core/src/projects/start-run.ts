import { FlowDef, type Origin, type StartRun } from "@clanker/api";
import type * as z from "zod";
import type { Defs } from "../defs/defs";
import { RunStartError, type Engine, type RunView } from "../flows/engine";
import type { Store } from "../store/store";
import type { Issues } from "../tracker/issues";
import type { Tracker } from "../tracker/tracker";
import { storedBinding, TrackerProjectsError, type ProjectBindings } from "../tracker/tracker-projects";
import type { Trackers } from "../tracker/trackers";
import type { Repos } from "../workspaces/repos";
import { ProjectNotFoundError, type Projects } from "./projects";
import type { IssuePlan } from "./issue-repos";
import { issuePlan } from "./repo-question";

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
  trackers: Trackers;
  /** De dónde sale la cola de un proyecto (`TrackerProjects.binding`); sin él, su `trackerRef` guardado. */
  binding?: ProjectBindings;
}

export interface RunStarter {
  /**
   * Reclama la issue en su tracker y lanza el flujo del proyecto (o `flow`) sobre ella. El flujo recibe
   * `repo` y `base` (su branch por defecto) si los declara; `flowParams` del proyecto (solo con su flujo por
   * defecto; su `repo` solo en un proyecto sin repos) y `params` los pisan, en ese orden (`dependsOn` se ignora si el flujo no lo declara).
   *
   * El repo es el que le toca a la issue (`planIssue`): el siguiente de su cadena si sus labels calzan con
   * varios repos (el flujo debe declarar `repo`), el único del proyecto o el que se eligió. Una issue
   * ambigua necesita `params.repo` o que se responda la decisión de la bandeja.
   *
   * Lanza `ProjectNotFoundError`, `IssueNotCachedError` o `RunStartError` (con un mensaje que dice qué
   * cambiar). Si el flujo no arranca, la issue queda reclamada: reclamar es idempotente, así que basta
   * corregir y reintentar.
   */
  start(input: z.output<typeof StartRun>, origin: Origin): Promise<RunView>;
}

export function createRunStarter({ store, defs, projects, repos, issues, flows, trackers, binding = storedBinding }: RunStarterDeps): RunStarter {
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

      const plan = issuePlan(store, repos, project, issue);
      const repoId = typeof input.params?.repo === "string" ? input.params.repo : planned(plan);
      if (repoId === undefined && plan.kind === "ambiguous") {
        throw new RunStartError(
          `${issue.ref.key} no calza ningún repo del proyecto ${project.slug}: pasa \`params.repo\` o responde la decisión de la bandeja que pregunta de qué repo es.`,
        );
      }
      const def = defs.resolve("flow", flow, { repoId });
      // Antes de reclamar: un flujo que no existe no debería dejar la issue tomada.
      if (!def) throw new RunStartError(`No existe el flujo "${flow}".`);
      const declared = FlowDef.parse(def.body).params ?? {};
      if (plan.kind === "repos" && plan.repoIds.length > 1 && !("repo" in declared)) {
        throw new RunStartError(
          `${issue.ref.key} toca ${plan.repoIds.length} repos y el flujo "${flow}" no declara \`repo\`: no puede encadenar una corrida por repo.`,
        );
      }
      const params: Record<string, unknown> = {
        ...(repoId !== undefined && "repo" in declared ? { repo: repoId } : {}),
        ...(repoId !== undefined && "base" in declared ? { base: repos.config(repoId).defaultBranch } : {}),
        // Los flowParams del proyecto son del flujo por defecto, y solo los que declara: los demás son de los
        // flujos que arrancan los triggers (una política como `rebaseNonDraft`) y aquí no cuentan. Su `repo` solo
        // vale en un proyecto sin repos: con repos, el de la corrida es el de la issue (pisarlo la correría en otro).
        ...(flow === project.defaultFlowId
          ? Object.fromEntries(Object.entries(project.flowParams).filter(([name]) => name in declared && !(name === "repo" && project.repos.length > 0)))
          : {}),
        // `dependsOn` lo pone el Scheduler desde la cola: un flujo que no publica PRs no lo declara ni lo necesita.
        ...Object.fromEntries(Object.entries(input.params ?? {}).filter(([name]) => name !== "dependsOn" || name in declared)),
      };
      if (typeof declared.repo === "string" && params.repo === undefined) {
        throw new RunStartError(
          `El flujo "${flow}" necesita un repo y el proyecto ${project.slug} no tiene ninguno: regístralo con repos.add y agrégalo a \`repos\` con projects.update.`,
        );
      }

      let tracker: Tracker | undefined;
      try {
        tracker = trackers(project);
      } catch (error) {
        throw new RunStartError(`No se pudo reclamar ${issue.ref.key}: ${(error as Error).message}`, { cause: error });
      }
      if (!tracker) {
        throw new RunStartError(`Este core todavía no tiene un adapter de ${issue.ref.tracker}: no puede reclamar ${issue.ref.key}.`);
      }
      try {
        await tracker.claim(issue.ref);
      } catch (error) {
        throw new RunStartError(`No se pudo reclamar ${issue.ref.key}: ${(error as Error).message}`, { cause: error });
      }
      // El caché ve la issue en progreso antes de que arranque la corrida.
      try {
        await issues.sync(tracker, await binding(project), origin);
      } catch (error) {
        if (error instanceof TrackerProjectsError) throw new RunStartError(`No se pudo reclamar ${issue.ref.key}: ${error.message}`, { cause: error });
        throw error;
      }
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

/** El repo de la próxima corrida de la issue; si ya corrió en todos (un reintento a mano), el primero. */
function planned(plan: IssuePlan): string | undefined {
  return plan.kind === "repos" ? (plan.next ? plan.next.repoId : plan.repoIds[0]) : undefined;
}

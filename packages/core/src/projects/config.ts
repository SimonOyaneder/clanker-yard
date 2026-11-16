import { ProjectConfig, type ClankerProject, type ClientOrigin, type DefIssue, type ProjectId, type ProjectImportResult, type ProjectPatch } from "@clanker/api";
import type { Defs } from "../defs/defs";
import { diffBodies } from "../defs/write";
import type { Repos } from "../repos/repos";
import { InvalidProjectError, ProjectNotFoundError, type Projects } from "./projects";
import { issuesAsLines } from "../errors/format";

export interface ProjectConfigs {
  /** La configuración del proyecto para llevarla a otra máquina: sus repos por nombre y remoto, no por id. Lanza `ProjectNotFoundError`. */
  export(id: ProjectId): ProjectConfig;
  /**
   * Aplica `raw` (una `ProjectConfig` sin validar) al proyecto `id`. Todo se valida antes de escribir; con
   * `dryRun`, o si hay `errors`, no se escribe nada. Los repos se buscan en esta máquina por remoto (o por nombre,
   * si el export no tenía remoto): uno no registrado, un flujo o un perfil que no existe aquí quedan en `unmapped`
   * y se omiten sin frenar el resto. Si ningún repo de la configuración se encuentra, la lista de repos del
   * proyecto no se toca. Con errores y sin `dryRun` lanza `InvalidProjectError`. Lanza `ProjectNotFoundError`.
   */
  import(id: ProjectId, raw: unknown, by: ClientOrigin, opts: { dryRun: boolean }): ProjectImportResult;
}

export function createProjectConfigs({ projects, repos, defs }: { projects: Projects; repos: Repos; defs: Defs }): ProjectConfigs {
  function get(id: ProjectId): ClankerProject {
    const project = projects.get(id);
    if (!project) throw new ProjectNotFoundError(id);
    return project;
  }

  /** Lo que importar puede cambiar, con los repos por nombre (el id no le dice nada a quien lee el diff). */
  const comparable = (p: Pick<ClankerProject, "defaultFlowId" | "defaultProfileId" | "queueFilter" | "conventions" | "parallel" | "stackOn" | "statusMapping" | "flowParams" | "maxCostUsd" | "repos">) => ({
    defaultFlowId: p.defaultFlowId,
    defaultProfileId: p.defaultProfileId,
    repos: p.repos.map(({ repoId, labels }) => ({ repo: repos.get(repoId)?.name ?? repoId, labels })),
    queueFilter: p.queueFilter,
    conventions: p.conventions,
    parallel: p.parallel,
    stackOn: p.stackOn,
    statusMapping: p.statusMapping,
    flowParams: p.flowParams,
    maxCostUsd: p.maxCostUsd,
  });

  return {
    export(id) {
      const project = get(id);
      return {
        clankerProjectConfig: 1,
        name: project.name,
        tracker: project.tracker,
        trackerRef: project.trackerRef,
        trackerAccount: project.trackerAccount,
        defaultFlowId: project.defaultFlowId,
        defaultProfileId: project.defaultProfileId,
        repos: project.repos.flatMap(({ repoId, labels }) => {
          const repo = repos.get(repoId);
          return repo ? [{ name: repo.name, remote: repo.remote, labels }] : [];
        }),
        queueFilter: project.queueFilter,
        conventions: project.conventions,
        parallel: project.parallel,
        stackOn: project.stackOn,
        statusMapping: project.statusMapping,
        flowParams: project.flowParams,
        maxCostUsd: project.maxCostUsd,
      };
    },

    import(id, raw, origin, { dryRun }) {
      const project = get(id);
      const parsed = ProjectConfig.safeParse(raw);
      if (!parsed.success) {
        const errors = parsed.error.issues.map(({ path, message }) => ({ path: path.map(String).join("."), message }));
        return reject(errors, dryRun);
      }
      const config = parsed.data;
      const errors: DefIssue[] = [];
      const unmapped: DefIssue[] = [];

      const mapped: ClankerProject["repos"] = [];
      config.repos.forEach((entry, i) => {
        const path = `repos.${i}`;
        const local = entry.remote === null ? repos.list().find((r) => r.name === entry.name) : repos.byRemote(entry.remote);
        if (!local) {
          unmapped.push({ path, message: `${entry.remote ?? entry.name} no está registrado en esta máquina: regístralo en Conexiones y vuelve a importar.` });
          return;
        }
        if (mapped.some((m) => m.repoId === local.id)) errors.push({ path, message: `${local.name} aparece dos veces en la configuración.` });
        for (const label of entry.labels) {
          const owner = mapped.find((m) => m.repoId !== local.id && m.labels.includes(label));
          if (owner) errors.push({ path: `${path}.labels`, message: `el label "${label}" manda a dos repos (${repos.get(owner.repoId)?.name} y ${local.name}): déjalo en uno.` });
        }
        mapped.push({ repoId: local.id, labels: entry.labels });
      });

      const patch: ProjectPatch = {
        queueFilter: config.queueFilter,
        conventions: config.conventions,
        parallel: config.parallel,
        stackOn: config.stackOn,
        statusMapping: config.statusMapping,
        flowParams: config.flowParams,
        maxCostUsd: config.maxCostUsd,
        ...(mapped.length > 0 || config.repos.length === 0 ? { repos: mapped } : {}),
      };
      if (config.defaultFlowId !== null) {
        if (defs.resolve("flow", config.defaultFlowId)) patch.defaultFlowId = config.defaultFlowId;
        else unmapped.push({ path: "defaultFlowId", message: `no existe el flujo "${config.defaultFlowId}" en esta máquina: queda el que ya tenía el proyecto.` });
      } else patch.defaultFlowId = null;
      if (config.defaultProfileId !== null) {
        if (defs.resolve("profile", config.defaultProfileId)) patch.defaultProfileId = config.defaultProfileId;
        else unmapped.push({ path: "defaultProfileId", message: `no existe el perfil "${config.defaultProfileId}" en esta máquina: queda el que ya tenía el proyecto.` });
      } else patch.defaultProfileId = null;

      const after = comparable({ ...project, ...patch, repos: patch.repos ?? project.repos } as ClankerProject);
      const changes = diffBodies(comparable(project), after);
      if (errors.length > 0) return { ...reject(errors, dryRun), unmapped, changes };
      if (dryRun) return { applied: false, errors, unmapped, changes };
      projects.update(id, patch, origin);
      return { applied: changes.length > 0, errors, unmapped, changes };
    },
  };
}

/** Con `dryRun` los errores son un resultado; sin él, un `InvalidProjectError` (nada se escribió). */
function reject(errors: DefIssue[], dryRun: boolean): ProjectImportResult {
  if (!dryRun) {
    throw new InvalidProjectError(`No se importó la configuración:\n${issuesAsLines(errors)}`);
  }
  return { applied: false, errors, unmapped: [], changes: [] };
}

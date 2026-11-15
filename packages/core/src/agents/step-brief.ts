import type { Brief, IssueId } from "@clanker/api";
import { and, eq } from "drizzle-orm";
import type { Artifacts } from "../artifacts/artifacts";
import type { StepBriefRequest } from "../flows/engine";
import { artifactRefs } from "../store/schema";
import type { Store } from "../store/store";
import type { Issues } from "../tracker/issues";
import type { Tracker } from "../tracker/tracker";
import type { Workspaces } from "../workspaces/workspaces";
import type { Briefs } from "./brief";

export interface StepBriefsDeps {
  store: Store;
  workspaces: Pick<Workspaces, "held">;
  briefs: Briefs;
  artifacts: Artifacts;
  issues: Pick<Issues, "get">;
  /** Los adapters por id de tracker: de ahí sale el detalle de la issue del sujeto. */
  trackers: Readonly<Record<string, Tracker>>;
}

/**
 * El `briefFor` del motor: prepara `.clanker-run/` en el worktree de la corrida (`createBriefs`) y arma
 * el brief que lo cita. La issue del sujeto (si es una issue del caché) va como `issue.md` y en
 * `brief.issue`. `diff-round.patch` es lo que cambió desde la última vez que ese mismo nodo miró el
 * worktree: el snapshot de cada paso queda como artefacto de la corrida (`snapshot/<nodo>/<visita>/<intento>`)
 * y el siguiente paso del nodo parte del más reciente.
 */
export function createStepBriefs({ store, workspaces, briefs, artifacts, issues, trackers }: StepBriefsDeps) {
  function lastSnapshot(request: StepBriefRequest): string | undefined {
    const prefix = `snapshot/${request.nodeId}/`;
    const found = store.db
      .select({ hash: artifactRefs.hash, role: artifactRefs.role })
      .from(artifactRefs)
      .where(and(eq(artifactRefs.ownerType, "run"), eq(artifactRefs.ownerId, request.run.id)))
      .all()
      .filter((ref) => ref.role.startsWith(prefix))
      .map((ref) => {
        const [visit = 0, attempt = 0] = ref.role.slice(prefix.length).split("/").map(Number);
        return { hash: ref.hash, visit, attempt };
      })
      .filter((ref) => ref.visit < request.visit)
      .sort((a, b) => b.visit - a.visit || b.attempt - a.attempt)[0];
    return found && new TextDecoder().decode(artifacts.get(found.hash)?.content);
  }

  return async function briefFor(request: StepBriefRequest): Promise<Brief> {
    const held = request.lineage.map((id) => workspaces.held(id)).find((w) => w !== undefined);
    if (!held) throw new Error(`El paso "${request.nodeId}" es un agente y la corrida no tiene un worktree tomado.`);

    const cached = request.run.subject.type === "issue" ? issues.get(request.run.subject.id as IssueId) : undefined;
    const tracker = cached && trackers[cached.ref.tracker];
    const issue = tracker && cached ? await tracker.getIssue(cached.ref) : undefined;

    const { brief, snapshot } = await briefs.prepare({
      lease: { ...held, baseRef: held.base },
      run: request.run,
      mode: request.mode,
      issue,
      since: lastSnapshot(request),
      payload: request.payload,
    });
    const role = `snapshot/${request.nodeId}/${request.visit}/${request.run.attempt}`;
    artifacts.ref(artifacts.put(snapshot, "snapshot"), { type: "run", id: request.run.id, role });
    return brief;
  };
}

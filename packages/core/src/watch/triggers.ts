import { FlowDef, type Event, type EventType, type PrRef } from "@clanker/api";
import { eq } from "drizzle-orm";
import type { Defs } from "../defs/defs";
import type { Engine } from "../flows/engine";
import type { Projects } from "../projects/projects";
import { pullRequests } from "../store/schema";
import type { Store } from "../store/store";
import type { Repos } from "../workspaces/repos";
import type { ErrorReporter } from "./report";

/** Los eventos de un PR que arrancan flujos (`trigger.type` del flujo es el mismo texto). */
const TRIGGERS = ["pr.comment", "pr.conflict", "pr.merged", "pr.base_rewritten"] as const satisfies readonly EventType[];

export interface TriggersDeps {
  store: Store;
  defs: Pick<Defs, "list" | "resolve">;
  projects: Pick<Projects, "get">;
  repos: Pick<Repos, "get" | "config">;
  flows: Pick<Engine, "start">;
  errors: ErrorReporter;
}

/**
 * Arranca los flujos cuyo `trigger` es el evento de un PR del sistema (`docs/design.html#d-ops`, "Watch:
 * eventos y qué disparan"): sobre ese PR como sujeto, con el carril del flujo (los `pr.*` van a
 * mantenimiento) y el perfil del proyecto que abrió el PR. Escucha el store y no a Watch, así que sirve
 * igual a un evento que emite otra pieza (`stack.restack` anota `pr.conflict`). Solo los PRs `owned`
 * disparan flujos; los demás (los tuyos que el sistema no abrió) solo generan el evento.
 *
 * Params: un flujo recibe lo que declare entre `pr` (`PrRef`), `repo` (el id del repo registrado), `branch`
 * (la branch del PR), los campos del payload del evento (`sha`, `from`, `to`, `base`, `threadIds`, `files`...) y los
 * `flowParams` del proyecto que abrió el PR (una política como `rebaseNonDraft`). El `filter` del trigger
 * pide que cada clave valga lo mismo en el payload. `start` es idempotente por (flujo, sujeto): un
 * evento nuevo con la corrida anterior todavía viva no abre otra. Un flujo que no arranca (falta un
 * param, un rol) deja un evento `error` y no frena a los demás. Devuelve cómo dejar de escuchar.
 */
export function startTriggers({ store, defs, projects, repos, flows, errors }: TriggersDeps): () => void {
  function dispatch(event: Event): void {
    if (event.subject?.type !== "pr") return;
    const row = store.db.select().from(pullRequests).where(eq(pullRequests.id, event.subject.id)).get();
    const remote = row && repos.get(row.repoId) && repos.config(row.repoId).remote;
    if (!row?.owned || !remote) return;
    // Con threads de council un rebase reescribiría su historia, y eso nunca se fuerza (`workspaces.rebase`).
    if (event.type === "pr.conflict" && row.detail?.threads.councilEver) return;

    const pr: PrRef = { account: remote.account, repo: remote.repo, number: row.number };
    const project = event.projectId ? projects.get(event.projectId) : undefined;
    // Lo que el evento da pisa a los `flowParams` del proyecto, que solo cambian defaults.
    const available: Record<string, unknown> = { ...project?.flowParams, ...event.payload, pr, repo: row.repoId, branch: row.headRef };
    const profile = project?.defaultProfileId || undefined;

    for (const slug of new Set(defs.list("flow").map((def) => def.slug))) {
      // El flujo que gana para este repo; uno que ya no valida lo reporta quien lo lance.
      const def = defs.resolve("flow", slug, { repoId: row.repoId });
      const parsed = def && FlowDef.safeParse(def.body);
      if (!parsed?.success || parsed.data.trigger.type !== event.type || !matches(parsed.data.trigger.filter, event.payload)) continue;
      const declared = Object.keys(parsed.data.params ?? {});
      const params = Object.fromEntries(declared.flatMap((name) => (name in available ? [[name, available[name]]] : [])));
      const scope = `trigger ${slug}`;
      try {
        flows.start(slug, event.subject, params, { projectId: event.projectId, repoId: row.repoId, profile });
        errors.clear(scope);
      } catch (error) {
        errors.report(scope, error);
      }
    }
  }

  return store.events.subscribe(
    (event) => {
      try {
        dispatch(event);
      } catch (error) {
        errors.report(`trigger ${event.type}`, error);
      }
    },
    { types: [...TRIGGERS] },
  );
}

function matches(filter: Record<string, unknown> | undefined, payload: Record<string, unknown>): boolean {
  return Object.entries(filter ?? {}).every(([key, value]) => JSON.stringify(payload[key]) === JSON.stringify(value));
}

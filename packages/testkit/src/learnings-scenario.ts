import type { Client, ProjectId, RepoId, RunId } from "@clanker/api";
import { createLearnings, proposeLearning, type Store } from "@clanker/core";

// El escenario de `DEMO_SCENARIO=learnings` (ver `demo-core.ts`): la revisión de learnings con lo que habría en una
// instalación real. Casi todo es lo que importa el clanker-loop (decisión 19: siempre `proposed`, de un proyecto y para
// todos los roles), más lo que proponen los agentes en sus reportes, un par escritos a mano y algunos ya resueltos.
//
// Se siembra por `proposeLearning` (el mismo código que corre al importar o al cerrar un paso) y las aprobaciones por
// `createLearnings(store).approve(..., "ui")`: por la API con origin `cli` el core las rechazaría, como debe.

interface Seed {
  text: string;
  /** Qué proyecto del escenario: 0 `demo`, 1 el de boundaries, 2 el de soporte. */
  project?: 0 | 1 | 2;
  /** Con alcance de repo (el repo `demo`) en vez de proyecto. */
  repo?: true;
  roles?: string[];
  tags?: string[];
  source?: "import" | "agent" | "human";
  status?: "proposed" | "approved" | "rejected" | "archived";
}

const IMPORTED: Seed[] = [
  { project: 1, text: "El scope por organización se pasa siempre explícito: ningún query de un engine lee `Current.organization`." },
  { project: 1, text: "Antes de tocar un engine, correr `bin/boundaries check` para ver qué dependencias ya están prohibidas." },
  { project: 1, text: "Los specs de un engine no cargan fixtures de otro: se arman con las factories del propio engine." },
  { project: 1, text: "Un `review_note` sobre un PR mergeado se expira solo: no lo busques en la bandeja." },
  { project: 1, text: "El CLI del loop viejo se llamaba con `loop run`; en Yard es `clanker runs start`." },
  { project: 1, text: "Los PRs de la cadena salen sobre la rama del anterior, no sobre main, hasta que el de abajo se mergea." },
  { project: 1, text: "Si `srb tc` falla por un tipo de otro engine, no lo silencies con `T.unsafe`: abre un RBI en el engine dueño." },
  { project: 1, text: "El label `no-clanker` saca una issue de la cola aunque esté en Todo." },
  { project: 1, text: "Cuando un thread del bot es un falso positivo, responde con la razón en una frase y resuélvelo." },
  { project: 1, text: "El bot de review tarda hasta 10 minutos en contestar `/review`: no lo pidas dos veces seguidas." },
  { project: 1, text: "Un rebase con conflicto en `Gemfile.lock` se resuelve tomando el de main y corriendo `bundle`." },
  { project: 1, text: "Los renames de constantes van en un commit aparte, sin cambios de comportamiento." },
  { project: 1, text: "Las migraciones de datos de más de 10 mil filas usan `Sidekiq::IterableJob`." },
  { project: 1, text: "No mezclar el cambio de un engine con el de otro en el mismo commit: el reviewer los separa de todos modos." },
  { project: 1, text: "El loop descartaba las issues con más de 3 padres; Yard las trabaja sobre una base combinada." },
  { project: 1, text: "Los checks del CI se leen por `statuses`, no por `check_runs`, en los repos con la app vieja de CI." },
  { project: 2, text: "Cada issue de SOPORTE lleva su borrador de copy en la descripción: léelo antes de planear." },
  { project: 2, text: "Los textos de la UI van en español neutro y sin voseo." },
  { project: 2, text: "Una pantalla nueva pasa por el audit de UX antes de abrir el PR." },
  { project: 2, text: "Los tooltips de un tag explican qué significa, no repiten su nombre." },
  { project: 2, text: "El loop guardaba el checkpoint en `~/.clanker-loop/state.json`; en Yard todo está en la base." },
  { project: 2, text: "Los screenshots de una vista se sacan en claro y en oscuro y no se commitean." },
  { project: 0, text: "Los saludos del juguete se escriben en minúscula." },
  { project: 0, text: "Si la receta del repo falla en `setup.worktree`, el paso queda `failed` sin gastar un turno del agente." },
  { project: 0, text: "El hook de pre-commit tarda unos 40 segundos: espéralo, no lo saltes." },
  { project: 0, text: "`clanker import legacy` solo lee la carpeta del loop; nunca la modifica." },
];

const AGENT: Seed[] = [
  { project: 0, source: "agent", roles: ["review-bugs"], text: "Un `needs_human` por tope de gasto se resuelve con `continue`, que suma otra vez el tope: revisa el costo antes de elegirlo." },
  { project: 0, source: "agent", roles: ["dev"], text: "Correr `recipe.check` antes de `commit`: en las últimas corridas el commit falló por lint y gastó un turno de más." },
  { project: 0, source: "agent", roles: ["review-patterns"], text: "Los helpers de boundaries llevan el sufijo del engine dueño, como los vecinos." },
  { project: 0, source: "agent", roles: ["dev", "committer"], tags: ["git"], text: "Un commit que toca `package-lock.json` sin tocar `package.json` casi siempre es ruido: descártalo." },
  { project: 0, source: "agent", repo: true, text: "En este repo los tests lentos viven en `e2e/` y no corren con `npm test`." },
];

const HUMAN: Seed[] = [
  { project: 1, source: "human", roles: ["committer"], text: "El mensaje del commit va en inglés aunque el PR esté en español." },
  { project: 0, source: "human", repo: true, tags: ["receta"], text: "La receta de este repo instala dependencias en 3 pasos: no la reemplaces por un `npm ci` suelto." },
];

/** Los que ya se revisaron: así las pestañas de aprobados, rechazados y retirados no salen vacías. */
const REVIEWED: Seed[] = [
  { project: 1, status: "approved", text: "Mergear solo con el comando que comenta el pack: nunca con `gh pr merge`." },
  { project: 1, status: "approved", source: "agent", roles: ["review-bugs", "review-tests"], text: "Revisar el scope de organización en cada query nuevo de un engine." },
  { project: 1, status: "approved", roles: ["committer"], tags: ["git"], text: "Un commit por cambio atómico, con sus tests en el mismo commit." },
  { project: 2, status: "approved", text: "Los textos nuevos de la UI pasan por la revisión de copy antes del PR." },
  { project: 0, status: "approved", repo: true, text: "`npm ci` antes de cualquier check: el worktree nace sin `node_modules`." },
  { project: 0, status: "rejected", text: "Reiniciar el core antes de cada corrida." },
  { project: 1, status: "rejected", text: "El loop viejo pedía confirmación antes de cada push: ya no hace falta." },
  { project: 2, status: "archived", text: "Los PRs de SOPORTE van siempre en draft hasta el jueves." },
];

/**
 * Siembra la revisión de learnings sobre el proyecto `demo` (el que ya creó el core de demo) y dos más. `runId` es la
 * corrida de la que dicen venir los propuestos por agentes. Devuelve cuántos quedaron en cada estado.
 */
export async function seedLearnings(opts: { client: Client; store: Store; repoId: RepoId; demoProjectId: ProjectId; runId: RunId }): Promise<{ proposed: number; approved: number }> {
  const { client, store, repoId, demoProjectId, runId } = opts;
  const boundaries = await client.projects.create({ slug: "boundaries", name: "Boundaries de engines", tracker: "local", defaultFlowId: "juguete", defaultProfileId: "juguete" });
  const soporte = await client.projects.create({ slug: "soporte", name: "SOPORTE", tracker: "local", defaultFlowId: "juguete", defaultProfileId: "juguete" });
  const projects = [demoProjectId, boundaries.id, soporte.id];
  const learnings = createLearnings(store);

  let proposed = 0;
  let approved = 0;
  const all: Seed[] = [...IMPORTED, ...AGENT, ...HUMAN, ...REVIEWED];
  for (const seed of all) {
    const source = seed.source ?? "import";
    const learning = store.tx((tx) =>
      proposeLearning(tx, {
        ...(seed.repo ? { repoId } : { projectId: projects[seed.project ?? 0]! }),
        text: seed.text,
        roles: seed.roles ?? [],
        tags: seed.tags ?? [],
        source,
        ...(source === "agent" ? { sourceRunId: runId } : {}),
        origin: source === "import" ? "import" : source === "agent" ? "core" : "cli",
      }),
    );
    if (seed.status === "approved" || seed.status === "archived") learnings.approve(learning.id, "ui");
    if (seed.status === "archived" || seed.status === "rejected") learnings.reject(learning.id, "ui");
    if (seed.status === "approved") approved++;
    if (!seed.status) proposed++;
  }
  return { proposed, approved };
}

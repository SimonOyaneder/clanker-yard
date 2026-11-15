import type { FlowDef, Profile, Role } from "@clanker/api";

// La plantilla de juguete (`docs/design.html#fases`, fase 0): lo mínimo que ejercita el motor de punta
// a punta. Toma el worktree del repo, un agente de prueba lo saluda y se suelta el worktree. Su guion
// para el runtime fake vive en `packages/testkit/fixtures/runs/juguete`.

export const JUGUETE_FLOW: FlowDef = {
  schema: 1,
  id: "juguete",
  name: "Juguete",
  trigger: { type: "manual" },
  effects: "local",
  /** `repo` es el id de un repo registrado; el proyecto lo fija en `flowParams`. */
  params: { repo: "string", base: { type: "string", default: "main" } },
  start: "acquire",
  nodes: {
    acquire: {
      type: "action",
      action: "workspace.acquire",
      // La branch es el id de la issue: único por sujeto y siempre un nombre de branch válido.
      args: { repo: "$run.params.repo", branch: "$run.subject.id", base: "$run.params.base" },
      on: { ok: "saludar" },
    },
    saludar: {
      type: "agent",
      role: "juguete",
      mode: "saludar",
      brief: { subject: "$run.subject" },
      on: { ok: "release" },
    },
    release: {
      type: "action",
      action: "workspace.release",
      args: { workspaceId: "$acquire.workspaceId", fencingToken: "$acquire.fencingToken" },
      on: { ok: "@done" },
    },
  },
};

export const JUGUETE_ROLE: Role = {
  prompt: "Eres el rol de prueba del flujo de juguete: no cambias nada en el repo, solo respondes con el reporte que se te pide.",
  context: [],
  modes: {
    saludar: {
      instructions: "Saluda y devuelve el saludo en el reporte.",
      report: { type: "object", properties: { saludo: { type: "string" } }, required: ["saludo"] },
      outcomes: ["ok"],
      session: "new",
    },
  },
};

export const JUGUETE_PROFILE: Profile = { roles: { juguete: { model: "haiku", effort: "low" } } };

import { type ContextSource, type JsonSchema, Role, type RoleMode } from "@clanker/api";
import * as z from "zod";
import {
  ChatTurnBrief,
  ChatTurnReport,
  CommitBrief,
  CommitPlan,
  CommitRoute,
  DevPlanReport,
  DevWorkBrief,
  DevWorkReport,
  PlanCheckBrief,
  PlanCheckReport,
  ReviewBrief,
  ReviewReport,
  RouteBrief,
  TriageBrief,
  TriageReport,
} from "./payloads";
import * as prompts from "./prompts";

/** El brief se valida suelto: un flujo puede pasar claves que el modo no declara. */
const briefSchema = (schema: z.ZodType) => z.toJSONSchema(schema, { io: "input" }) as JsonSchema;
/** El reporte se valida estricto y es el esquema de salida que ve el modelo. */
const reportSchema = (schema: z.ZodType) => z.toJSONSchema(schema, { io: "output" }) as JsonSchema;

function mode(spec: {
  instructions: string;
  brief?: z.ZodType;
  report: z.ZodType;
  outcomes: string[];
  session: RoleMode["session"];
  learnings?: boolean;
}): RoleMode {
  return {
    instructions: spec.instructions,
    ...(spec.brief && { payload: briefSchema(spec.brief) }),
    report: reportSchema(spec.report),
    outcomes: spec.outcomes,
    session: spec.session,
    ...(spec.learnings && { learnings: true }),
  };
}

/** Los archivos del workspace, del repo y del sub-proyecto con las reglas del equipo. */
const agentsMd: ContextSource = { kind: "repo", files: ["AGENTS.md"] };
/**
 * Lo que traen el usuario (`~/.claude`) y el repo, sin skills: cada skill que no se usa es contexto
 * que no se paga. Un rol que las necesita las agrega por nombre.
 */
const native: ContextSource = { kind: "native", sources: ["user", "project"], skills: [] };
/** Un pack es una referencia: si falta, el rol corre sin él. Los packs de un equipo los definen sus dueños. */
const pack = (id: string): ContextSource => ({ kind: "pack", id });

const dev = Role.parse({
  prompt: prompts.DEV_PROMPT,
  context: [native, agentsMd, pack("lore")],
  modes: {
    plan: mode({
      instructions: prompts.DEV_PLAN,
      report: DevPlanReport,
      outcomes: ["ok"],
      session: "new",
    }),
    implement: mode({
      instructions: prompts.DEV_IMPLEMENT,
      brief: DevWorkBrief,
      report: DevWorkReport,
      outcomes: ["ok"],
      session: "resume",
      learnings: true,
    }),
    fix: mode({
      instructions: prompts.DEV_FIX,
      brief: DevWorkBrief,
      report: DevWorkReport,
      outcomes: ["ok"],
      session: "resume-if-warm",
      learnings: true,
    }),
    council: mode({
      instructions: prompts.DEV_COUNCIL,
      brief: DevWorkBrief,
      report: DevWorkReport,
      outcomes: ["ok"],
      session: "new",
    }),
    conflict: mode({
      instructions: prompts.DEV_CONFLICT,
      brief: DevWorkBrief,
      report: DevWorkReport,
      outcomes: ["resolved", "behavior"],
      session: "new",
    }),
  },
});

/** Los cuatro reviewers comparten prompt, y con él el prefijo de la caché; cambia la rúbrica del modo. */
function reviewer(rubric: string, context: ContextSource[]): Role {
  const review = (instructions: string) =>
    mode({ instructions, brief: ReviewBrief, report: ReviewReport, outcomes: ["ok", "changes"], session: "new" });
  return Role.parse({
    prompt: prompts.REVIEWER_PROMPT,
    context: [native, agentsMd, ...context],
    modes: {
      review: review(rubric),
      "re-review": review(`${rubric}\n\n${prompts.REVIEW_RE_REVIEW}`),
    },
  });
}

const committer = Role.parse({
  prompt: prompts.COMMITTER_PROMPT,
  context: [native, agentsMd, pack("commits")],
  modes: {
    plan: mode({
      instructions: prompts.COMMITTER_PLAN,
      brief: CommitBrief,
      report: CommitPlan,
      outcomes: ["ok"],
      session: "new",
    }),
    route: mode({
      instructions: prompts.COMMITTER_ROUTE,
      brief: RouteBrief,
      report: CommitRoute,
      outcomes: ["ok"],
      session: "new",
    }),
  },
});

const triage = Role.parse({
  prompt: prompts.TRIAGE_PROMPT,
  context: [native, agentsMd],
  modes: {
    bot: mode({
      instructions: prompts.TRIAGE_BOT,
      brief: TriageBrief,
      report: TriageReport,
      outcomes: ["fix", "reply"],
      session: "new",
      learnings: true,
    }),
    coverage: mode({
      instructions: prompts.TRIAGE_COVERAGE,
      brief: TriageBrief,
      report: TriageReport,
      outcomes: ["fix", "reply"],
      session: "new",
      learnings: true,
    }),
    ci: mode({
      instructions: prompts.TRIAGE_CI,
      brief: TriageBrief,
      report: TriageReport,
      outcomes: ["fix", "foreign", "unsure"],
      session: "new",
      learnings: true,
    }),
  },
});

const planCheck = Role.parse({
  prompt: prompts.PLAN_CHECK_PROMPT,
  context: [native, agentsMd],
  modes: {
    check: mode({
      instructions: prompts.PLAN_CHECK_CHECK,
      brief: PlanCheckBrief,
      report: PlanCheckReport,
      outcomes: ["ok", "changes"],
      session: "new",
    }),
  },
});

const chat = Role.parse({
  prompt: prompts.CHAT_PROMPT,
  context: [native, agentsMd],
  modes: {
    turn: mode({
      instructions: prompts.CHAT_TURN,
      brief: ChatTurnBrief,
      report: ChatTurnReport,
      outcomes: ["ok"],
      session: "resume",
    }),
  },
});

/** Los roles de la plantilla por slug; son los body de las defs de kind `role`. */
export const roles: Record<string, Role> = {
  dev,
  "review-bugs": reviewer(prompts.REVIEW_BUGS, [pack("bug-rubric")]),
  "review-tests": reviewer(prompts.REVIEW_TESTS, [pack("test-rules")]),
  "review-patterns": reviewer(prompts.REVIEW_PATTERNS, []),
  "review-lore": reviewer(prompts.REVIEW_LORE, [pack("lore")]),
  committer,
  triage,
  "plan-check": planCheck,
  chat,
};

import * as z from "zod";

// Lo que cada rol de la plantilla pone en `Brief.payload` y `Report.payload` (`d2-plantilla`).
// El sobre genérico (summary, decisions, learnings) es el `Brief`/`Report` de `@clanker/api`.
//
// Los payloads de brief son sueltos: un flujo puede pasar claves que el rol no declara. Un campo
// que el flujo no siempre arma es opcional.

export const DevPlanReport = z.object({
  approach: z.string(),
  files: z.array(z.string()).describe("Archivos que vas a tocar."),
  tests: z.array(z.string()).describe("Tests que vas a escribir o ajustar."),
  mold: z.string().describe("Ruta de la funcionalidad parecida que usas de molde."),
  assumptions: z.array(z.string()),
  issueDoubts: z
    .array(
      z.object({
        says: z.string().describe("Lo que dice la issue."),
        why: z.string().describe("Por qué no calza con el repo."),
        evidence: z.string().describe("Ruta (con línea) que lo muestra."),
        alternative: z.string().describe("Tu alternativa más simple."),
      }),
    )
    .describe("Especificaciones de la issue que no hacen sentido. Vacío si no hay."),
});
export type DevPlanReport = z.infer<typeof DevPlanReport>;

export const DevWorkBrief = z.object({
  instructions: z
    .array(
      z.object({
        id: z.string(),
        path: z.string(),
        line: z.number().int().optional(),
        change: z.string(),
      }),
    )
    .optional(),
  failures: z.string().optional().describe("Extracto de fallas que filtró el core."),
});
export type DevWorkBrief = z.infer<typeof DevWorkBrief>;

export const DevWorkReport = z.object({
  files: z.array(z.string()),
  rejected: z
    .array(z.object({ id: z.string(), reason: z.string() }))
    .describe("Instrucciones que no aplicaste, con la razón."),
  deletedTests: z
    .array(z.object({ test: z.string(), now: z.string() }))
    .describe("Cada test borrado y dónde vive ahora lo que probaba, o por qué ya no aplica."),
  cuts: z
    .array(z.object({ behavior: z.string(), paths: z.array(z.string()) }))
    .describe("Un corte por razón de cambio, pista para el committer."),
});
export type DevWorkReport = z.infer<typeof DevWorkReport>;

export const ReviewFocus = z.enum(["bugs", "tests", "patterns", "lore"]);
export type ReviewFocus = z.infer<typeof ReviewFocus>;

export const Severity = z.enum(["red", "yellow", "white"]);
export type Severity = z.infer<typeof Severity>;

export const Finding = z.object({
  id: z.string().describe("Local al reporte (f1, f2...). El core le pone el id estable."),
  severity: Severity,
  path: z.string(),
  line: z.number().int(),
  claim: z.string().describe("El escenario concreto o la regla que se viola."),
  fix: z.string().describe("El cambio concreto."),
  rule: z.string().optional().describe('Id del patrón ("[2.3]") o sección de AGENTS.md.'),
  trivial: z.boolean().optional().describe("Solo un white: arreglarlo no suma código ni ramas."),
});
export type Finding = z.infer<typeof Finding>;

export const ReviewReport = z.object({
  findings: z.array(Finding).describe("Máximo 10, de mayor a menor severidad."),
  previous: z
    .array(z.object({ id: z.string(), status: z.enum(["fixed", "open"]) }))
    .describe("Estado de cada hallazgo del brief. Vacío en la primera ronda."),
});
export type ReviewReport = z.infer<typeof ReviewReport>;

/**
 * `focus` es opcional: el rol ya lo fija con su rúbrica, y los flujos no lo arman. `previous` es
 * una lista de hallazgos o el reporte anterior completo, que es lo que `$self` resuelve en un flujo;
 * en la primera visita `$self` no apunta a nada y llega `null`.
 */
export const ReviewBrief = z.object({
  focus: ReviewFocus.optional(),
  previous: z.union([z.array(Finding), ReviewReport]).nullish(),
});
export type ReviewBrief = z.infer<typeof ReviewBrief>;


export const CommitBrief = z.object({
  cuts: DevWorkReport.shape.cuts,
  notForThisPr: z.array(z.string()).optional().describe("Lo que la issue deja para otras issues."),
});
export type CommitBrief = z.infer<typeof CommitBrief>;

const PlannedCommit = z.object({
  message: z.string(),
  hunks: z.array(z.string()).describe("Ids de hunks.json."),
  tests: z.array(z.string()).describe("Tests que deben pasar en este commit."),
  whyAtomic: z.string().describe("Una frase: por qué no se puede dividir más."),
});

export const CommitPlan = z.object({
  commits: z.array(PlannedCommit),
  pr: z.object({ title: z.string(), body: z.string() }),
  notes: z.array(z.string()).describe("Para quien dirige el trabajo, no para quien revisa el PR."),
});
export type CommitPlan = z.infer<typeof CommitPlan>;

/** Extensión del diseño: el modo `route` decide los commits nuevos de hunks sin commit al que atarse. */
export const RouteBrief = z.object({ hunks: z.array(z.string()).describe("Ids de hunks.json.") });
export type RouteBrief = z.infer<typeof RouteBrief>;

export const CommitRoute = z.object({ commits: z.array(PlannedCommit) });
export type CommitRoute = z.infer<typeof CommitRoute>;

export const TriageBrief = z.object({
  items: z.array(
    z.object({
      id: z.string(),
      kind: z.enum(["bot", "coverage", "ci"]),
      path: z.string().optional(),
      line: z.number().int().optional(),
      text: z.string(),
      flaky: z.boolean().optional().describe("Un check de CI que el pack ya declara flaky conocido."),
    }),
  ),
});
export type TriageBrief = z.infer<typeof TriageBrief>;

export const TriageReport = z.object({
  items: z.array(
    z.object({
      id: z.string(),
      verdict: z.enum(["valid", "false_positive", "not_applicable", "other_pr", "flaky", "foreign"]),
      reply: z.string().optional().describe("La razón, en una frase, si el ítem no se arregla aquí."),
      fix: z.string().optional().describe("Solo un valid: el arreglo o el test concreto."),
      prRef: z.string().optional().describe("Solo other_pr: el PR al que corresponde."),
    }),
  ),
});
export type TriageReport = z.infer<typeof TriageReport>;

/** Extensión del diseño: el brief y el reporte de `plan-check`. */
export const PlanCheckBrief = z.object({ plan: DevPlanReport });
export type PlanCheckBrief = z.infer<typeof PlanCheckBrief>;

export const PlanCheckReport = z.object({
  doubts: z
    .array(
      z.object({
        says: z.string(),
        decision: z.enum(["issue", "alternative"]),
        why: z.string(),
      }),
    )
    .describe("Una entrada por cada issueDoubts del plan."),
  corrections: z.array(z.string()).describe("Ajustes concretos que el dev aplica al implementar."),
});
export type PlanCheckReport = z.infer<typeof PlanCheckReport>;

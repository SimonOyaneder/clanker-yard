import type { ArtifactHash, ChatProposal } from "@clanker/api";
import { asc, eq } from "drizzle-orm";
import type { Artifacts } from "../artifacts/artifacts";
import type { ChildReport } from "../github/actions/restack";
import { runs, stepRuns } from "../store/schema";
import type { Store } from "../store/store";

type Children = NonNullable<ChatProposal["result"]>["children"];

/** Lo que dejó una corrida de `chat-aplicar` (o `chat-aplicar-local`), leído de los outputs de sus pasos y los de su subflujo de restack. */
export interface ApplySummary {
  /** Los fixups quedaron en el PR. */
  applied: boolean;
  /** La propuesta no calzó porque el PR cambió (o ya no era la vigente). */
  stale: boolean;
  /** La punta del PR después de aplicar. */
  sha?: string;
  /** Los archivos de un conflicto. */
  conflict?: string[];
  /** Por qué terminó así, para el mensaje del chat. */
  note?: string;
  /** Los checks quedaron rojos tras las rondas del dev. */
  checksRed: boolean;
  children: Children;
}

export function applySummaryOf(store: Store, artifacts: Pick<Artifacts, "get">, runId: string): ApplySummary {
  const stepsOf = (id: string) => store.db.select().from(stepRuns).where(eq(stepRuns.runId, id as never)).orderBy(asc(stepRuns.visit)).all();
  const output = (hash: ArtifactHash | null): Record<string, unknown> | undefined => {
    if (!hash) return undefined;
    const artifact = artifacts.get(hash);
    return artifact ? (JSON.parse(new TextDecoder().decode(artifact.content)) as Record<string, unknown>) : undefined;
  };
  const steps = stepsOf(runId);
  const last = (node: string) => steps.filter((step) => step.nodeId === node).at(-1);
  const apply = last("apply");
  const applyOut = output(apply?.outputHash ?? null);
  const fixups = output(last("fixups")?.outputHash ?? null);
  const checks = last("checks");
  const children: Children = [];
  const restackRuns = store.db.select().from(runs).where(eq(runs.parentRunId, runId as never)).all();
  for (const child of restackRuns) {
    const restack = stepsOf(child.id).filter((step) => step.nodeId === "restack").at(-1);
    const reports = (output(restack?.outputHash ?? null)?.children ?? []) as ChildReport[];
    for (const report of reports) {
      if (report.status === "restacked") children.push({ prId: report.prId, status: "restacked", head: report.head });
      else if (report.status === "uptodate") children.push({ prId: report.prId, status: "uptodate" });
      else if (report.status === "conflict") children.push({ prId: report.prId, status: "conflict", files: report.files, failures: report.failures });
      else children.push({ prId: report.prId, status: "skipped", reason: report.reason });
    }
  }
  const stale = apply?.outcome === "stale";
  return {
    applied: fixups !== undefined,
    stale,
    ...(typeof fixups?.to === "string" && { sha: fixups.to }),
    ...(apply?.outcome === "conflict" && { conflict: (applyOut?.files as string[] | undefined) ?? [] }),
    ...(stale && typeof applyOut?.reason === "string" && { note: applyOut.reason }),
    checksRed: checks?.outcome === "fail" && fixups === undefined,
    children,
  };
}

/** El mensaje `system` que deja en el chat el fin de una corrida de aplicar. */
export function applyMessage(status: ChatProposal["status"], summary: ApplySummary, runStatus: string): string {
  if (status === "applied") {
    const lines = [`Apliqué la propuesta: el PR quedó en \`${(summary.sha ?? "").slice(0, 7)}\`.`];
    for (const child of summary.children) {
      if (child.status === "restacked") lines.push(`- ${child.prId}: restackeado sobre la punta nueva (\`${child.head.slice(0, 7)}\`).`);
      else if (child.status === "uptodate") lines.push(`- ${child.prId}: ya estaba al día.`);
      else if (child.status === "conflict") lines.push(`- ${child.prId}: quedó en conflicto en ${child.files.join(", ")}; el flujo de rebase por conflicto lo toma.`);
      else lines.push(`- ${child.prId}: no se restackeó (${child.reason}).`);
    }
    if (summary.note) lines.push("", summary.note);
    return lines.join("\n");
  }
  if (status === "stale") return `No apliqué la propuesta: ${summary.note ?? "el PR cambió desde que se hizo"}. Pídeme que la rehaga sobre el PR actual.`;
  if (summary.conflict) return `No apliqué la propuesta: chocó en ${summary.conflict.join(", ")}. El PR quedó como estaba.`;
  if (summary.checksRed) return "No apliqué la propuesta: los checks de la receta siguieron rojos después de que el dev intentó arreglarlos. El PR quedó como estaba.";
  return `No se pudo aplicar la propuesta (la corrida terminó ${runStatus})${summary.note ? `: ${summary.note}` : "."}`;
}

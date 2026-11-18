import * as z from "zod";
import { AgentRuntimeId, Effort } from "./agents";
import { AgentSessionId, ChatId, RunId } from "./domain";
import { LocalPrFile } from "./prs";

export { ChatId } from "./domain";

export const PrChat = z.object({
  id: ChatId,
  prId: z.string().min(1),
  status: z.enum(["active", "archived"]),
  runtime: AgentRuntimeId,
  model: z.string().min(1),
  effort: Effort.optional(),
  busy: z.boolean(),
  costMicros: z.int().nonnegative(),
  canApply: z.boolean(),
  applyReason: z.string().optional().describe("Por qué no se puede aplicar la propuesta cuando canApply es false."),
});
export type PrChat = z.infer<typeof PrChat>;

export const ChatMessage = z.object({
  id: z.string().min(1),
  role: z.enum(["user", "assistant", "system"]),
  text: z.string(),
  sessionId: AgentSessionId.optional(),
  proposalRev: z.int().positive().optional(),
  at: z.int().nonnegative(),
});
export type ChatMessage = z.infer<typeof ChatMessage>;

export const ChatProposal = z.object({
  rev: z.int().positive(),
  baseSha: z.string(),
  summary: z.string(),
  items: z.array(z.object({ id: z.string().min(1), change: z.string(), path: z.string().optional() })),
  files: z.array(LocalPrFile),
  status: z.enum(["draft", "applying", "applied", "discarded", "stale", "failed"]),
  runId: RunId.optional(),
  result: z.object({
    sha: z.string(),
    children: z.array(z.discriminatedUnion("status", [
      z.object({ prId: z.string().min(1), status: z.literal("restacked"), head: z.string() }),
      z.object({ prId: z.string().min(1), status: z.literal("uptodate") }),
      z.object({ prId: z.string().min(1), status: z.literal("conflict"), files: z.array(z.string()), failures: z.string() }),
      z.object({ prId: z.string().min(1), status: z.literal("skipped"), reason: z.string() }),
    ])),
  }).optional(),
});
export type ChatProposal = z.infer<typeof ChatProposal>;

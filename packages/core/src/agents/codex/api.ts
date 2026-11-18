export type JsonValue = number | string | boolean | JsonValue[] | { [key: string]: JsonValue | undefined } | null;

export interface RpcError {
  code: number;
  message: string;
  data?: JsonValue;
}

export type RpcMessage =
  | { id: number | string; method: string; params?: unknown }
  | { id?: never; method: string; params?: unknown }
  | { id: number | string; result: unknown; method?: never }
  | { id: number | string; error: RpcError; method?: never };

export type ReasoningEffort = "none" | "minimal" | "low" | "medium" | "high" | "xhigh";

export interface ThreadParams {
  cwd?: string | null;
  model?: string | null;
  approvalPolicy?: "never";
  sandbox?: "read-only" | "workspace-write" | "danger-full-access";
  config?: Record<string, JsonValue> | null;
  baseInstructions?: string | null;
  developerInstructions?: string | null;
  ephemeral?: boolean | null;
}

export interface Thread {
  id: string;
  cwd: string;
  turns: Turn[];
}

export interface TurnError {
  message: string;
  codexErrorInfo: string | { [key: string]: unknown } | null;
  additionalDetails: string | null;
}

export type ThreadItem =
  | { type: "agentMessage"; id: string; text: string }
  | { type: "commandExecution"; id: string; command: string; aggregatedOutput: string | null; exitCode: number | null; status: "inProgress" | "completed" | "failed" | "declined" }
  | { type: "reasoning"; id: string; summary: string[]; content: string[] }
  | { type: "fileChange"; id: string; changes: { path: string; kind: { type: "add" } | { type: "delete" } | { type: "update"; move_path: string | null }; diff: string }[]; status: "inProgress" | "completed" | "failed" | "declined" }
  | { type: "mcpToolCall"; id: string; server: string; tool: string; status: "inProgress" | "completed" | "failed"; arguments: JsonValue; result: { content: JsonValue[]; structuredContent: JsonValue | null; _meta: JsonValue | null } | null; error: { message: string } | null }
  | { type: "contextCompaction"; id: string };

export interface Turn {
  id: string;
  items: ThreadItem[];
  status: "completed" | "interrupted" | "failed" | "inProgress";
  error: TurnError | null;
}

export interface TokenUsageBreakdown {
  totalTokens: number;
  inputTokens: number;
  cachedInputTokens: number;
  cacheWriteInputTokens: number;
  outputTokens: number;
  reasoningOutputTokens: number;
}

export interface RateLimitSnapshot {
  limitId: string | null;
  limitName?: string | null;
  planType?: string | null;
  rateLimitReachedType?: string | null;
  primary: { usedPercent: number; windowDurationMins: number | null; resetsAt: number | null } | null;
  secondary: RateLimitSnapshot["primary"];
  credits: { hasCredits: boolean; unlimited: boolean; balance: string | null } | null;
  spendControlReached: boolean | null;
}

export interface CodexMethods {
  initialize: {
    params: { clientInfo: { name: string; title: string | null; version: string } };
    result: { userAgent: string };
  };
  "account/read": {
    params: { refreshToken?: boolean };
    result: { account: { type: "chatgpt"; email: string | null; planType: string; workspaceName: string | null } | { type: "apiKey" } | { type: "amazonBedrock"; usesCodexManagedCredentials: boolean } | { type: "gcp" } | null; requiresOpenaiAuth: boolean };
  };
  "account/rateLimits/read": {
    params: { excludeResetCreditDetails?: boolean };
    result: { ordinaryUsageAllowed: boolean | null; rateLimits: RateLimitSnapshot; rateLimitsByLimitId: Record<string, RateLimitSnapshot> | null };
  };
  "model/list": {
    params: { cursor?: string | null; limit?: number | null };
    result: { data: { id: string; model: string; displayName: string; supportedReasoningEfforts: { reasoningEffort: ReasoningEffort; description: string }[]; defaultReasoningEffort: ReasoningEffort; isDefault: boolean }[]; nextCursor: string | null };
  };
  "config/read": {
    params: { cwd?: string | null; includeLayers?: boolean };
    result: { config: Record<string, JsonValue> };
  };
  "mcpServerStatus/list": {
    params: { threadId?: string; cursor?: string | null };
    result: { data: { name: string; runtimeStatus: "notStarted" | "starting" | "connected" | "authenticationRequired" | "failed" | "cancelled" | "disabled" | null }[]; nextCursor: string | null };
  };
  "thread/read": { params: { threadId: string }; result: { thread: Thread } };
  "thread/start": { params: ThreadParams; result: { thread: Thread; instructionSources: string[] } };
  "thread/resume": { params: Omit<ThreadParams, "ephemeral"> & { threadId: string }; result: { thread: Thread } };
  "turn/start": {
    params: { threadId: string; input: { type: "text"; text: string; text_elements?: JsonValue[] }[]; effort?: ReasoningEffort | null; outputSchema?: JsonValue };
    result: { turn: Turn };
  };
  "turn/interrupt": { params: { threadId: string; turnId: string }; result: Record<string, never> };
}

export type ModelInfo = CodexMethods["model/list"]["result"]["data"][number];

export type CodexNotification =
  | { method: "item/started" | "item/completed"; params: { threadId: string; turnId: string; item: ThreadItem } }
  | { method: "item/agentMessage/delta"; params: { threadId: string; turnId: string; itemId: string; delta: string } }
  | { method: "item/reasoning/summaryTextDelta"; params: { threadId: string; turnId: string; itemId: string; delta: string; summaryIndex: number } }
  | { method: "item/reasoning/textDelta"; params: { threadId: string; turnId: string; itemId: string; delta: string; contentIndex: number } }
  | { method: "item/reasoning/summaryPartAdded"; params: { threadId: string; turnId: string; itemId: string; summaryIndex: number } }
  | { method: "item/commandExecution/outputDelta" | "item/fileChange/outputDelta"; params: { threadId: string; turnId: string; itemId: string; delta: string } }
  | { method: "thread/tokenUsage/updated"; params: { threadId: string; turnId: string; tokenUsage: { total: TokenUsageBreakdown; last: TokenUsageBreakdown; modelContextWindow: number | null } } }
  | { method: "account/rateLimits/updated"; params: { rateLimits: RateLimitSnapshot } }
  | { method: "turn/started" | "turn/completed"; params: { threadId: string; turn: Turn } }
  | { method: "error"; params: { threadId: string; turnId: string; error: TurnError; willRetry: boolean } };

/**
 * Shared TypeScript types for Zoc AI.
 *
 * AUTO-GENERATED from Python Pydantic models.
 * DO NOT EDIT MANUALLY - changes will be overwritten.
 *
 * To regenerate: pnpm schema:generate
 * Source: packages/shared-types/python/shared_schema/message_parts.py
 */

// Type aliases
export type UUID = string;
export type ISODateTime = string;

// ── Enums ─────────────────────────────────────────────────────────────

export type Capability =
  | "read"
  | "write"
  | "execute";

export type ConversationMode =
  | "ask"
  | "plan"
  | "agent";

export type HunkAction =
  | "create"
  | "modify"
  | "delete"
  | "rename";

export type PartType =
  | "text"
  | "reasoning"
  | "tool-input"
  | "tool-output"
  | "tool-error"
  | "plan"
  | "diff"
  | "permission-request"
  | "run-lifecycle"
  | "usage"
  | "error"
  | "source"
  | "compaction";

export type PermissionDecision =
  | "approve"
  | "reject"
  | "timeout";

export type PermissionScope =
  | "call"
  | "run"
  | "workspace";

export type RunState =
  | "queued"
  | "running"
  | "awaiting-approval"
  | "completed"
  | "cancelled"
  | "failed"
  | "interrupted";

export type SourceKind =
  | "url"
  | "document";

export type ToolKind =
  | "read"
  | "write"
  | "execute"
  | "search"
  | "network"
  | "mcp";

// ── Interfaces ────────────────────────────────────────────────────────

export interface Citation {
  sourceId: string;
  partId: string;
  start: number;
  end: number;
  quote: string;
}

export interface CompactionPart extends PartBase {
  type: "compaction";
  compactionId: string;
  foldedMessageIds: string[];
  foldedTurnCount: number;
  contextTokensBefore: number;
  contextTokensAfter: number;
  summary: string;
}

export interface DiffPart extends PartBase {
  type: "diff";
  planId: string;
  path: string;
  action: "create" | "modify" | "delete" | "rename";
  sourcePath?: string | null;
  language?: string | null;
  hunks: Hunk[];
  baseDigest: string;
  stale: boolean;
}

export interface ErrorPart extends PartBase {
  type: "error";
  code: string;
  message: string;
  details?: string | null;
  retryable: boolean;
}

export interface Hunk {
  hunkId: string;
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
  patch: string;
}

export interface PartBase {
  seq: number;
  runId: string;
  messageId: string;
  ts: string;
  agentName?: string | null;
}

export interface PermissionRequestPart extends PartBase {
  type: "permission-request";
  requestId: string;
  toolCallId: string;
  toolName: string;
  kind: "read" | "write" | "execute" | "search" | "network" | "mcp";
  prompt: string;
  paths: string[];
  reason: "mode-ask" | "out-of-plan-path" | "destructive";
  offeredScopes: ("call" | "run" | "workspace")[];
  expiresAt: string;
  decision?: "approve" | "reject" | "timeout" | null;
  decidedScope?: "call" | "run" | "workspace" | null;
}

export interface PlanFile {
  path: string;
  action: "create" | "modify" | "delete" | "rename";
  sourcePath?: string | null;
  rationale: string;
  addedLines: number;
  removedLines: number;
  hunkCount: number;
}

export interface PlanPart extends PartBase {
  type: "plan";
  planId: string;
  title: string;
  files: PlanFile[];
  verificationCommand?: string | null;
}

export interface ReasoningPart extends PartBase {
  type: "reasoning";
  partId: string;
  delta: string;
  elapsedMs: number;
  done: boolean;
  redacted: boolean;
}

export interface RunLifecyclePart extends PartBase {
  type: "run-lifecycle";
  state: "queued" | "running" | "awaiting-approval" | "completed" | "cancelled" | "failed" | "interrupted";
  queuePosition?: number | null;
  code?: string | null;
  message?: string | null;
  provider?: string | null;
  model?: string | null;
}

export interface SourcePart extends PartBase {
  type: "source";
  sources: VisitedSource[];
  citations: Citation[];
  toolName?: string | null;
}

export interface TextPart extends PartBase {
  type: "text";
  partId: string;
  delta: string;
  done: boolean;
}

export interface ToolErrorPart extends PartBase {
  type: "tool-error";
  toolCallId: string;
  durationMs: number;
  code: string;
  message: string;
  details?: string | null;
  retryable: boolean;
}

export interface ToolInputPart extends PartBase {
  type: "tool-input";
  toolCallId: string;
  toolName: string;
  kind: "read" | "write" | "execute" | "search" | "network" | "mcp";
  mcpServer?: string | null;
  inputDelta: string;
  done: boolean;
}

export interface ToolOutputPart extends PartBase {
  type: "tool-output";
  toolCallId: string;
  durationMs: number;
  summary: string;
  output: string;
  readPaths: string[];
  writtenPaths: string[];
  truncated: boolean;
}

export interface UsagePart extends PartBase {
  type: "usage";
  inputTokens: number;
  outputTokens: number;
  reasoningTokens: number;
  cachedInputTokens: number;
  contextLimit: number;
  estimatedCostCents?: number | null;
  tokensPerSecond?: number | null;
  messagesInContext: number;
  sessionMessageCount: number;
  messagesOutOfWindow: number;
  summaryActive: boolean;
}

export interface VisitedSource {
  sourceId: string;
  kind: "url" | "document";
  url?: string | null;
  title?: string | null;
  mediaType?: string | null;
}

// ── Union Types ───────────────────────────────────────────────────────

export type MessagePart =
  | TextPart
  | ReasoningPart
  | ToolInputPart
  | ToolOutputPart
  | ToolErrorPart
  | PlanPart
  | DiffPart
  | PermissionRequestPart
  | RunLifecyclePart
  | UsagePart
  | ErrorPart
  | SourcePart
  | CompactionPart;

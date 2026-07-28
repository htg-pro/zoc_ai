/**
 * Shared TypeScript types for Zoc AI.
 *
 * AUTO-GENERATED from Python Pydantic models.
 * DO NOT EDIT MANUALLY - changes will be overwritten.
 *
 * To regenerate: pnpm schema:generate
 * Source: packages/shared-types/python/shared_schema/agent_events.py
 */

// Type aliases
export type UUID = string;
export type ISODateTime = string;

// ── Enums ─────────────────────────────────────────────────────────────

export type EventType =
  | "intent"
  | "thinking"
  | "plan"
  | "plan-update"
  | "plan-ready"
  | "map-files"
  | "read-files"
  | "edit-file"
  | "command"
  | "review"
  | "stage"
  | "summary"
  | "approval"
  | "done";

export type ModelTier =
  | "local-slm"
  | "edge"
  | "cloud";

export type PermissionEffect =
  | "allow"
  | "deny"
  | "prompt";

export type PermissionKind =
  | "agent_tool"
  | "terminal"
  | "task"
  | "git"
  | "mcp"
  | "plugin"
  | "fs";

export type PlanItemStatus =
  | "pending"
  | "active"
  | "done";

export type ReportedStage =
  | "analyze"
  | "plan"
  | "edit"
  | "check"
  | "review"
  | "summary";

export type ReviewCheckStatus =
  | "pass"
  | "fail"
  | "skipped"
  | "running";

export type StageState =
  | "pending"
  | "active"
  | "succeeded"
  | "failed"
  | "skipped";

// ── Interfaces ────────────────────────────────────────────────────────

export interface ApprovalEvent extends BaseEvent {
  type: "approval";
  prompt: string;
  operation?: string | null;
  decision?: "approve" | "reject" | null;
}

export interface BaseEvent {
  seq: number;
  runId: string;
  ts: string;
}

export interface BudgetEvent extends BaseEvent {
  type: "budget";
  tokensUsed: number;
  tokenLimit: number;
  iterations: number;
  recoveries: number;
}

export interface CommandEvent extends BaseEvent {
  type: "command";
  command: string;
  commandId?: string | null;
  mcpServerId?: string | null;
  status?: "queued" | "running" | "pass" | "fail" | "skipped" | null;
  exitCode?: number | null;
  errorTag?: string | null;
  outputDelta?: string | null;
  outputTail?: string | null;
}

export interface ContextCompressedEvent extends BaseEvent {
  type: "context-compressed";
  originalTokens: number;
  compressedTokens: number;
  compressionRatio: number;
}

export interface DoneEvent extends BaseEvent {
  type: "done";
  ok: boolean;
  reason?: string | null;
  filesChanged: number;
}

export interface EditFileEvent extends BaseEvent {
  type: "edit-file";
  path: string;
  diff: string;
  adds: number;
  dels: number;
  status: "running" | "done" | "failed";
  baseHash?: string | null;
}

export interface IntentEvent extends BaseEvent {
  type: "intent";
  text: string;
  modelTier: "local-slm" | "edge" | "cloud";
  contextWindowTokens: number;
  fallbackReason?: string | null;
}

export interface MapFilesEvent extends BaseEvent {
  type: "map-files";
  readList: string[];
  writeList: string[];
  rationale: string;
}

export interface PermissionEvent extends BaseEvent {
  type: "permission";
  kind: "agent_tool" | "terminal" | "task" | "git" | "mcp" | "plugin" | "fs";
  name: string;
  target?: string | null;
  effect: "allow" | "deny" | "prompt";
  reason: string;
}

export interface PlanEvent extends BaseEvent {
  type: "plan";
  items: PlanItem[];
  checkpointId?: string | null;
}

export interface PlanItem {
  id: string;
  label: string;
  status: "pending" | "active" | "done";
}

export interface PlanReadyEvent extends BaseEvent {
  type: "plan-ready";
  steps: PlanReadyStep[];
  verificationCommand?: string | null;
  confidence: number;
  fileCount: number;
}

export interface PlanReadyStep {
  file: string;
  action: "create" | "modify" | "delete" | "rename";
  rationale: string;
  diff?: string | null;
}

export interface PlanUpdateEvent extends BaseEvent {
  type: "plan-update";
  id: string;
  status: "pending" | "active" | "done";
}

export interface ReadFileRef {
  path: string;
  span?: [number, number] | null;
}

export interface ReadFilesEvent extends BaseEvent {
  type: "read-files";
  files: ReadFileRef[];
}

export interface RecoveryAttemptEvent extends BaseEvent {
  type: "recovery-attempt";
  attempt: number;
  failures: string[];
}

export interface ReviewCheck {
  status: "pass" | "fail" | "skipped" | "running";
  output?: string | null;
}

export interface ReviewEvent extends BaseEvent {
  type: "review";
  files: ReviewFile[];
  validation: ReviewValidation;
  checkpointId?: string | null;
}

export interface ReviewFile {
  path: string;
  diff: string;
  adds: number;
  dels: number;
  summary?: string | null;
  baseHash?: string | null;
}

export interface ReviewValidation {
  typecheck: ReviewCheck;
  build: ReviewCheck;
  tests: ReviewCheck;
}

export interface StageEvent extends BaseEvent {
  type: "stage";
  stage: "analyze" | "plan" | "edit" | "check" | "review" | "summary";
  state: "pending" | "active" | "succeeded" | "failed" | "skipped";
  reason?: string | null;
}

export interface SummaryEvent extends BaseEvent {
  type: "summary";
  text: string;
}

export interface TestResultsEvent extends BaseEvent {
  type: "test-results";
  status: "pass" | "fail";
  command: string;
  source: string;
  passed: number;
  failed: number;
  exitCode: number;
  outputTail: string;
  durationMs: number;
  timedOut: boolean;
}

export interface ThinkingEvent extends BaseEvent {
  type: "thinking";
  text: string;
  collapsible: true;
  gist?: string | null;
  elapsedMs?: number | null;
  truncated: boolean;
}

// ── Union Types ───────────────────────────────────────────────────────

export type AgentEvent =
  | IntentEvent
  | ThinkingEvent
  | PlanEvent
  | PlanUpdateEvent
  | PlanReadyEvent
  | MapFilesEvent
  | ReadFilesEvent
  | ContextCompressedEvent
  | EditFileEvent
  | CommandEvent
  | ReviewEvent
  | StageEvent
  | SummaryEvent
  | ApprovalEvent
  | PermissionEvent
  | RecoveryAttemptEvent
  | BudgetEvent
  | TestResultsEvent
  | DoneEvent;

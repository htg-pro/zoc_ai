/**
 * Shared TypeScript types for Zoc AI.
 *
 * AUTO-GENERATED from Python Pydantic models.
 * DO NOT EDIT MANUALLY - changes will be overwritten.
 *
 * To regenerate: pnpm schema:generate
 * Source: packages/shared-types/python/shared_schema/models.py
 */

// Type aliases
export type UUID = string;
export type ISODateTime = string;

// ── Enums ─────────────────────────────────────────────────────────────

export type EmbeddingProvider =
  | "auto"
  | "openai"
  | "llamacpp"
  | "hash";

export type FindingSeverity =
  | "info"
  | "low"
  | "medium"
  | "high"
  | "critical";

export type MessageRole =
  | "user"
  | "assistant"
  | "system"
  | "tool";

export type PermissionScope =
  | "read_fs"
  | "write_fs"
  | "run_command"
  | "network";

export type PlanStepStatus =
  | "pending"
  | "running"
  | "done"
  | "failed"
  | "repairing"
  | "skipped";

export type ProviderKind =
  | "llamacpp"
  | "openai"
  | "anthropic"
  | "gemini"
  | "mock";

export type SessionStatus =
  | "active"
  | "idle"
  | "closed";

export type SlashCommandName =
  | "review"
  | "test"
  | "explain"
  | "fix"
  | "refactor"
  | "docs"
  | "grok";

export type TerminalSessionStatus =
  | "running"
  | "exited";

export type TodoStatus =
  | "pending"
  | "in_progress"
  | "completed";

export type ToolCallStatus =
  | "pending"
  | "running"
  | "succeeded"
  | "failed"
  | "cancelled"
  | "needs_approval";

// ── Interfaces ────────────────────────────────────────────────────────

export interface AgentEventBase {
  session_id: string;
  seq: number;
  at: string;
  run_id?: string | null;
}

export interface AgentLifecycleEvent extends AgentEventBase {
  type: "agent.started" | "agent.context.loading" | "agent.context.ready" | "agent.completed" | "agent.error";
  message?: string | null;
  detail?: string | null;
}

export interface CheckpointCreatedEvent extends AgentEventBase {
  type: "checkpoint.created";
  run_id?: string | null;
  checkpoint_id: string;
  label?: string | null;
}

export interface CheckpointInfo {
  run_id: string;
  label: string;
  created_at: string;
  files: string[];
}

export interface CodeReviewFinding {
  file: string;
  line: number;
  severity: FindingSeverity;
  message: string;
  suggestion?: string | null;
  patch?: DiffPatch | null;
}

export interface CodeReviewReport {
  findings: CodeReviewFinding[];
  summary?: string | null;
}

export interface ContextCandidate {
  kind: "file" | "folder" | "symbol";
  label: string;
  path: string;
  detail?: string | null;
  line?: number | null;
}

export interface ContextStatus extends MemoryStats {
  model: string;
  recommended_model?: string | null;
  can_continue: boolean;
  compaction_available: boolean;
  usage_percent: number;
}

export interface CreateSessionRequest {
  title: string;
  workspace_root: string;
  provider?: string | null;
  model?: string | null;
}

export interface DiffEvent extends AgentEventBase {
  type: "diff";
  patch: DiffPatch;
}

export interface DiffPatch {
  id: string;
  file_path: string;
  unified_diff: string;
  summary?: string | null;
}

export interface DiffReadyEvent extends AgentEventBase {
  type: "diff.ready";
  run_id?: string | null;
  patches: DiffPatch[];
  validation: Record<string, string>;
}

export interface DoneEvent extends AgentEventBase {
  type: "done";
  ok: boolean;
  summary?: string | null;
}

export interface EmbedderInfo {
  kind: string;
  model?: string | null;
  dim: number;
  is_fallback: boolean;
}

export interface EmbeddingSettings {
  provider: EmbeddingProvider;
  model?: string | null;
}

export interface ErrorEvent extends AgentEventBase {
  type: "error";
  message: string;
  detail?: string | null;
}

export interface HealthResponse {
  status: string;
  version: string;
}

export interface IndexChunk {
  id: string;
  file: string;
  start_line: number;
  end_line: number;
  symbol?: string | null;
  text: string;
}

export interface IndexConfig {
  workspace_root: string;
  exclude_globs: string[];
  watch: boolean;
}

export interface IndexQueryResult {
  chunk: IndexChunk;
  score: number;
}

export interface IndexStatus {
  workspace_root: string;
  file_count: number;
  chunk_count: number;
  last_indexed_at?: string | null;
  watching: boolean;
  embedder?: EmbedderInfo | null;
}

export interface InlineEditResult {
  edited: string;
}

export interface LogEvent extends AgentEventBase {
  type: "log";
  level: "debug" | "info" | "warning" | "error";
  message: string;
}

export interface MemoryStats {
  context_window: number;
  tokens_used: number;
  tokens_available: number;
  messages_in_context: number;
  total_messages: number;
  dropped_messages: number;
  has_summary: boolean;
}

export interface Message {
  id: string;
  role: MessageRole;
  content: string;
  name?: string | null;
  tool_call_id?: string | null;
  created_at: string;
}

export interface MessageDeltaEvent extends AgentEventBase {
  type: "message.delta";
  delta: string;
  message_id?: string | null;
}

export interface MessageEvent extends AgentEventBase {
  type: "message";
  message: Message;
}

export interface ModelCapability {
  context_window: number;
  supports_tools: boolean;
  supports_vision: boolean;
  supports_streaming: boolean;
  supports_embeddings: boolean;
}

export interface ModelDescriptor {
  provider: ProviderKind;
  model_id: string;
  display_name: string;
  capability: ModelCapability;
}

export interface OpenFileContext {
  path: string;
  name?: string | null;
  language?: string | null;
  content?: string | null;
  dirty: boolean;
}

export interface PermissionGrant {
  scope: PermissionScope;
  granted: boolean;
  note?: string | null;
}

export interface Plan {
  id: string;
  goal: string;
  steps: PlanStep[];
  created_at: string;
}

export interface PlanCreatedEvent extends AgentEventBase {
  type: "plan.created";
  plan: Plan;
}

export interface PlanEvent extends AgentEventBase {
  type: "plan";
  plan: Plan;
}

export interface PlanStep {
  id: string;
  title: string;
  detail?: string | null;
  status: PlanStepStatus;
  attempt: number;
  error?: string | null;
  done: boolean;
}

export interface PlanStepEvent extends AgentEventBase {
  type: "plan_step";
  step: PlanStep;
}

export interface PostMessageRequest {
  content: string;
  role: MessageRole;
}

export interface ProjectRulesInfo {
  active: boolean;
  sources: string[];
  rules: string;
}

export interface ProviderDescriptor {
  kind: ProviderKind;
  display_name: string;
  base_url?: string | null;
  requires_api_key: boolean;
  models: ModelDescriptor[];
}

export interface RunAgentRequest {
  prompt?: string | null;
  message?: string | null;
  /**
   * Client-supplied run id (R1.2, R1.7). When set, the backend reuses it as
   * the run's authoritative id and echoes it on every emitted event, so the
   * frontend can bind the run to the message it answers and discard events
   * from a superseded run. When absent the backend mints one. Sent as `runId`
   * (the backend model aliases `run_id` ⇄ `runId`).
   */
  runId?: string | null;
  sessionId?: string | null;
  workspacePath?: string | null;
  activeFile?: string | null;
  openFiles?: OpenFileContext[];
  selectedText?: string | null;
  editorContent?: string | null;
  mode: string | null;
  model?: string | null;
  provider?: string | null;
  apiKey?: string | null;
  baseUrl?: string | null;
  reviewChanges?: boolean;
  maxIterations?: number;
  maxRepairAttempts?: number;
}

export interface RunLifecycleEvent extends AgentEventBase {
  type: "run.started" | "run.context_ready" | "run.awaiting_review" | "run.applied" | "run.discarded" | "run.error";
  run_id?: string | null;
  mode?: string | null;
  message?: string | null;
  detail?: string | null;
  changed_files?: number | null;
}

export interface RunSlashCommandRequest {
  name: SlashCommandName;
  args: Record<string, unknown>;
}

export interface Session {
  id: string;
  title: string;
  status: SessionStatus;
  workspace_root: string;
  provider?: string | null;
  model?: string | null;
  created_at: string;
  updated_at: string;
  messages: Message[];
  plan?: Plan | null;
  tool_calls: ToolCall[];
}

export interface SettingsSnapshot {
  embedding: EmbeddingSettings;
}

export interface SlashCommandDescriptor {
  name: SlashCommandName;
  summary: string;
  args_schema: Record<string, unknown>;
}

export interface TerminalSession {
  id: string;
  cmd: string;
  args: string[];
  cwd?: string | null;
  status: TerminalSessionStatus;
  exit_code?: number | null;
  created_at: string;
}

export interface TestGenerationResult {
  framework: string;
  target: string;
  test_file: string;
  test_source: string;
  passed: boolean;
  attempts: number;
  last_output?: string | null;
}

export interface TestLifecycleEvent extends AgentEventBase {
  type: "test.started" | "test.completed";
  name: string;
  command?: string | null;
  ok?: boolean | null;
  output?: string | null;
}

export interface TodoItem {
  id: string;
  content: string;
  status: TodoStatus;
}

export interface TodoUpdateEvent extends AgentEventBase {
  type: "todo_update";
  todos: TodoItem[];
}

export interface TokenEvent extends AgentEventBase {
  type: "token";
  delta: string;
}

export interface ToolCall {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
  status: ToolCallStatus;
  result?: unknown | null;
  error?: string | null;
  started_at?: string | null;
  finished_at?: string | null;
}

export interface ToolCallEvent extends AgentEventBase {
  type: "tool_call";
  tool_call: ToolCall;
}

export interface ToolCompletedEvent extends AgentEventBase {
  type: "tool.completed";
  tool_call: ToolCall;
}

export interface ToolDescriptor {
  name: string;
  description: string;
  json_schema: Record<string, unknown>;
  destructive: boolean;
  requires_approval: boolean;
  requires_scopes: PermissionScope[];
}

export interface ToolGrant {
  tool: string;
  granted: boolean;
  once: boolean;
  note?: string | null;
}

export interface ToolResult {
  ok: boolean;
  data?: unknown | null;
  error?: string | null;
}

export interface ToolStartedEvent extends AgentEventBase {
  type: "tool.started";
  tool_call: ToolCall;
}

export interface UpdateIndexConfigRequest {
  workspace_root?: string | null;
  exclude_globs?: string[] | null;
  watch?: boolean | null;
}

export interface UpdateSettingsRequest {
  embedding?: EmbeddingSettings | null;
}

// ── Event_Contract (single source of truth for SSE events) ─────────────
//
// The new ecosystem SSE Event_Contract lives in `agent-events.ts` and is the
// Single_Source_Of_Truth for the eight typed SSE rows (R6.2, R6.6). It is
// re-exported here under the `AgentEvents` namespace so consumers import a
// single surface: `import { AgentEvents } from "@zoc-studio/shared-types"`
// then reference `AgentEvents.AgentEvent`, `AgentEvents.EventType`,
// `AgentEvents.IntentEvent`, etc. The namespace keeps the new contract's
// `AgentEvent`/`DoneEvent` distinct from the legacy run/tool-call types below,
// which surviving editor-support UI still imports until separately retired.
export * as AgentEvents from "./agent-events";

// ── Union Types ───────────────────────────────────────────────────────

export type AgentEvent =
  | AgentLifecycleEvent
  | MessageDeltaEvent
  | TokenEvent
  | MessageEvent
  | PlanCreatedEvent
  | PlanEvent
  | PlanStepEvent
  | ToolStartedEvent
  | ToolCompletedEvent
  | ToolCallEvent
  | TodoUpdateEvent
  | RunLifecycleEvent
  | CheckpointCreatedEvent
  | DiffReadyEvent
  | TestLifecycleEvent
  | DiffEvent
  | LogEvent
  | ErrorEvent
  | DoneEvent;

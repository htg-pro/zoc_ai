/**
 * Zoc AI Ecosystem — Shared Event_Contract (single source of truth).
 *
 * Defines the eight flat row kinds streamed over the SSE bus (R6.3). The TS
 * frontend and the generated Python Pydantic models mirror this contract so
 * the two sides cannot drift.
 *
 * Spec: .kiro/specs/zocai-ecosystem-rebuild/design.md
 *       — "Shared Event Schema (packages/shared-types)"
 * Requirements: 6.3 (plus allocator fields R1.6, R1.9 on IntentEvent).
 */

/** The eight row kinds. Exactly one per event type. */
export type EventType =
  | "intent"
  | "thinking"
  | "read-files"
  | "edit-file"
  | "command"
  | "summary"
  | "approval"
  | "done";

/** The model tier selected by the Allocator (R1.9). */
export type ModelTier = "local-slm" | "edge" | "cloud";

/** Fields common to every event. `seq` is monotonic and defines order (R6.5). */
export interface BaseEvent {
  type: EventType;
  seq: number; // monotonically increasing, defines order (R6.5)
  runId: string;
  ts: string; // ISO-8601
}

export interface IntentEvent extends BaseEvent {
  type: "intent";
  text: string;
  modelTier: ModelTier; // R1.9
  contextWindowTokens: number; // R1.9
  fallbackReason?: string; // R1.6
}

export interface ThinkingEvent extends BaseEvent {
  type: "thinking";
  text: string;
  collapsible: true; // R3.6
}

export interface ReadFilesEvent extends BaseEvent {
  type: "read-files";
  files: { path: string; span?: [number, number] }[];
}

export interface EditFileEvent extends BaseEvent {
  type: "edit-file";
  path: string;
  diff: string;
}

export interface CommandEvent extends BaseEvent {
  type: "command";
  command: string;
  exitCode?: number;
  errorTag?: string;
}

export interface SummaryEvent extends BaseEvent {
  type: "summary";
  text: string;
}

export interface ApprovalEvent extends BaseEvent {
  type: "approval";
  prompt: string;
  decision?: "approve" | "reject";
}

export interface DoneEvent extends BaseEvent {
  type: "done";
  ok: boolean;
  reason?: string;
}

/** Discriminated union of all eight row kinds. */
export type AgentEvent =
  | IntentEvent
  | ThinkingEvent
  | ReadFilesEvent
  | EditFileEvent
  | CommandEvent
  | SummaryEvent
  | ApprovalEvent
  | DoneEvent;

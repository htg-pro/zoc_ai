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
  | "read-files"
  | "edit-file"
  | "command"
  | "summary"
  | "approval"
  | "done";

export type ModelTier =
  | "local-slm"
  | "edge"
  | "cloud";

// ── Interfaces ────────────────────────────────────────────────────────

export interface ApprovalEvent extends BaseEvent {
  type: "approval";
  prompt: string;
  decision?: "approve" | "reject" | null;
}

export interface BaseEvent {
  seq: number;
  runId: string;
  ts: string;
}

export interface CommandEvent extends BaseEvent {
  type: "command";
  command: string;
  exitCode?: number | null;
  errorTag?: string | null;
}

export interface DoneEvent extends BaseEvent {
  type: "done";
  ok: boolean;
  reason?: string | null;
}

export interface EditFileEvent extends BaseEvent {
  type: "edit-file";
  path: string;
  diff: string;
}

export interface IntentEvent extends BaseEvent {
  type: "intent";
  text: string;
  modelTier: "local-slm" | "edge" | "cloud";
  contextWindowTokens: number;
  fallbackReason?: string | null;
}

export interface ReadFileRef {
  path: string;
  span?: [number, number] | null;
}

export interface ReadFilesEvent extends BaseEvent {
  type: "read-files";
  files: ReadFileRef[];
}

export interface SummaryEvent extends BaseEvent {
  type: "summary";
  text: string;
}

export interface ThinkingEvent extends BaseEvent {
  type: "thinking";
  text: string;
  collapsible: true;
}

// ── Union Types ───────────────────────────────────────────────────────

export type AgentEvent =
  | IntentEvent
  | ThinkingEvent
  | ReadFilesEvent
  | EditFileEvent
  | CommandEvent
  | SummaryEvent
  | ApprovalEvent
  | DoneEvent;

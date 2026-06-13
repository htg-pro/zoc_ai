import { create } from "zustand";
import type {
  AgentEvent,
  CodeReviewReport,
  ContextStatus,
  CreateReplitTaskRequest,
  ReplitCheckpoint,
  ReplitPlan,
  ReplitTask,
  ReplitTaskLog,
  DiffPatch,
  MemoryStats,
  Message,
  PermissionGrant,
  PermissionScope,
  Plan,
  PlanStep,
  RunAgentRequest,
  Session,
  SlashCommandName,
  TestGenerationResult,
  TodoItem,
  ToolCall,
  ToolDescriptor,
  ToolGrant,
} from "@llama-studio/shared-types";

import type { AgentClient, CodeReviewRequest, TestGenRequest } from "./agent-client";
import { getAgentClient } from "./agent-client";
import { getProvider } from "./providers";
import { secureStore } from "./secure-store";
import { fsWriteText } from "./tauri-bridge";
import {
  MOCK_FILE_CONTENT,
  MOCK_FILE_STATUS,
  MOCK_PINNED_SESSION_IDS,
  MOCK_SESSIONS,
} from "./mock-data";
import {
  applyPatch as tauriApplyPatch,
  desktopConfigGet,
  fsReadText,
  isTauri,
  llamacppLoad,
  llamacppStatus,
  onLlamaCppStatus,
  setWorkspaceRoot as tauriSetWorkspaceRoot,
  type LlamaCppStatus,
} from "./tauri-bridge";
import {
  DEFAULT_N_GPU_LAYERS,
  DEFAULT_TEMPERATURE,
  DEFAULT_TOP_P,
  DEFAULT_TOP_K,
  DEFAULT_REPEAT_PENALTY,
  DEFAULT_MAX_TOKENS,
  loadLocalModels,
} from "./local-models";
import { track } from "./telemetry";
import type { AutonomyLevel } from "./run-machine";

export type AgentMode = "ask" | "agent";

export type ActivityView = "files" | "search" | "indexer" | "sessions" | "tasks" | "settings";export type MainView = "editor" | "diff" | "sessions" | "tasks" | "settings" | "showcase";
export type BottomTab = "terminal" | "problems" | "logs";

export interface OpenFile {
  path: string;
  name: string;
  language: string;
  content: string;
  dirty: boolean;
}

export interface LayoutState {
  sidePanelOpen: boolean;
  rightPanelOpen: boolean;
  bottomDockOpen: boolean;
  sidePanelSize: number;
  rightPanelSize: number;
  bottomDockSize: number;
}

export interface ChatEntry {
  kind: "message" | "tool_call" | "diff" | "plan_update";
  id: string;
  message?: Message;
  toolCall?: ToolCall;
  diff?: DiffPatch;
}

export interface PermissionRequest {
  id: string;
  toolCall: ToolCall;
  title: string;
  summary: string;
}

export interface AgentTestRun {
  id: string;
  name: string;
  command?: string | null;
  status: "running" | "passed" | "failed";
  output?: string | null;
  result?: TestGenerationResult | null;
}

export type AgentWorkflowItem =
  | { type: "user_message"; id: string; text: string; createdAt: string }
  | { type: "agent_message"; id: string; text: string; streaming?: boolean; createdAt: string }
  | { type: "clarification"; id: string; question: string; options?: string[]; createdAt: string }
  | {
      type: "workspace_analysis";
      id: string;
      summary: string;
      files: string[];
      issues: string[];
      nextSteps: string[];
      status?: "loading" | "ready";
      createdAt: string;
    }
  | {
      type: "plan";
      id: string;
      plan: Plan | ReplitPlan;
      status: "pending" | "approved" | "cancelled";
      createdAt: string;
    }
  | { type: "task"; id: string; task: ReplitTask; createdAt: string }
  | { type: "todos"; id: string; todos: TodoItem[]; createdAt: string }
  | { type: "tool"; id: string; toolCall: ToolCall; createdAt: string }
  | { type: "permission"; id: string; request: PermissionRequest; createdAt: string }
  | {
      type: "review";
      id: string;
      result: CodeReviewReport | null;
      running?: boolean;
      error?: string | null;
      createdAt: string;
    }
  | { type: "test"; id: string; result: AgentTestRun; createdAt: string }
  | { type: "diff"; id: string; patch: DiffPatch; createdAt: string }
  | { type: "final_summary"; id: string; summary: string; createdAt: string }
  | { type: "error"; id: string; error: string; createdAt: string };

export interface AppState {
  activity: ActivityView;
  mainView: MainView;
  bottomTab: BottomTab;
  paletteOpen: boolean;
  layout: LayoutState;
  openFiles: OpenFile[];
  activeFile: string | null;
  sessions: Session[];
  activeSessionId: string;
  /** Map of session-id → true for sessions the user has pinned. Local-only
   *  (the shared Session schema has no `pinned` field). Persisted to
   *  localStorage under `PINNED_SESSIONS_KEY`. */
  pinnedSessions: Record<string, true>;
  /** Per-file VCS / agent-edit status: "A"dded, "M"odified, "D"eleted.
   *  Drives the badge in `FileTree`. Live mode populates from real VCS;
   *  in mock mode it's pre-seeded from `MOCK_FILE_STATUS`. */
  fileStatus: Record<string, "A" | "M" | "D">;
  chat: ChatEntry[];
  agentItems: AgentWorkflowItem[];
  plan: Plan | null;
  /** Draft text in the single Agent Panel composer. */
  input: string;
  streaming: boolean;
  isRunning: boolean;
  runId: string | null;
  selectedModel: { provider: string; model: string };
  /** Agent autonomy level for the active run config (R9.4). Replaces the
   *  previously hardcoded "High" badge in the Agent_Panel/Composer. */
  autonomy: AutonomyLevel;
  /** Conversation mode (redesign): "ask" = read-only Q&A, "agent" = full
   *  autonomy with file edits. Replaces the old Plan/Build text toggle. */
  agentMode: AgentMode;
  /**
   * Latest snapshot from the llama-server supervisor (Rust). `null` means we
   * haven't subscribed yet (browser preview, or before `initLlamaCppStatus`
   * runs). When `running` is true, `loaded_model_id` is the source of truth
   * for which `.gguf` is actually in VRAM. `last_error` is sticky until the
   * next load attempt.
   */
  llamaCppStatus: LlamaCppStatus | null;
  attachments: { id: string; label: string; kind: "file" | "selection" }[];
  pendingPatches: DiffPatch[];
  acceptedHunks: Record<string, Set<number>>;
  /** Ids of patches applied (written) during this session — used to mark
   *  review findings whose suggested fix has already been applied. */
  appliedPatchIds: Set<string>;
  liveMode: boolean;
  lastReview: CodeReviewReport | null;
  lastTestGen: TestGenerationResult | null;
  reviewRunning: boolean;
  testGenRunning: boolean;
  testRunRunning: boolean;
  reviewError: string | null;
  testGenError: string | null;
  /** The active workspace root, mirrored from desktop_config / onboarding.
   *  All Tauri FS + patch commands are scoped to this directory. */
  workspaceRoot: string | null;
  setWorkspaceRoot: (root: string | null) => Promise<void>;
  setActivity: (a: ActivityView) => void;
  setMainView: (v: MainView) => void;
  setBottomTab: (t: BottomTab) => void;
  togglePalette: (open?: boolean) => void;
  toggleSide: () => void;
  toggleRight: () => void;
  toggleBottom: () => void;
  openFile: (path: string) => Promise<void>;
  closeFile: (path: string) => void;
  setActiveFile: (path: string) => void;
  updateFile: (path: string, content: string) => void;
  loadSessions: () => Promise<void>;
  selectSession: (id: string) => Promise<void>;
  createSession: (title: string, workspaceRoot: string) => Promise<Session | null>;
  deleteSession: (id: string) => Promise<boolean>;
  /** Toggle pin state for a session (persisted). */
  togglePinnedSession: (id: string) => void;
  /** Set or clear a file's VCS status. Passing `null` removes the entry. */
  setFileStatus: (path: string, status: "A" | "M" | "D" | null) => void;
  sendUserMessage: (content: string) => Promise<void>;
  sendMessage: () => Promise<void>;
  setInput: (value: string) => void;
  runSlashCommand: (name: SlashCommandName, args?: Record<string, unknown>) => Promise<void>;
  approvePlan: (planId: string) => Promise<void>;
  revisePlan: (planId: string, instruction: string) => Promise<void>;
  cancelPlan: (planId: string) => Promise<void>;
  approvePermission: (requestId: string) => Promise<void>;
  rejectPermission: (requestId: string) => Promise<void>;
  retryTask: (taskId: string) => Promise<void>;
  applyTask: (taskId: string) => Promise<void>;
  dismissTask: (taskId: string) => Promise<void>;
  runTests: () => Promise<void>;
  cancelRun: () => Promise<void>;
  runReview: (req?: CodeReviewRequest) => Promise<void>;
  runTestGen: (req: TestGenRequest) => Promise<void>;
  reRunTest: () => Promise<void>;
  saveGeneratedTest: () => Promise<boolean>;
  grantPermission: (scope: PermissionScope, granted: boolean) => Promise<boolean>;
  toolDescriptors: ToolDescriptor[];
  loadToolDescriptors: () => Promise<void>;
  permissionGrants: PermissionGrant[];
  loadPermissions: () => Promise<void>;
  setPermissions: (grants: PermissionGrant[]) => Promise<boolean>;
  toolGrants: ToolGrant[];
  loadToolGrants: () => Promise<void>;
  /** Approve a single tool. `once` consumes the grant after one use. */
  grantTool: (tool: string, once: boolean) => Promise<boolean>;
  /** Revoke a per-tool override, falling back to scope-level checks. */
  revokeTool: (tool: string) => Promise<boolean>;
  /** Resume a suspended (needs_approval) tool call with the user's decision. */
  resolveApproval: (callId: string, allowed: boolean) => Promise<boolean>;
  /** Re-run a tool call cancelled by a restart, reusing the original prompt. */
  retryApproval: (callId: string) => Promise<boolean>;
  cancelStream: () => void;
  /** Whether the active run is paused. While paused, streamed Agent_Events are
   *  held (not applied) until the run resumes (R7.3, fixes bug #1). */
  agentPaused: boolean;
  /** Pause the active run's event consumption (R7.3). */
  pauseAgent: () => void;
  /** Resume a paused run, draining held events (R7.4). */
  resumeAgent: () => void;
  setSelectedModel: (m: { provider: string; model: string }) => void;
  /** Set the agent autonomy level (R9.4, R9.7). */
  setAutonomy: (level: AutonomyLevel) => void;
  /** Set the conversation mode (Ask = read-only, Agent = full autonomy). */
  setAgentMode: (mode: AgentMode) => void;
  /** Wire up the llama-server status subscription. Called once at app start. */
  initLlamaCppStatus: () => Promise<void>;
  addAttachment: (a: { label: string; kind: "file" | "selection" }) => void;
  removeAttachment: (id: string) => void;
  clearAttachments: () => void;
  toggleHunk: (diffId: string, hunkIndex: number) => void;
  acceptHunk: (diffId: string, hunkIndex: number) => void;
  rejectHunk: (diffId: string, hunkIndex: number) => void;
  applyPatch: (diffId: string) => Promise<boolean>;
  rejectPatch: (diffId: string) => void;
  acceptAllForDiff: (diffId: string) => Promise<boolean>;
  rejectAllForDiff: (diffId: string) => void;
  /** Queue a finding's suggested patch into `pendingPatches` (dedup by id)
   *  so it can be accepted/rejected like any agent-produced patch. */
  queueFindingPatch: (patch: DiffPatch) => void;
  /** Queue then immediately apply a finding's suggested patch. */
  applyFindingPatch: (patch: DiffPatch) => Promise<boolean>;
  /** Latest memory snapshot from the agent sidecar. `null` until the
   *  first `loadMemoryStats` call resolves, or in browser preview where
   *  the sidecar is unreachable. */
  memoryStats: MemoryStats | null;
  /** Extended context status with model recommendations and action flags. */
  contextStatus: ContextStatus | null;
  replitPlans: ReplitPlan[];
  replitTasks: ReplitTask[];
  selectedReplitTaskId: string | null;
  replitTaskLogs: Record<string, ReplitTaskLog[]>;
  replitCheckpoints: ReplitCheckpoint[];
  replitWorkflowLoading: boolean;
  replitWorkflowError: string | null;

  createReplitPlan: (prompt: string) => Promise<ReplitPlan | null>;
  reviseReplitPlan: (planId: string, prompt: string) => Promise<ReplitPlan | null>;
  approveReplitPlan: (planId: string) => Promise<boolean>;
  loadReplitWorkflow: () => Promise<void>;
  createReplitTask: (req: CreateReplitTaskRequest) => Promise<ReplitTask | null>;
  selectReplitTask: (taskId: string | null) => Promise<void>;
  queueReplitTask: (taskId: string) => Promise<boolean>;
  startReplitTask: (taskId: string) => Promise<boolean>;
  markReplitTaskReady: (taskId: string) => Promise<boolean>;
  applyReplitTask: (taskId: string) => Promise<boolean>;
  dismissReplitTask: (taskId: string) => Promise<boolean>;
  cancelReplitTask: (taskId: string) => Promise<boolean>;
  rollbackReplitCheckpoint: (checkpointId: string) => Promise<boolean>;
  clearReplitWorkflowError: () => void;
  loadMemoryStats: () => Promise<void>;
  compactMemory: () => Promise<void>;
  forgetMemory: (keepLast?: number) => Promise<void>;
  loadContextStatus: () => Promise<void>;
  setLayoutSizes: (
    sizes: Partial<Pick<LayoutState, "sidePanelSize" | "rightPanelSize" | "bottomDockSize">>,
  ) => void;
}

const STORAGE_KEY = "llama-studio.layout.v2";
const APPLIED_PATCHES_KEY = "llama-studio.applied-patches.v1";
const PINNED_SESSIONS_KEY = "llama-studio.pinned-sessions.v1";

const DEFAULT_LAYOUT: LayoutState = {
  sidePanelOpen: true,
  rightPanelOpen: true,
  bottomDockOpen: true,
  sidePanelSize: 18,
  rightPanelSize: 28,
  bottomDockSize: 28,
};

function clampPercent(value: unknown, min: number, max: number, fallback: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, Math.round(value)));
}

function sanitizeLayout(layout: Partial<LayoutState>): LayoutState {
  return {
    sidePanelOpen:
      typeof layout.sidePanelOpen === "boolean"
        ? layout.sidePanelOpen
        : DEFAULT_LAYOUT.sidePanelOpen,
    rightPanelOpen:
      typeof layout.rightPanelOpen === "boolean"
        ? layout.rightPanelOpen
        : DEFAULT_LAYOUT.rightPanelOpen,
    bottomDockOpen:
      typeof layout.bottomDockOpen === "boolean"
        ? layout.bottomDockOpen
        : DEFAULT_LAYOUT.bottomDockOpen,
    sidePanelSize: clampPercent(layout.sidePanelSize, 14, 34, DEFAULT_LAYOUT.sidePanelSize),
    rightPanelSize: clampPercent(layout.rightPanelSize, 22, 42, DEFAULT_LAYOUT.rightPanelSize),
    bottomDockSize: clampPercent(layout.bottomDockSize, 18, 52, DEFAULT_LAYOUT.bottomDockSize),
  };
}

function loadAppliedPatchIds(): Set<string> {
  if (typeof localStorage === "undefined") return new Set<string>();
  try {
    const raw = localStorage.getItem(APPLIED_PATCHES_KEY);
    if (!raw) return new Set<string>();
    const parsed = JSON.parse(raw);
    return new Set<string>(Array.isArray(parsed) ? parsed.filter((x) => typeof x === "string") : []);
  } catch {
    return new Set<string>();
  }
}

function persistAppliedPatchIds(ids: Set<string>): void {
  if (typeof localStorage === "undefined") return;
  try {
    localStorage.setItem(APPLIED_PATCHES_KEY, JSON.stringify(Array.from(ids)));
  } catch {
    /* quota etc — silently ignore */
  }
}

function loadPinnedSessions(): Record<string, true> {
  if (typeof localStorage === "undefined") {
    const out: Record<string, true> = {};
    for (const id of MOCK_PINNED_SESSION_IDS) out[id] = true;
    return out;
  }
  try {
    const raw = localStorage.getItem(PINNED_SESSIONS_KEY);
    if (!raw) {
      const out: Record<string, true> = {};
      for (const id of MOCK_PINNED_SESSION_IDS) out[id] = true;
      return out;
    }
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return {};
    const out: Record<string, true> = {};
    for (const id of parsed) if (typeof id === "string") out[id] = true;
    return out;
  } catch {
    return {};
  }
}

function persistPinnedSessions(pinned: Record<string, true>): void {
  if (typeof localStorage === "undefined") return;
  try {
    localStorage.setItem(PINNED_SESSIONS_KEY, JSON.stringify(Object.keys(pinned)));
  } catch {
    /* ignore */
  }
}

function loadLayout(): LayoutState {
  if (typeof localStorage === "undefined") return DEFAULT_LAYOUT;
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) return sanitizeLayout(JSON.parse(raw) as Partial<LayoutState>);
  } catch {
    /* ignore */
  }
  return DEFAULT_LAYOUT;
}

function persistLayout(layout: LayoutState) {
  if (typeof localStorage === "undefined") return;
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(sanitizeLayout(layout)));
  } catch {
    /* ignore */
  }
}

// The Agent Panel starts empty — chat, plan, tools and diffs only appear from
// a real agent run. No seeded placeholder content.
const initialChat: ChatEntry[] = [];

function languageFor(path: string): string {
  const ext = path.split(".").pop()?.toLowerCase() ?? "";
  switch (ext) {
    case "ts":
    case "tsx":
      return "typescript";
    case "js":
    case "jsx":
      return "javascript";
    case "py":
      return "python";
    case "rs":
      return "rust";
    case "json":
      return "json";
    case "md":
      return "markdown";
    case "html":
      return "html";
    case "css":
      return "css";
    default:
      return "plaintext";
  }
}

function entriesFromSession(session: Session): ChatEntry[] {
  const out: Array<{ entry: ChatEntry; ts: number }> = [];
  for (const m of session.messages) {
    out.push({
      entry: { kind: "message" as const, id: m.id, message: m },
      ts: Date.parse(m.created_at) || 0,
    });
  }
  for (const tc of session.tool_calls) {
    out.push({
      entry: { kind: "tool_call" as const, id: tc.id, toolCall: tc },
      ts: Date.parse(tc.started_at ?? tc.finished_at ?? "") || 0,
    });
  }
  // Stable sort so equal timestamps preserve insertion order.
  out.sort((a, b) => a.ts - b.ts);
  const filtered: typeof out = [];
  for (const item of out) {
    const prev = filtered[filtered.length - 1];
    if (
      prev?.entry.kind === "message" &&
      item.entry.kind === "message" &&
      prev.entry.message &&
      item.entry.message &&
      isDuplicateUserMessage(prev.entry.message, item.entry.message, item.ts - prev.ts)
    ) {
      filtered[filtered.length - 1] = item;
      continue;
    }
    filtered.push(item);
  }
  return filtered.map((x) => x.entry);
}

function workflowItemsFromSession(session: Session): AgentWorkflowItem[] {
  return entriesToWorkflowItems(entriesFromSession(session));
}

function entriesToWorkflowItems(entries: ChatEntry[]): AgentWorkflowItem[] {
  return entries.flatMap((entry) => {
    if (entry.kind === "message" && entry.message) {
      return [messageToWorkflowItem(entry.message)];
    }
    if (entry.kind === "tool_call" && entry.toolCall) {
      return toolToWorkflowItems(entry.toolCall);
    }
    if (entry.kind === "diff" && entry.diff) {
      return [
        {
          type: "diff" as const,
          id: entry.diff.id,
          patch: entry.diff,
          createdAt: new Date().toISOString(),
        },
      ];
    }
    return [];
  });
}

function messageToWorkflowItem(message: Message): AgentWorkflowItem {
  const isUser = message.role === "user";
  return {
    type: isUser ? "user_message" : "agent_message",
    id: message.id,
    text: message.content,
    createdAt: message.created_at,
  };
}

function toolToWorkflowItems(toolCall: ToolCall): AgentWorkflowItem[] {
  const createdAt = toolCall.started_at ?? toolCall.finished_at ?? new Date().toISOString();
  const toolItem: AgentWorkflowItem = {
    type: "tool",
    id: toolCall.id,
    toolCall,
    createdAt,
  };
  if (toolCall.status !== "needs_approval") return [toolItem];
  return [
    toolItem,
    {
      type: "permission",
      id: `permission-${toolCall.id}`,
      request: permissionFromToolCall(toolCall),
      createdAt,
    },
  ];
}

function permissionFromToolCall(toolCall: ToolCall): PermissionRequest {
  return {
    id: toolCall.id,
    toolCall,
    title: `Approve ${toolCall.name}`,
    summary: toolCall.error || "The agent needs your approval before this action can continue.",
  };
}

function planStatus(plan: Plan | ReplitPlan): "pending" | "approved" | "cancelled" {
  if ("status" in plan) {
    if (plan.status === "approved") return "approved";
    if (plan.status === "archived") return "cancelled";
  }
  return "pending";
}

function planCreatedAt(plan: Plan | ReplitPlan): string {
  return "created_at" in plan ? plan.created_at : new Date().toISOString();
}

function upsertWorkflowItem(
  items: AgentWorkflowItem[],
  next: AgentWorkflowItem,
): AgentWorkflowItem[] {
  const idx = items.findIndex((item) => item.id === next.id);
  if (idx === -1) return [...items, next];
  const out = [...items];
  out[idx] = { ...items[idx], ...next } as AgentWorkflowItem;
  return out;
}

function removeWorkflowItem(items: AgentWorkflowItem[], id: string): AgentWorkflowItem[] {
  return items.filter((item) => item.id !== id);
}

function upsertWorkflowMessage(
  items: AgentWorkflowItem[],
  message: Message,
  streaming = false,
): AgentWorkflowItem[] {
  const item = messageToWorkflowItem(message);
  const next =
    item.type === "agent_message" ? { ...item, streaming } : item;
  return upsertWorkflowItem(items, next);
}

function upsertWorkflowTool(
  items: AgentWorkflowItem[],
  toolCall: ToolCall,
): AgentWorkflowItem[] {
  let next = upsertWorkflowItem(items, {
    type: "tool",
    id: toolCall.id,
    toolCall,
    createdAt: toolCall.started_at ?? toolCall.finished_at ?? new Date().toISOString(),
  });
  const permissionId = `permission-${toolCall.id}`;
  if (toolCall.status === "needs_approval") {
    next = upsertWorkflowItem(next, {
      type: "permission",
      id: permissionId,
      request: permissionFromToolCall(toolCall),
      createdAt: toolCall.started_at ?? new Date().toISOString(),
    });
  } else {
    next = removeWorkflowItem(next, permissionId);
  }
  return next;
}

function upsertWorkflowPlan(
  items: AgentWorkflowItem[],
  plan: Plan | ReplitPlan,
): AgentWorkflowItem[] {
  return upsertWorkflowItem(items, {
    type: "plan",
    id: `plan-${plan.id}`,
    plan,
    status: planStatus(plan),
    createdAt: planCreatedAt(plan),
  });
}

function upsertWorkflowTask(
  items: AgentWorkflowItem[],
  task: ReplitTask,
): AgentWorkflowItem[] {
  return upsertWorkflowItem(items, {
    type: "task",
    id: `task-${task.id}`,
    task,
    createdAt: task.created_at,
  });
}

function upsertWorkflowReview(
  items: AgentWorkflowItem[],
  next: Omit<Extract<AgentWorkflowItem, { type: "review" }>, "type" | "id" | "createdAt">,
): AgentWorkflowItem[] {
  return upsertWorkflowItem(items, {
    type: "review",
    id: "review-latest",
    createdAt: new Date().toISOString(),
    ...next,
  });
}

function upsertWorkflowTest(
  items: AgentWorkflowItem[],
  result: AgentTestRun,
): AgentWorkflowItem[] {
  return upsertWorkflowItem(items, {
    type: "test",
    id: result.id,
    result,
    createdAt: new Date().toISOString(),
  });
}

function appendWorkflowError(items: AgentWorkflowItem[], error: string): AgentWorkflowItem[] {
  return [
    ...items,
    { type: "error", id: `err-${Date.now()}`, error, createdAt: new Date().toISOString() },
  ];
}

function isPlaceholderPlan(plan: Plan | ReplitPlan): boolean {
  if ("tasks" in plan) return false;
  const goal = plan.goal.trim();
  if (goal.length > 80 || plan.steps.length > 1) return false;
  const [step] = plan.steps;
  if (!step) return true;
  const title = step.title.trim().toLowerCase();
  const detail = (step.detail ?? "").trim();
  return (
    !detail &&
    (title === "complete the goal" ||
      title === "complete goal" ||
      title === "respond to the user")
  );
}

function sameText(a: string, b: string): boolean {
  return a.trim().replace(/\s+/g, " ") === b.trim().replace(/\s+/g, " ");
}

function isDuplicateUserMessage(prev: Message, next: Message, deltaMs: number): boolean {
  return (
    prev.role === "user" &&
    next.role === "user" &&
    prev.content.trim() === next.content.trim() &&
    deltaMs >= 0 &&
    deltaMs <= 5000
  );
}

let currentAbort: AbortController | null = null;

export const useApp = create<AppState>((set, get) => ({
  activity: "files",
  mainView: "editor",
  bottomTab: "terminal",
  paletteOpen: false,
  layout: loadLayout(),
  openFiles: [
    {
      path: "/src/App.tsx",
      name: "App.tsx",
      language: "typescript",
      content: MOCK_FILE_CONTENT["/src/App.tsx"].content,
      dirty: false,
    },
    {
      path: "/services/agent.py",
      name: "agent.py",
      language: "python",
      content: MOCK_FILE_CONTENT["/services/agent.py"].content,
      dirty: false,
    },
  ],
  activeFile: "/src/App.tsx",
  sessions: MOCK_SESSIONS,
  activeSessionId: MOCK_SESSIONS[0].id,
  pinnedSessions: loadPinnedSessions(),
  fileStatus: { ...MOCK_FILE_STATUS },
  chat: initialChat,
  agentItems: entriesToWorkflowItems(initialChat),
  plan: null,
  input: "",
  streaming: false,
  isRunning: false,
  runId: null,
  selectedModel: { provider: "llamacpp", model: "" },
  autonomy: "High",
  agentMode: "agent",
  agentPaused: false,
  llamaCppStatus: null,
  attachments: [],
  pendingPatches: [],
  acceptedHunks: {},
  appliedPatchIds: loadAppliedPatchIds(),
  liveMode: false,
  toolDescriptors: [],
  permissionGrants: [],
  toolGrants: [],
  lastReview: null,
  lastTestGen: null,
  reviewRunning: false,
  testGenRunning: false,
  testRunRunning: false,
  reviewError: null,
  testGenError: null,
  workspaceRoot: null,
  memoryStats: null,
  contextStatus: null,
  replitPlans: [],
  replitTasks: [],
  selectedReplitTaskId: null,
  replitTaskLogs: {},
  replitCheckpoints: [],
  replitWorkflowLoading: false,
  replitWorkflowError: null,

  setWorkspaceRoot: async (root) => {
    set({ workspaceRoot: root });
    if (isTauri()) await tauriSetWorkspaceRoot(root);
  },

  setActivity: (a) => set({ activity: a }),
  setMainView: (v) => set({ mainView: v }),
  setBottomTab: (t) => set({ bottomTab: t, layout: { ...get().layout, bottomDockOpen: true } }),
  togglePalette: (open) => set((s) => ({ paletteOpen: open ?? !s.paletteOpen })),
  toggleSide: () => {
    const layout = { ...get().layout, sidePanelOpen: !get().layout.sidePanelOpen };
    persistLayout(layout);
    set({ layout });
  },
  toggleRight: () => {
    const layout = { ...get().layout, rightPanelOpen: !get().layout.rightPanelOpen };
    persistLayout(layout);
    set({ layout });
  },
  toggleBottom: () => {
    const layout = { ...get().layout, bottomDockOpen: !get().layout.bottomDockOpen };
    persistLayout(layout);
    set({ layout });
  },

  openFile: async (path) => {
    const existing = get().openFiles.find((f) => f.path === path);
    if (existing) {
      set({ activeFile: path, mainView: "editor" });
      return;
    }
    let content: string | null = null;
    if (isTauri()) {
      content = await fsReadText(path);
    }
    if (content === null) {
      const f = MOCK_FILE_CONTENT[path];
      if (!f) return;
      content = f.content;
    }
    const name = path.split("/").pop() ?? path;
    set((s) => ({
      openFiles: [
        ...s.openFiles,
        { path, name, language: languageFor(path), content: content!, dirty: false },
      ],
      activeFile: path,
      mainView: "editor",
    }));
  },
  closeFile: (path) => {
    set((s) => {
      const next = s.openFiles.filter((f) => f.path !== path);
      const active = s.activeFile === path ? next[next.length - 1]?.path ?? null : s.activeFile;
      return { openFiles: next, activeFile: active };
    });
  },
  setActiveFile: (path) => set({ activeFile: path, mainView: "editor" }),
  updateFile: (path, content) =>
    set((s) => ({
      openFiles: s.openFiles.map((f) =>
        f.path === path ? { ...f, content, dirty: true } : f,
      ),
    })),

  loadSessions: async () => {
    // Hydrate workspace root from persisted desktop config first so any
    // subsequent FS / patch operations have a valid scope to validate
    // against on the Rust side.
    if (isTauri()) {
      const cfg = await desktopConfigGet();
      if (cfg.workspace_root) {
        set({ workspaceRoot: cfg.workspace_root });
        await tauriSetWorkspaceRoot(cfg.workspace_root);
      }
    }
    try {
      const client = await getAgentClient();
      let sessions = await client.listSessions();
      if (!sessions.length) {
        // Auto-create a session so the user can start working immediately.
        const workspaceRoot = get().workspaceRoot || "/tmp";
        const { provider, model } = get().selectedModel;
        const session = await client.createSession({
          title: "New Session",
          workspace_root: workspaceRoot,
          provider: provider || undefined,
          model: model || undefined,
        });
        sessions = [session];
      }
      const first = sessions[0];
      set({
        sessions,
        liveMode: true,
        activeSessionId: first.id,
        chat: entriesFromSession(first),
        agentItems: workflowItemsFromSession(first),
        plan: first.plan ?? null,
        workspaceRoot: first.workspace_root ?? get().workspaceRoot,
      });
      void get().loadMemoryStats();
      void get().loadReplitWorkflow();
    } catch {
      // Browser preview / sidecar offline → keep mocks.
    }
  },

  selectSession: async (id) => {
    set({ activeSessionId: id });
    if (!get().liveMode) return;
    try {
      const client = await getAgentClient();
      const session = await client.getSession(id);
      set((s) => ({
        sessions: s.sessions.map((x) => (x.id === id ? session : x)),
        chat: entriesFromSession(session),
        agentItems: workflowItemsFromSession(session),
        plan: session.plan ?? null,
      }));
    } catch {
      /* keep cached */
    }
    void get().loadMemoryStats();
    void get().loadReplitWorkflow();
  },

  createSession: async (title, workspaceRoot) => {
    try {
      const client = await getAgentClient();
      const { provider, model } = get().selectedModel;
      const session = await client.createSession({
        title,
        workspace_root: workspaceRoot,
        provider,
        model,
      });
      set((s) => ({
        sessions: [session, ...s.sessions],
        activeSessionId: session.id,
        chat: entriesFromSession(session),
        agentItems: workflowItemsFromSession(session),
        plan: session.plan ?? null,
        liveMode: true,
        replitPlans: [],
        replitTasks: [],
        selectedReplitTaskId: null,
      }));
      await track("session.created", { id: session.id });
      return session;
    } catch {
      return null;
    }
  },

  deleteSession: async (id) => {
    const before = get();
    const nextSessions = before.sessions.filter((s) => s.id !== id);
    const deletingActive = before.activeSessionId === id;

    if (before.liveMode) {
      try {
        const client = await getAgentClient();
        await client.deleteSession(id);
      } catch (err) {
        await track("error", {
          stage: "deleteSession",
          message: (err as Error).message,
        }).catch(() => undefined);
        return false;
      }
    }

    set({
      sessions: nextSessions,
      ...(deletingActive
        ? {
            activeSessionId: nextSessions[0]?.id ?? "",
            chat: nextSessions[0] ? entriesFromSession(nextSessions[0]) : [],
            agentItems: nextSessions[0] ? workflowItemsFromSession(nextSessions[0]) : [],
            plan: nextSessions[0]?.plan ?? null,
            replitPlans: [],
            replitTasks: [],
            selectedReplitTaskId: null,
            replitTaskLogs: {},
            replitCheckpoints: [],
          }
        : {}),
    });

    if (deletingActive && before.liveMode && nextSessions[0]) {
      await get().selectSession(nextSessions[0].id);
    }
    await track("session.deleted", { id });
    return true;
  },

  togglePinnedSession: (id) => {
    const current = get().pinnedSessions;
    const next: Record<string, true> = { ...current };
    if (next[id]) delete next[id];
    else next[id] = true;
    persistPinnedSessions(next);
    set({ pinnedSessions: next });
  },

  setFileStatus: (path, status) => {
    const current = get().fileStatus;
    const next: Record<string, "A" | "M" | "D"> = { ...current };
    if (status === null) delete next[path];
    else next[path] = status;
    set({ fileStatus: next });
  },

  sendUserMessage: async (content) => {
    if (!content.trim()) return;
    let sessionId = get().activeSessionId;
    const outgoing = expandFileMentions(content, get());
    // Ask mode is pure read-only Q&A: never route to the plan/build
    // workflow, never auto-create tasks. Only explicit slash commands are
    // still honored below.
    const askMode = get().agentMode === "ask";
    const workflowIntent = askMode ? null : workflowIntentForMessage(outgoing, get());
    const appendLocalUserMessage = () => {
      const userMsg: Message = {
        id: `local-${Date.now()}`,
        role: "user",
        content: outgoing,
        created_at: new Date().toISOString(),
      };
      set((s) => ({
        chat: [...s.chat, { kind: "message", id: userMsg.id, message: userMsg }],
        agentItems: upsertWorkflowMessage(s.agentItems, userMsg),
      }));
    };

    // `/plan <description>` is intercepted before the generic slash parser
    // because it routes to the Replit plan workflow, not the streaming
    // agent recipe. Mirrors how `/review` and `/test` dispatch in
    // `runSlashCommand`.
    const planMatch = /^\s*\/plan(?:\s+(.*))?$/i.exec(outgoing);
    if (planMatch && !askMode) {
      const prompt = (planMatch[1] ?? "").trim();
      if (!prompt) {
        appendErrorChat(
          set,
          "sendUserMessage",
          new Error("Usage: /plan <describe the change you want planned>"),
        );
        return;
      }
      appendLocalUserMessage();
      await get().createReplitPlan(prompt);
      return;
    }

    if (workflowIntent) {
      appendLocalUserMessage();
      set({
        activity: get().activity === "tasks" ? "files" : get().activity,
        mainView: "editor",
        layout: { ...get().layout, sidePanelOpen: true, rightPanelOpen: true },
      });
      if (workflowIntent.existingPlanId) {
        const approved = await get().approveReplitPlan(workflowIntent.existingPlanId);
        if (approved) await startFirstRunnableReplitTask(get, workflowIntent.existingPlanId);
        return;
      }
      const plan = await get().createReplitPlan(workflowIntent.prompt);
      if (plan && workflowIntent.autoApprove) {
        const approved = await get().approveReplitPlan(plan.id);
        if (approved) await startFirstRunnableReplitTask(get, plan.id);
      }
      return;
    }

    // Slash command routing: `/name arg1 arg2…` → `runSlashCommand`.
    const slash = parseSlash(outgoing);
    if (slash) {
      const userMsg: Message = {
        id: `local-${Date.now()}`,
        role: "user",
        content: outgoing,
        created_at: new Date().toISOString(),
      };
      set((s) => ({
        chat: [...s.chat, { kind: "message", id: userMsg.id, message: userMsg }],
        agentItems: upsertWorkflowMessage(s.agentItems, userMsg),
      }));
      await get().runSlashCommand(slash.name as SlashCommandName, slash.args);
      return;
    }

    const runPayload = buildRunAgentRequest(get(), outgoing);
    if (!runPayload) {
      appendErrorChat(set, "sendUserMessage", new Error("No workspace selected."));
      return;
    }

    const userMsg: Message = {
      id: `local-${Date.now()}`,
      role: "user",
      content: outgoing,
      created_at: new Date().toISOString(),
    };
    set((s) => ({
      chat: [...s.chat, { kind: "message", id: userMsg.id, message: userMsg }],
      agentItems: upsertWorkflowMessage(s.agentItems, userMsg),
      streaming: true,
      isRunning: true,
      runId: `run-${Date.now()}`,
    }));
    await track("session.message_sent", { id: sessionId });

    if (!get().liveMode) {
      // Mock fallback for browser preview.
      setTimeout(() => {
        const reply: Message = {
          id: `m-${Date.now() + 1}`,
          role: "assistant",
          content: "Got it. (Mock response — agent sidecar not reachable.)",
          created_at: new Date().toISOString(),
        };
        set((s) => ({
          chat: [...s.chat, { kind: "message", id: reply.id, message: reply }],
          agentItems: upsertWorkflowMessage(s.agentItems, reply),
          streaming: false,
          isRunning: false,
          runId: null,
        }));
      }, 400);
      return;
    }

    const abort = new AbortController();
    currentAbort?.abort();
    currentAbort = abort;
    try {
      const client = await getAgentClient();
      // Ensure a valid session exists on the backend before streaming.
      sessionId = await ensureBackendSession(client, get, set);
      // Resolve bring-your-own cloud creds for the selected model and merge
      // them into the run payload so the backend routes to the right endpoint.
      const creds = await resolveProviderCreds(get());
      const payloadWithCreds: RunAgentRequest = {
        ...runPayload,
        provider: creds.provider,
        apiKey: creds.apiKey,
        baseUrl: creds.baseUrl,
      };
      await consumeStream(
        client.runAgent(sessionId, payloadWithCreds, abort.signal),
        set,
      );
    } catch (err) {
      appendErrorChat(set, "sendUserMessage", err);
    } finally {
      // Only flip streaming off if a newer send hasn't taken ownership;
      // otherwise we'd hide the spinner mid-stream.
      if (currentAbort === abort) {
        currentAbort = null;
        set({ streaming: false, isRunning: false, runId: null });
      }
      // Refresh the memory snapshot so the indicator reflects the new
      // turn. Best-effort — failure leaves the stale snapshot alone.
      void get().loadMemoryStats();
    }
  },

  runSlashCommand: async (name, args) => {
    let sessionId = get().activeSessionId;
    // `/review` and `/test` are routed exclusively to their structured
    // endpoints so the new Review / Tests panels are the single source
    // of truth — running them *and* the streaming slash recipe would
    // duplicate backend work and, for `/test`, race on file writes.
    // A short chat summary is appended afterwards so the chat fallback
    // still shows something when the panel is closed.
    if (name === "review" || name === "test") {
      if (!get().liveMode) {
        setTimeout(() => {
          const reply: Message = {
            id: `m-${Date.now() + 1}`,
            role: "assistant",
            content: `Ran /${name} (mock — sidecar offline).`,
            created_at: new Date().toISOString(),
          };
          set((s) => ({
            chat: [...s.chat, { kind: "message", id: reply.id, message: reply }],
            agentItems: upsertWorkflowMessage(s.agentItems, reply),
            streaming: false,
            isRunning: false,
            runId: null,
          }));
        }, 200);
        set({ streaming: true, isRunning: true, runId: `run-${Date.now()}` });
        return;
      }
      set({ streaming: true, isRunning: true, runId: `run-${Date.now()}` });
      await track("session.slash_command", { id: sessionId, name });
      try {
        if (name === "review") {
          await get().runReview();
          const report = get().lastReview;
          if (report) {
            appendAssistantSummary(
              set,
              `Code review complete — ${report.findings.length} finding(s)` +
                (report.summary ? `: ${report.summary}` : "."),
            );
          }
        } else {
          const target = typeof args?.target === "string" ? (args.target as string) : "";
          if (!target) {
            appendErrorChat(set, "slash:test", new Error("/test requires a target file path"));
          } else {
            await get().runTestGen({ target });
            const result = get().lastTestGen;
            if (result) {
              appendAssistantSummary(
                set,
                `Generated ${result.framework} test at \`${result.test_file}\` — ` +
                  `${result.passed ? "passed" : "failed"} after ${result.attempts} attempt(s).`,
              );
            }
          }
        }
      } finally {
        set({ streaming: false, isRunning: false, runId: null });
      }
      return;
    }
    if (!get().liveMode) {
      // Mock fallback so the UI is still responsive in browser preview.
      setTimeout(() => {
        const reply: Message = {
          id: `m-${Date.now() + 1}`,
          role: "assistant",
          content: `Ran /${name} (mock — sidecar offline).`,
          created_at: new Date().toISOString(),
        };
        set((s) => ({
          chat: [...s.chat, { kind: "message", id: reply.id, message: reply }],
          agentItems: upsertWorkflowMessage(s.agentItems, reply),
          streaming: false,
          isRunning: false,
          runId: null,
        }));
      }, 200);
      set({ streaming: true, isRunning: true, runId: `run-${Date.now()}` });
      return;
    }
    const abort = new AbortController();
    currentAbort?.abort();
    currentAbort = abort;
    set({ streaming: true, isRunning: true, runId: `run-${Date.now()}` });
    await track("session.slash_command", { id: sessionId, name });
    try {
      const client = await getAgentClient();
      // Ensure a valid backend session exists before streaming.
      sessionId = await ensureBackendSession(client, get, set);
      await consumeStream(
        client.runSlashCommand(sessionId, { name, args: args ?? {} }, abort.signal),
        set,
      );
    } catch (err) {
      appendErrorChat(set, `slash:${name}`, err);
    } finally {
      if (currentAbort === abort) {
        currentAbort = null;
        set({ streaming: false, isRunning: false, runId: null });
      }
      void get().loadMemoryStats();
    }
  },

  sendMessage: async () => {
    const content = get().input;
    if (!content.trim()) return;
    set({ input: "" });
    await get().sendUserMessage(content);
  },

  setInput: (value) => set({ input: value }),

  approvePlan: async (planId) => {
    const approved = await get().approveReplitPlan(planId);
    if (approved) await startFirstRunnableReplitTask(get, planId);
  },

  revisePlan: async (planId, instruction) => {
    const prompt = instruction.trim();
    if (!prompt) {
      set({ input: "/plan " });
      return;
    }
    await get().reviseReplitPlan(planId, prompt);
  },

  cancelPlan: async (planId) => {
    const now = new Date().toISOString();
    set((s) => ({
      replitPlans: s.replitPlans.map((plan) =>
        plan.id === planId ? { ...plan, status: "archived", updated_at: now } : plan,
      ),
      agentItems: s.agentItems.map((item) =>
        item.type === "plan" && item.id === `plan-${planId}`
          ? { ...item, status: "cancelled" as const }
          : item,
      ),
    }));
  },

  approvePermission: async (requestId) => {
    const item = get().agentItems.find(
      (entry) => entry.type === "permission" && entry.request.id === requestId,
    );
    if (item?.type === "permission") {
      await get().grantTool(item.request.toolCall.name, true);
    }
    await get().resolveApproval(requestId, true);
  },

  rejectPermission: async (requestId) => {
    await get().resolveApproval(requestId, false);
  },

  retryTask: async (taskId) => {
    await get().startReplitTask(taskId);
  },

  applyTask: async (taskId) => {
    await get().applyReplitTask(taskId);
  },

  dismissTask: async (taskId) => {
    await get().dismissReplitTask(taskId);
  },

  runTests: async () => {
    const target = get().activeFile;
    if (target) await get().runTestGen({ target });
    else await get().sendUserMessage("Run the project test suite and report any failures.");
  },

  cancelRun: async () => {
    get().cancelStream();
  },

  runReview: async (req) => {
    const sessionId = get().activeSessionId;
    if (!get().liveMode) {
      const message = "Agent sidecar offline — start the desktop app to run a review.";
      set((s) => ({
        reviewError: message,
        agentItems: upsertWorkflowReview(s.agentItems, {
          result: s.lastReview,
          running: false,
          error: message,
        }),
      }));
      return;
    }
    set((s) => ({
      reviewRunning: true,
      reviewError: null,
      agentItems: upsertWorkflowReview(s.agentItems, {
        result: s.lastReview,
        running: true,
        error: null,
      }),
    }));
    try {
      const client = await getAgentClient();
      const payload: CodeReviewRequest = req?.diff || req?.excerpts
        ? req
        : { diff: null, excerpts: collectExcerptsForReview(get()) };
      const report = await client.codeReview(sessionId, payload);
      set((s) => ({
        lastReview: report,
        agentItems: upsertWorkflowReview(s.agentItems, {
          result: report,
          running: false,
          error: null,
        }),
      }));
      await track("review.completed", {
        id: sessionId,
        findings: report.findings.length,
      });
    } catch (err) {
      const message = (err as Error).message;
      set((s) => ({
        reviewError: message,
        agentItems: upsertWorkflowReview(s.agentItems, {
          result: s.lastReview,
          running: false,
          error: message,
        }),
      }));
      await track("error", { stage: "runReview", message: (err as Error).message }).catch(
        () => undefined,
      );
    } finally {
      set({ reviewRunning: false });
    }
  },

  runTestGen: async (req) => {
    const sessionId = get().activeSessionId;
    if (!get().liveMode) {
      const message = "Agent sidecar offline — start the desktop app to generate tests.";
      set((s) => ({
        testGenError: message,
        agentItems: appendWorkflowError(s.agentItems, message),
      }));
      return;
    }
    if (!req.target?.trim()) {
      const message = "Provide a target file path.";
      set((s) => ({
        testGenError: message,
        agentItems: appendWorkflowError(s.agentItems, message),
      }));
      return;
    }
    const testId = `testgen-${Date.now()}`;
    set((s) => ({
      testGenRunning: true,
      testGenError: null,
      agentItems: upsertWorkflowTest(s.agentItems, {
        id: testId,
        name: "test generation",
        command: `/test ${req.target}`,
        status: "running",
        output: null,
        result: null,
      }),
    }));
    try {
      const client = await getAgentClient();
      const result = await client.testGen(sessionId, req);
      set((s) => ({
        lastTestGen: result,
        agentItems: upsertWorkflowTest(s.agentItems, {
          id: testId,
          name: result.framework,
          command: `/test ${result.target}`,
          status: result.passed ? "passed" : "failed",
          output: result.last_output,
          result,
        }),
      }));
      await track("testgen.completed", {
        id: sessionId,
        framework: result.framework,
        passed: result.passed,
      });
    } catch (err) {
      const message = (err as Error).message;
      set((s) => ({
        testGenError: message,
        agentItems: upsertWorkflowTest(s.agentItems, {
          id: testId,
          name: "test generation",
          command: `/test ${req.target}`,
          status: "failed",
          output: message,
          result: null,
        }),
      }));
      await track("error", { stage: "runTestGen", message: (err as Error).message }).catch(
        () => undefined,
      );
    } finally {
      set({ testGenRunning: false });
    }
  },

  reRunTest: async () => {
    const sessionId = get().activeSessionId;
    const current = get().lastTestGen;
    if (!current) return;
    if (!get().liveMode) {
      const message = "Agent sidecar offline — start the desktop app to run tests.";
      set((s) => ({
        testGenError: message,
        agentItems: appendWorkflowError(s.agentItems, message),
      }));
      return;
    }
    const testId = `testrun-${Date.now()}`;
    set((s) => ({
      testRunRunning: true,
      testGenError: null,
      agentItems: upsertWorkflowTest(s.agentItems, {
        id: testId,
        name: current.framework,
        command: `run ${current.test_file}`,
        status: "running",
        output: current.last_output,
        result: current,
      }),
    }));
    try {
      const client = await getAgentClient();
      const result = await client.testRun(sessionId, {
        test_file: current.test_file,
        target: current.target,
      });
      set((s) => {
        const merged = s.lastTestGen
          ? {
              ...s.lastTestGen,
              passed: result.passed,
              last_output: result.last_output,
              attempts: result.attempts,
              test_source: result.test_source || s.lastTestGen.test_source,
              framework: result.framework,
            }
          : result;
        return {
          lastTestGen: merged,
          agentItems: upsertWorkflowTest(s.agentItems, {
            id: testId,
            name: merged.framework,
            command: `run ${merged.test_file}`,
            status: merged.passed ? "passed" : "failed",
            output: merged.last_output,
            result: merged,
          }),
        };
      });
      await track("testgen.completed", {
        id: sessionId,
        framework: result.framework,
        passed: result.passed,
        rerun: true,
      });
    } catch (err) {
      const message = (err as Error).message;
      set((s) => ({
        testGenError: message,
        agentItems: upsertWorkflowTest(s.agentItems, {
          id: testId,
          name: current.framework,
          command: `run ${current.test_file}`,
          status: "failed",
          output: message,
          result: current,
        }),
      }));
      await track("error", { stage: "reRunTest", message: (err as Error).message }).catch(
        () => undefined,
      );
    } finally {
      set({ testRunRunning: false });
    }
  },

  saveGeneratedTest: async () => {
    const result = get().lastTestGen;
    if (!result) return false;
    if (!isTauri()) {
      // Browser preview: nothing to write; report success so the UI can
      // still acknowledge the action.
      await track("testgen.saved", { mock: true, file: result.test_file });
      return true;
    }
    const root =
      get().workspaceRoot ??
      get().sessions.find((s) => s.id === get().activeSessionId)?.workspace_root ??
      null;
    if (!root) return false;
    const sep = root.includes("\\") && !root.includes("/") ? "\\" : "/";
    const trimmedRoot = root.endsWith(sep) ? root.slice(0, -1) : root;
    const ok = await fsWriteText(`${trimmedRoot}${sep}${result.test_file}`, result.test_source);
    if (ok) await track("testgen.saved", { file: result.test_file });
    return ok;
  },

  grantPermission: async (scope, granted) => {
    const sessionId = get().activeSessionId;
    if (!get().liveMode) {
      set((s) => {
        const others = s.permissionGrants.filter((g) => g.scope !== scope);
        return { permissionGrants: [...others, { scope, granted }] };
      });
      await track("permission.grant", { scope, granted, mock: true });
      return true;
    }
    try {
      const client = await getAgentClient();
      const next = await client.setPermissions(sessionId, [{ scope, granted }]);
      set({ permissionGrants: next });
      await track("permission.grant", { scope, granted });
      return true;
    } catch (err) {
      await track("error", {
        stage: "grantPermission",
        message: (err as Error).message,
      }).catch(() => undefined);
      return false;
    }
  },

  loadToolDescriptors: async () => {
    if (get().toolDescriptors.length > 0) return;
    if (!get().liveMode) return;
    try {
      const client = await getAgentClient();
      const descriptors = await client.listTools();
      set({ toolDescriptors: descriptors });
    } catch {
      /* ignore — fall back to empty list */
    }
  },

  loadPermissions: async () => {
    if (!get().liveMode) return;
    try {
      const client = await getAgentClient();
      const grants = await client.listPermissions(get().activeSessionId);
      set({ permissionGrants: grants });
    } catch {
      /* ignore */
    }
  },

  setPermissions: async (grants) => {
    if (!get().liveMode) {
      set({ permissionGrants: grants });
      return true;
    }
    try {
      const client = await getAgentClient();
      const next = await client.setPermissions(get().activeSessionId, grants);
      set({ permissionGrants: next });
      return true;
    } catch (err) {
      await track("error", {
        stage: "setPermissions",
        message: (err as Error).message,
      }).catch(() => undefined);
      return false;
    }
  },

  loadToolGrants: async () => {
    if (!get().liveMode) return;
    try {
      const client = await getAgentClient();
      const grants = await client.listToolGrants(get().activeSessionId);
      set({ toolGrants: grants });
    } catch {
      /* ignore */
    }
  },

  grantTool: async (tool, once) => {
    const sessionId = get().activeSessionId;
    if (!get().liveMode) {
      set((s) => {
        const others = s.toolGrants.filter((g) => g.tool !== tool);
        return { toolGrants: [...others, { tool, granted: true, once }] };
      });
      await track("permission.grant_tool", { tool, once, mock: true });
      return true;
    }
    try {
      const client = await getAgentClient();
      const next = await client.setToolGrants(sessionId, [{ tool, granted: true, once }]);
      set({ toolGrants: next });
      await track("permission.grant_tool", { tool, once });
      return true;
    } catch (err) {
      await track("error", {
        stage: "grantTool",
        message: (err as Error).message,
      }).catch(() => undefined);
      return false;
    }
  },

  revokeTool: async (tool) => {
    const sessionId = get().activeSessionId;
    if (!get().liveMode) {
      set((s) => ({ toolGrants: s.toolGrants.filter((g) => g.tool !== tool) }));
      await track("permission.revoke_tool", { tool, mock: true });
      return true;
    }
    try {
      const client = await getAgentClient();
      const next = await client.setToolGrants(sessionId, [{ tool, granted: false, once: false }]);
      set({ toolGrants: next });
      await track("permission.revoke_tool", { tool });
      return true;
    } catch (err) {
      await track("error", {
        stage: "revokeTool",
        message: (err as Error).message,
      }).catch(() => undefined);
      return false;
    }
  },

  resolveApproval: async (callId, allowed) => {
    const sessionId = get().activeSessionId;
    if (!get().liveMode) {
      await track("permission.resolve_approval", { callId, allowed, mock: true });
      return true;
    }
    try {
      const client = await getAgentClient();
      await client.resolveApproval(sessionId, callId, allowed);
      await track("permission.resolve_approval", { callId, allowed });
      return true;
    } catch (err) {
      await track("error", {
        stage: "resolveApproval",
        message: (err as Error).message,
      }).catch(() => undefined);
      return false;
    }
  },

  retryApproval: async (callId) => {
    const sessionId = get().activeSessionId;
    if (!get().liveMode) {
      await track("permission.retry_approval", { callId, mock: true });
      return true;
    }
    const abort = new AbortController();
    currentAbort?.abort();
    currentAbort = abort;
    set({ streaming: true, isRunning: true, runId: `run-${Date.now()}` });
    await track("permission.retry_approval", { callId });
    try {
      const client = await getAgentClient();
      await consumeStream(client.retryApproval(sessionId, callId, abort.signal), set);
      return true;
    } catch (err) {
      appendErrorChat(set, "retryApproval", err);
      return false;
    } finally {
      if (currentAbort === abort) {
        currentAbort = null;
        set({ streaming: false, isRunning: false, runId: null });
      }
    }
  },

  cancelStream: () => {
    currentAbort?.abort();
    currentAbort = null;
    set({ streaming: false, isRunning: false, runId: null, agentPaused: false });
  },

  pauseAgent: () => {
    // Only meaningful while a run is active; gating happens in consumeStream.
    if (get().streaming || get().isRunning) set({ agentPaused: true });
  },
  resumeAgent: () => set({ agentPaused: false }),

  setAutonomy: (level) => set({ autonomy: level }),

  setAgentMode: (mode) => set({ agentMode: mode }),
  setSelectedModel: (m) => {
    // Drop any cached memory snapshot — it was computed against a
    // different model's context window, so showing it for the new model
    // would mislead the user. The next agent run / `loadMemoryStats`
    // call repopulates it; until then the indicator falls back to a
    // client-side estimate keyed on the new model's window.
    set({ selectedModel: m, memoryStats: null });
    // For local llama.cpp models the desktop shell owns the `llama-server`
    // subprocess. Tell it to (re)load the chosen .gguf so the weights end
    // up in VRAM — without this the picker would be cosmetic. Cloud models
    // don't need backend coordination.
    if (m.provider === "llamacpp" && m.model) {
      const local = loadLocalModels().find((lm) => lm.id === m.model);
      if (local) {
        const ngl = local.n_gpu_layers ?? DEFAULT_N_GPU_LAYERS;
        // Optimistic UI: clear stale error, mark as loading.
        set((s) => ({
          llamaCppStatus: {
            running: false,
            host: s.llamaCppStatus?.host ?? null,
            port: s.llamaCppStatus?.port ?? null,
            base_url: s.llamaCppStatus?.base_url ?? null,
            loaded_model_id: null,
            loaded_model_path: null,
            n_gpu_layers: ngl,
            n_ctx: local.n_ctx ?? null,
            n_threads: local.n_threads ?? null,
            n_batch: local.n_batch ?? null,
            temperature: local.temperature ?? DEFAULT_TEMPERATURE,
            top_p: local.top_p ?? DEFAULT_TOP_P,
            top_k: local.top_k ?? DEFAULT_TOP_K,
            repeat_penalty: local.repeat_penalty ?? DEFAULT_REPEAT_PENALTY,
            max_tokens: local.max_tokens ?? DEFAULT_MAX_TOKENS,
            flash_attn: local.flash_attn ?? null,
            last_error: null,
          },
        }));
        void llamacppLoad(
          local.id,
          local.path,
          ngl,
          local.n_ctx,
          local.n_threads,
          local.n_batch,
          local.flash_attn,
          local.temperature,
          local.top_p,
          local.top_k,
          local.repeat_penalty,
          local.max_tokens,
          local.host,
          local.port,
        )
          .then((status) => set({ llamaCppStatus: status }))
          .catch((err: unknown) => {
            const msg = err instanceof Error ? err.message : String(err);
            set((s) => ({
              llamaCppStatus: {
                running: false,
                host: s.llamaCppStatus?.host ?? null,
                port: s.llamaCppStatus?.port ?? null,
                base_url: s.llamaCppStatus?.base_url ?? null,
                loaded_model_id: null,
                loaded_model_path: null,
                n_gpu_layers: null,
                n_ctx: null,
                n_threads: null,
                n_batch: null,
                temperature: null,
                top_p: null,
                top_k: null,
                repeat_penalty: null,
                max_tokens: null,
                flash_attn: null,
                last_error: msg,
              },
            }));
          });
      }
    }
  },
  initLlamaCppStatus: async () => {
    if (!isTauri()) return;
    const snap = await llamacppStatus();
    if (snap) set({ llamaCppStatus: snap });
    // The unsubscribe is intentionally leaked — the store lives for the
    // lifetime of the page, and the listener is module-scoped.
    await onLlamaCppStatus((ev) => set({ llamaCppStatus: ev }));
  },
  addAttachment: (a) =>
    set((s) => ({ attachments: [...s.attachments, { id: `att-${Date.now()}`, ...a }] })),
  removeAttachment: (id) =>
    set((s) => ({ attachments: s.attachments.filter((a) => a.id !== id) })),
  clearAttachments: () => set({ attachments: [] }),
  toggleHunk: (diffId, hunkIndex) =>
    set((s) => {
      const set0 = new Set(s.acceptedHunks[diffId] ?? []);
      if (set0.has(hunkIndex)) set0.delete(hunkIndex);
      else set0.add(hunkIndex);
      return { acceptedHunks: { ...s.acceptedHunks, [diffId]: set0 } };
    }),
  acceptHunk: (diffId, hunkIndex) =>
    set((s) => {
      const set0 = new Set(s.acceptedHunks[diffId] ?? []);
      set0.add(hunkIndex);
      return { acceptedHunks: { ...s.acceptedHunks, [diffId]: set0 } };
    }),
  rejectHunk: (diffId, hunkIndex) =>
    set((s) => {
      const set0 = new Set(s.acceptedHunks[diffId] ?? []);
      set0.delete(hunkIndex);
      return { acceptedHunks: { ...s.acceptedHunks, [diffId]: set0 } };
    }),

  applyPatch: async (diffId) => {
    const patch = get().pendingPatches.find((p) => p.id === diffId);
    if (!patch) return false;
    let ok = true;
    if (isTauri()) {
      const root =
        get().workspaceRoot ??
        get().sessions.find((s) => s.id === get().activeSessionId)?.workspace_root ??
        null;
      if (!root) {
        await track("patch.rejected", { id: diffId, reason: "no_workspace" });
        return false;
      }
      const result = await tauriApplyPatch(root, patch.file_path, patch.unified_diff).catch(() => null);
      ok = result !== null;
    }
    if (ok) {
      await track("patch.applied", { file: patch.file_path });
      set((s) => {
        const nextApplied = new Set(s.appliedPatchIds).add(diffId);
        // Persist so a page reload still shows the patch as applied
        // (otherwise the user re-applies and the Tauri side rejects the
        // already-written hunks with a confusing error).
        persistAppliedPatchIds(nextApplied);
        return {
          pendingPatches: s.pendingPatches.filter((p) => p.id !== diffId),
          acceptedHunks: Object.fromEntries(
            Object.entries(s.acceptedHunks).filter(([k]) => k !== diffId),
          ),
          appliedPatchIds: nextApplied,
        };
      });
    }
    return ok;
  },
  rejectPatch: (diffId) => {
    void track("patch.rejected", { id: diffId });
    set((s) => ({
      pendingPatches: s.pendingPatches.filter((p) => p.id !== diffId),
      acceptedHunks: Object.fromEntries(
        Object.entries(s.acceptedHunks).filter(([k]) => k !== diffId),
      ),
    }));
  },
  acceptAllForDiff: (diffId) => get().applyPatch(diffId),
  rejectAllForDiff: (diffId) => get().rejectPatch(diffId),

  queueFindingPatch: (patch) => {
    set((s) =>
      s.pendingPatches.some((p) => p.id === patch.id)
        ? {}
        : { pendingPatches: [...s.pendingPatches, patch] },
    );
    void track("review.patch_queued", { id: patch.id, file: patch.file_path });
  },
  applyFindingPatch: async (patch) => {
    get().queueFindingPatch(patch);
    return get().applyPatch(patch.id);
  },


  createReplitPlan: async (prompt) => {
    if (!prompt.trim()) return null;
    set({ replitWorkflowLoading: true, replitWorkflowError: null });
    try {
      if (!get().liveMode) {
        const now = new Date().toISOString();
        const planId = `plan-${Date.now()}`;
        const likelyFiles = likelyFilesForPrompt(prompt);
        const plan: ReplitPlan = {
          id: planId,
          session_id: get().activeSessionId,
          title: prompt.slice(0, 64) || "Agent workflow plan",
          summary: "Offline preview: the desktop sidecar will run this as an isolated file-editing agent job.",
          status: "draft",
          created_at: now,
          updated_at: now,
          tasks: [
            {
              id: `task-${Date.now()}`,
              session_id: get().activeSessionId,
              plan_id: planId,
              title: "Run the requested change",
              summary: prompt,
              status: "draft",
              priority: "high",
              depends_on: [],
              files_likely_changed: likelyFiles,
              done_looks_like: ["Requested files are created or updated", "The result can be reviewed from chat"],
              test_plan: ["Run the strongest available validation"],
              validation_attempts: 0,
              created_at: now,
              updated_at: now,
            },
          ],
        };
        set((s) => ({
          replitPlans: [plan, ...s.replitPlans],
          replitTasks: [...plan.tasks, ...s.replitTasks],
          selectedReplitTaskId: plan.tasks[0]?.id ?? s.selectedReplitTaskId,
          replitWorkflowLoading: false,
          agentItems: upsertWorkflowPlan(s.agentItems, plan),
          activity: s.activity === "tasks" ? "files" : s.activity,
          mainView: "editor",
          layout: { ...s.layout, sidePanelOpen: true, rightPanelOpen: true },
        }));
        return plan;
      }
      const client = await getAgentClient();
      // Ensure a valid backend session exists before creating a plan.
      const sid = await ensureBackendSession(client, get, set);
      const plan = await client.createReplitPlan(sid, prompt);
      set((s) => ({
        replitPlans: [plan, ...s.replitPlans.filter((p) => p.id !== plan.id)],
        replitTasks: mergeTasks(s.replitTasks, plan.tasks),
        selectedReplitTaskId: plan.tasks[0]?.id ?? s.selectedReplitTaskId,
        agentItems: upsertWorkflowPlan(s.agentItems, plan),
        activity: s.activity === "tasks" ? "files" : s.activity,
        mainView: "editor",
        layout: { ...s.layout, sidePanelOpen: true, rightPanelOpen: true },
      }));
      await track("replit.plan.created", { id: plan.id, tasks: plan.tasks.length });
      return plan;
    } catch (err) {
      const message = (err as Error).message;
      set({ replitWorkflowError: message });
      await track("error", { stage: "createReplitPlan", message }).catch(() => undefined);
      return null;
    } finally {
      set({ replitWorkflowLoading: false });
    }
  },

  reviseReplitPlan: async (planId, prompt) => {
    if (!prompt.trim()) return null;
    set({ replitWorkflowLoading: true, replitWorkflowError: null });
    try {
      if (!get().liveMode) {
        const archivedAt = new Date().toISOString();
        const revised = await get().createReplitPlan(prompt);
        set((s) => ({
          replitPlans: s.replitPlans.map((p) =>
            p.id === planId ? { ...p, status: "archived", updated_at: archivedAt } : p,
          ),
          agentItems: s.agentItems.map((item) =>
            item.type === "plan" && item.id === `plan-${planId}`
              ? { ...item, status: "cancelled" as const }
              : item,
          ),
        }));
        return revised;
      }
      const client = await getAgentClient();
      const plan = await client.reviseReplitPlan(get().activeSessionId, planId, { prompt });
      set((s) => ({
        replitPlans: [plan, ...s.replitPlans.map((p) => p.id === planId ? { ...p, status: "archived" as const } : p).filter((p) => p.id !== plan.id)],
        replitTasks: mergeTasks(s.replitTasks, plan.tasks),
        selectedReplitTaskId: plan.tasks[0]?.id ?? s.selectedReplitTaskId,
        agentItems: upsertWorkflowPlan(
          s.agentItems.map((item) =>
            item.type === "plan" && item.id === `plan-${planId}`
              ? { ...item, status: "cancelled" as const }
              : item,
          ),
          plan,
        ),
      }));
      await track("replit.plan.revised", { id: planId, newId: plan.id });
      return plan;
    } catch (err) {
      const message = (err as Error).message;
      set({ replitWorkflowError: message });
      await track("error", { stage: "reviseReplitPlan", message }).catch(() => undefined);
      return null;
    } finally {
      set({ replitWorkflowLoading: false });
    }
  },

  approveReplitPlan: async (planId) => {
    set({ replitWorkflowLoading: true, replitWorkflowError: null });
    try {
      if (!get().liveMode) {
        set((s) => ({
          replitPlans: s.replitPlans.map((p) =>
            p.id === planId ? { ...p, status: "approved", tasks: p.tasks.map((t) => ({ ...t, status: "queued" })) } : p,
          ),
          replitTasks: s.replitTasks.map((t) =>
            t.plan_id === planId && t.status === "draft" ? { ...t, status: "queued" } : t,
          ),
          agentItems: s.replitPlans
            .find((p) => p.id === planId)
            ?.tasks.map((t) => ({ ...t, status: "queued" as const }))
            .reduce(
              (items, task) => upsertWorkflowTask(items, task),
              s.agentItems.map((item) =>
                item.type === "plan" && item.id === `plan-${planId}`
                  ? { ...item, status: "approved" as const }
                  : item,
              ),
            ) ?? s.agentItems,
        }));
        return true;
      }
      const client = await getAgentClient();
      const plan = await client.approveReplitPlan(get().activeSessionId, planId);
      set((s) => ({
        replitPlans: [plan, ...s.replitPlans.filter((p) => p.id !== plan.id)],
        replitTasks: mergeTasks(s.replitTasks, plan.tasks),
        agentItems: plan.tasks.reduce(
          (items, task) => upsertWorkflowTask(items, task),
          upsertWorkflowPlan(s.agentItems, plan),
        ),
        selectedReplitTaskId: plan.tasks[0]?.id ?? s.selectedReplitTaskId,
        activity: s.activity === "tasks" ? "files" : s.activity,
        mainView: "editor",
        layout: { ...s.layout, sidePanelOpen: true, rightPanelOpen: true },
      }));
      await track("replit.plan.approved", { id: planId });
      return true;
    } catch (err) {
      const message = (err as Error).message;
      set({ replitWorkflowError: message });
      return false;
    } finally {
      set({ replitWorkflowLoading: false });
    }
  },

  loadReplitWorkflow: async () => {
    if (!get().liveMode) return;
    try {
      const client = await getAgentClient();
      const sessionId = get().activeSessionId;
      const [plans, tasks, checkpoints] = await Promise.all([
        client.listReplitPlans(sessionId),
        client.listReplitTasks(sessionId),
        client.listReplitCheckpoints(sessionId),
      ]);
      set((s) => ({
        replitPlans: plans,
        replitTasks: tasks,
        replitCheckpoints: checkpoints,
        agentItems: tasks.reduce(
          (items, task) => upsertWorkflowTask(items, task),
          plans.reduce((items, plan) => upsertWorkflowPlan(items, plan), s.agentItems),
        ),
        selectedReplitTaskId:
          s.selectedReplitTaskId && tasks.some((t) => t.id === s.selectedReplitTaskId)
            ? s.selectedReplitTaskId
            : tasks[0]?.id ?? null,
      }));
    } catch {
      /* endpoint may not exist in older sidecars */
    }
  },

  createReplitTask: async (req) => {
    set({ replitWorkflowLoading: true, replitWorkflowError: null });
    try {
      if (!get().liveMode) {
        const now = new Date().toISOString();
        const task: ReplitTask = {
          id: `task-${Date.now()}`,
          session_id: get().activeSessionId,
          plan_id: null,
          title: req.title,
          summary: req.summary ?? "Manual Replit-style task",
          status: "draft",
          priority: req.priority ?? "medium",
          depends_on: [],
          files_likely_changed: req.files_likely_changed ?? [],
          done_looks_like: req.done_looks_like ?? [],
          test_plan: req.test_plan ?? [],
          validation_attempts: 0,
          created_at: now,
          updated_at: now,
        };
        set((s) => ({
          replitTasks: mergeTasks(s.replitTasks, [task]),
          selectedReplitTaskId: task.id,
          agentItems: upsertWorkflowTask(s.agentItems, task),
        }));
        return task;
      }
      const client = await getAgentClient();
      const task = await client.createReplitTask(get().activeSessionId, req);
      set((s) => ({
        replitTasks: mergeTasks(s.replitTasks, [task]),
        selectedReplitTaskId: task.id,
        agentItems: upsertWorkflowTask(s.agentItems, task),
      }));
      return task;
    } catch (err) {
      set({ replitWorkflowError: (err as Error).message });
      return null;
    } finally {
      set({ replitWorkflowLoading: false });
    }
  },

  selectReplitTask: async (taskId) => {
    set({ selectedReplitTaskId: taskId });
    if (!taskId || !get().liveMode) return;
    try {
      const client = await getAgentClient();
      const sessionId = get().activeSessionId;
      const [logs, diff, tests] = await Promise.all([
        client.replitTaskLogs(sessionId, taskId),
        client.replitTaskDiff(sessionId, taskId),
        client.replitTaskTestResults(sessionId, taskId),
      ]);
      set((s) => ({
        replitTaskLogs: { ...s.replitTaskLogs, [taskId]: logs },
        replitTasks: s.replitTasks.map((t) =>
          t.id === taskId ? { ...t, diff: diff.diff, test_output: tests.output } : t,
        ),
        agentItems: s.replitTasks
          .filter((t) => t.id === taskId)
          .map((t) => ({ ...t, diff: diff.diff, test_output: tests.output }))
          .reduce((items, task) => upsertWorkflowTask(items, task), s.agentItems),
      }));
    } catch {
      /* keep cached */
    }
  },

  queueReplitTask: async (taskId) => {
    set({ replitWorkflowLoading: true, replitWorkflowError: null, selectedReplitTaskId: taskId });
    try {
      if (!get().liveMode) {
        const now = new Date().toISOString();
        set((s) => ({
          replitTasks: s.replitTasks.map((task) =>
            task.id === taskId ? { ...task, status: "queued", updated_at: now } : task,
          ),
          agentItems: s.replitTasks
            .filter((task) => task.id === taskId)
            .map((task) => ({ ...task, status: "queued" as const, updated_at: now }))
            .reduce((items, task) => upsertWorkflowTask(items, task), s.agentItems),
          replitTaskLogs: {
            ...s.replitTaskLogs,
            [taskId]: [
              ...(s.replitTaskLogs[taskId] ?? []),
              { id: `log-${Date.now()}`, task_id: taskId, level: "info", message: "Task queued. Start the desktop sidecar for real execution.", created_at: now },
            ],
          },
        }));
        return true;
      }
      const client = await getAgentClient();
      const task = await client.queueReplitTask(get().activeSessionId, taskId);
      set((s) => ({
        replitTasks: mergeTasks(s.replitTasks, [task]),
        agentItems: upsertWorkflowTask(s.agentItems, task),
        selectedReplitTaskId: task.id,
        activity: s.activity === "tasks" ? "files" : s.activity,
        mainView: "editor",
        layout: { ...s.layout, sidePanelOpen: true, rightPanelOpen: true },
      }));
      await get().selectReplitTask(taskId);
      await track("replit.task.queued", { id: taskId });
      return true;
    } catch (err) {
      set({ replitWorkflowError: (err as Error).message });
      return false;
    } finally {
      set({ replitWorkflowLoading: false });
    }
  },

  startReplitTask: async (taskId) => {
    set({
      replitWorkflowLoading: true,
      replitWorkflowError: null,
      selectedReplitTaskId: taskId,
    });
    try {
      if (!get().liveMode) {
        const now = new Date().toISOString();
        set((s) => ({
          replitTasks: s.replitTasks.map((task) =>
            task.id === taskId ? { ...task, status: "active", updated_at: now } : task,
          ),
          agentItems: s.replitTasks
            .filter((task) => task.id === taskId)
            .map((task) => ({ ...task, status: "active" as const, updated_at: now }))
            .reduce((items, task) => upsertWorkflowTask(items, task), s.agentItems),
          replitTaskLogs: {
            ...s.replitTaskLogs,
            [taskId]: [
              ...(s.replitTaskLogs[taskId] ?? []),
              { id: `log-${Date.now()}`, task_id: taskId, level: "info", message: "Mock isolated task started.", created_at: now },
            ],
          },
        }));
        return true;
      }
      const client = await getAgentClient();
      const task = await client.startReplitTask(get().activeSessionId, taskId);
      set((s) => ({
        replitTasks: mergeTasks(s.replitTasks, [task]),
        agentItems: upsertWorkflowTask(s.agentItems, task),
        selectedReplitTaskId: task.id,
        activity: s.activity === "tasks" ? "files" : s.activity,
        mainView: "editor",
        layout: { ...s.layout, sidePanelOpen: true, rightPanelOpen: true },
      }));
      await track("replit.task.started", { id: taskId });
      pollReplitTaskUntilSettled(taskId);
      return true;
    } catch (err) {
      set({ replitWorkflowError: (err as Error).message });
      return false;
    } finally {
      set({ replitWorkflowLoading: false });
    }
  },

  markReplitTaskReady: async (taskId) => {
    set({ replitWorkflowLoading: true, replitWorkflowError: null, selectedReplitTaskId: taskId });
    try {
      if (!get().liveMode) {
        set({ replitWorkflowError: "Desktop sidecar required: ready status needs real diff and NO ERROR validation." });
        return false;
      }
      const client = await getAgentClient();
      const task = await client.markReplitTaskReady(get().activeSessionId, taskId);
      set((s) => ({
        replitTasks: mergeTasks(s.replitTasks, [task]),
        agentItems: upsertWorkflowTask(s.agentItems, task),
      }));
      await get().selectReplitTask(taskId);
      await track("replit.task.ready", { id: taskId });
      return true;
    } catch (err) {
      set({ replitWorkflowError: (err as Error).message });
      return false;
    } finally {
      set({ replitWorkflowLoading: false });
    }
  },

  applyReplitTask: async (taskId) => {
    set({ replitWorkflowLoading: true, replitWorkflowError: null });
    try {
      if (!get().liveMode) {
        const now = new Date().toISOString();
        set((s) => ({
          replitTasks: s.replitTasks.map((task) =>
            task.id === taskId ? { ...task, status: "done", updated_at: now } : task,
          ),
          agentItems: s.replitTasks
            .filter((task) => task.id === taskId)
            .map((task) => ({ ...task, status: "done" as const, updated_at: now }))
            .reduce((items, task) => upsertWorkflowTask(items, task), s.agentItems),
          replitCheckpoints: [
            {
              id: `checkpoint-${Date.now()}`,
              session_id: get().activeSessionId,
              task_id: taskId,
              label: "Mock checkpoint before apply",
              snapshot_path: ".mock/checkpoint",
              files: ["mock-file.ts"],
              created_at: now,
            },
            ...s.replitCheckpoints,
          ],
        }));
        return true;
      }
      const client = await getAgentClient();
      const task = await client.applyReplitTask(get().activeSessionId, taskId);
      set((s) => ({
        replitTasks: mergeTasks(s.replitTasks, [task]),
        agentItems: upsertWorkflowTask(s.agentItems, task),
      }));
      await get().loadReplitWorkflow();
      await track("replit.task.applied", { id: taskId });
      return true;
    } catch (err) {
      set({ replitWorkflowError: (err as Error).message });
      return false;
    } finally {
      set({ replitWorkflowLoading: false });
    }
  },

  dismissReplitTask: async (taskId) => {
    set({ replitWorkflowLoading: true, replitWorkflowError: null });
    try {
      if (!get().liveMode) {
        const now = new Date().toISOString();
        set((s) => ({
          replitTasks: s.replitTasks.map((task) =>
            task.id === taskId ? { ...task, status: "dismissed", updated_at: now } : task,
          ),
          agentItems: s.replitTasks
            .filter((task) => task.id === taskId)
            .map((task) => ({ ...task, status: "dismissed" as const, updated_at: now }))
            .reduce((items, task) => upsertWorkflowTask(items, task), s.agentItems),
        }));
        return true;
      }
      const client = await getAgentClient();
      const task = await client.dismissReplitTask(get().activeSessionId, taskId);
      set((s) => ({
        replitTasks: mergeTasks(s.replitTasks, [task]),
        agentItems: upsertWorkflowTask(s.agentItems, task),
      }));
      return true;
    } catch (err) {
      set({ replitWorkflowError: (err as Error).message });
      return false;
    } finally {
      set({ replitWorkflowLoading: false });
    }
  },

  cancelReplitTask: async (taskId) => {
    set({ replitWorkflowLoading: true, replitWorkflowError: null });
    try {
      if (!get().liveMode) {
        const now = new Date().toISOString();
        set((s) => ({
          replitTasks: s.replitTasks.map((task) =>
            task.id === taskId ? { ...task, status: "cancelled", updated_at: now } : task,
          ),
          agentItems: s.replitTasks
            .filter((task) => task.id === taskId)
            .map((task) => ({ ...task, status: "cancelled" as const, updated_at: now }))
            .reduce((items, task) => upsertWorkflowTask(items, task), s.agentItems),
        }));
        return true;
      }
      const client = await getAgentClient();
      const task = await client.cancelReplitTask(get().activeSessionId, taskId);
      set((s) => ({
        replitTasks: mergeTasks(s.replitTasks, [task]),
        agentItems: upsertWorkflowTask(s.agentItems, task),
      }));
      return true;
    } catch (err) {
      set({ replitWorkflowError: (err as Error).message });
      return false;
    } finally {
      set({ replitWorkflowLoading: false });
    }
  },

  rollbackReplitCheckpoint: async (checkpointId) => {
    set({ replitWorkflowLoading: true, replitWorkflowError: null });
    try {
      if (!get().liveMode) {
        await track("replit.checkpoint.rollback", { id: checkpointId, mock: true });
        return true;
      }
      const client = await getAgentClient();
      await client.rollbackReplitCheckpoint(get().activeSessionId, checkpointId);
      await track("replit.checkpoint.rollback", { id: checkpointId });
      return true;
    } catch (err) {
      set({ replitWorkflowError: (err as Error).message });
      return false;
    } finally {
      set({ replitWorkflowLoading: false });
    }
  },

  clearReplitWorkflowError: () => set({ replitWorkflowError: null }),

  loadMemoryStats: async () => {
    if (!get().liveMode) return;
    try {
      const client = await getAgentClient();
      const stats = await client.memoryStats(get().activeSessionId);
      set({ memoryStats: stats });
    } catch {
      // Sidecar offline / endpoint missing — leave stats untouched so the
      // indicator just hides itself.
    }
  },

  loadContextStatus: async () => {
    if (!get().liveMode) return;
    try {
      const client = await getAgentClient();
      const status = await client.contextStatus(get().activeSessionId);
      set({ contextStatus: status });
    } catch {
      // Sidecar offline / endpoint missing — leave status untouched.
    }
  },
  compactMemory: async () => {
    if (!get().liveMode) return;
    try {
      const client = await getAgentClient();
      const stats = await client.compactMemory(get().activeSessionId);
      set({ memoryStats: stats });
      await track("memory.compacted", { id: get().activeSessionId });
    } catch (err) {
      await track("error", {
        stage: "compactMemory",
        message: (err as Error).message,
      }).catch(() => undefined);
    }
  },
  forgetMemory: async (keepLast = 20) => {
    if (!get().liveMode) return;
    try {
      const client = await getAgentClient();
      const stats = await client.forgetMemory(get().activeSessionId, keepLast);
      set({ memoryStats: stats });
      await track("memory.forgotten", { id: get().activeSessionId, keepLast });
    } catch (err) {
      await track("error", {
        stage: "forgetMemory",
        message: (err as Error).message,
      }).catch(() => undefined);
    }
  },

  setLayoutSizes: (sizes) => {
    const layout = sanitizeLayout({ ...get().layout, ...sizes });
    persistLayout(layout);
    set({ layout });
  },
}));

interface AgentEventHandlers {
  startRun: (message?: string | null) => void;
  contextLoading: (message?: string | null) => void;
  contextReady: (message?: string | null) => void;
  ensureAssistant: () => string;
  appendDelta: (delta: string) => void;
  replaceMessage: (m: Message) => void;
  addToolCall: (tc: ToolCall) => void;
  addDiff: (p: DiffPatch) => void;
  setPlan: (p: Plan) => void;
  updatePlanStep: (step: PlanStep) => void;
  addTask: (task: ReplitTask) => void;
  setTodos: (todos: TodoItem[]) => void;
  addTestRun: (result: AgentTestRun) => void;
  addFinalSummary: (summary: string) => void;
  addError: (message: string) => void;
}

function applyAgentEvent(ev: AgentEvent, h: AgentEventHandlers): void {
  switch (ev.type) {
    case "agent.started":
      h.startRun(ev.message);
      break;
    case "agent.context.loading":
      h.contextLoading(ev.message);
      break;
    case "agent.context.ready":
      h.contextReady(ev.message);
      break;
    case "token":
    case "message.delta":
      h.ensureAssistant();
      h.appendDelta(ev.delta);
      break;
    case "message":
      h.replaceMessage(ev.message);
      break;
    case "tool_call":
    case "tool.started":
    case "tool.completed":
      h.addToolCall(ev.tool_call);
      break;
    case "diff":
      h.addDiff(ev.patch);
      break;
    case "plan":
    case "plan.created":
      h.setPlan(ev.plan);
      break;
    case "task.created":
      h.addTask(ev.task);
      break;
    case "todo_update":
      h.setTodos(ev.todos);
      break;
    case "test.started":
      h.addTestRun({
        id: `test-${ev.seq || Date.now()}-${ev.name}`,
        name: ev.name,
        command: ev.command,
        status: "running",
        output: ev.output,
        result: null,
      });
      break;
    case "test.completed":
      h.addTestRun({
        id: `test-${ev.seq || Date.now()}-${ev.name}`,
        name: ev.name,
        command: ev.command,
        status: ev.ok ? "passed" : "failed",
        output: ev.output,
        result: null,
      });
      break;
    case "agent.completed":
      h.addFinalSummary(ev.detail || ev.message || "Agent run completed.");
      break;
    case "error":
      h.addError(`${ev.message}${ev.detail ? `\n${ev.detail}` : ""}`);
      break;
    case "agent.error":
      h.addError(`${ev.message ?? "Agent error"}${ev.detail ? `\n${ev.detail}` : ""}`);
      break;
    case "plan_step":
      h.updatePlanStep(ev.step);
      break;
    case "log":
    case "done":
      if (ev.type === "done" && ev.summary) h.addFinalSummary(ev.summary);
      break;
    // Unified run lifecycle (Part 4). Emitted additively alongside the
    // legacy agent.* / diff events the UI already renders, so during the
    // migration these are intentionally no-ops here to avoid duplicate
    // cards. A future single AgentRunCard will consume them directly.
    case "run.started":
    case "run.context_ready":
    case "run.awaiting_review":
    case "run.applied":
    case "run.discarded":
    case "run.error":
    case "checkpoint.created":
    case "diff.ready":
      break;
    default:
      break;
  }
}

type SetState = (
  partial: Partial<AppState> | ((s: AppState) => Partial<AppState>),
) => void;

/**
 * Drain an `AgentEvent` async-iterable into the store. Used by both
 * `sendUserMessage` (free-form prompt) and `runSlashCommand` so the chat,
 * tool stream, plan timeline and diff queue are updated uniformly.
 *
 * Tracks `tool_call` updates by id so subsequent status changes
 * (`pending` → `needs_approval` → `succeeded`) replace the existing card
 * rather than appending a duplicate.
 */
async function consumeStream(
  stream: AsyncIterable<AgentEvent>,
  set: SetState,
): Promise<void> {
  let assistantId: string | null = null;
  let assistantText = "";
  let streamRunId = `run-${Date.now()}`;
  let sawWorkflowArtifact = false;
  const ensureAssistant = () => {
    if (assistantId) return assistantId;
    assistantId = `assistant-${Date.now()}`;
    assistantText = "";
    const msg: Message = {
      id: assistantId,
      role: "assistant",
      content: "",
      created_at: new Date().toISOString(),
    };
    set((s) => ({
      chat: [...s.chat, { kind: "message", id: assistantId!, message: msg }],
      agentItems: upsertWorkflowMessage(s.agentItems, msg, true),
    }));
    return assistantId;
  };
  const finishAssistant = () => {
    if (!assistantId) return;
    const id = assistantId;
    set((s) => ({
      agentItems: s.agentItems.map((item) =>
        item.id === id && item.type === "agent_message"
          ? { ...item, streaming: false }
          : item,
      ),
    }));
  };
  try {
    for await (const ev of stream) {
      // Real pause-gating (R7.3, bug #1): while the user has paused the run,
      // hold the received event without applying it. `cancelStream` clears the
      // pause flag (and aborts the stream) so a stop during pause unblocks.
      while (useApp.getState().agentPaused) {
        await new Promise((resolve) => setTimeout(resolve, 120));
      }
      applyAgentEvent(ev, {
        startRun: () => {
          streamRunId = `run-${ev.seq || Date.now()}`;
          set({ runId: streamRunId, isRunning: true });
        },
        contextLoading: (message) => {
          set((s) => ({
            agentItems: upsertWorkflowItem(s.agentItems, {
              type: "workspace_analysis",
              id: `${streamRunId}-context`,
              summary: message || "Loading workspace context.",
              files: [],
              issues: [],
              nextSteps: ["Inspecting open files and workspace metadata"],
              status: "loading",
              createdAt: ev.at,
            }),
          }));
        },
        contextReady: (message) => {
          set((s) => {
            const active = s.openFiles.find((file) => file.path === s.activeFile);
            return {
              agentItems: upsertWorkflowItem(s.agentItems, {
                type: "workspace_analysis",
                id: `${streamRunId}-context`,
                summary: message || "Workspace context ready.",
                files: s.openFiles.slice(0, 6).map((file) => file.path),
                issues: [],
                nextSteps: active
                  ? [`Using active editor: ${active.path}`, "Streaming the agent response inline"]
                  : ["Streaming the agent response inline"],
                status: "ready",
                createdAt: ev.at,
              }),
            };
          });
        },
        ensureAssistant,
        appendDelta: (delta) => {
          const id = assistantId!;
          assistantText += delta;
          set((s) => ({
            chat: s.chat.map((e) =>
              e.id === id && e.message
                ? { ...e, message: { ...e.message, content: assistantText } }
                : e,
            ),
            agentItems: s.agentItems.map((item) =>
              item.id === id && item.type === "agent_message"
                ? { ...item, text: assistantText, streaming: true }
                : item,
            ),
          }));
        },
        replaceMessage: (m) => {
          const previousAssistantId = assistantId;
          if (m.role === "assistant") {
            assistantId = m.id;
            assistantText = m.content;
          }
          set((s) => {
            if (
              m.role === "assistant" &&
              previousAssistantId &&
              previousAssistantId !== m.id
            ) {
              const idx = s.chat.findIndex((e) => e.id === previousAssistantId);
              if (idx >= 0) {
                const next = [...s.chat];
                next[idx] = { kind: "message", id: m.id, message: m };
                return {
                  chat: next,
                  agentItems: upsertWorkflowMessage(
                    removeWorkflowItem(s.agentItems, previousAssistantId),
                    m,
                  ),
                };
              }
            }
            const idx = s.chat.findIndex((e) => e.id === m.id);
            if (idx >= 0) {
              const next = [...s.chat];
              next[idx] = { kind: "message", id: m.id, message: m };
              return { chat: next, agentItems: upsertWorkflowMessage(s.agentItems, m) };
            }
            if (m.role === "user") {
              for (let i = s.chat.length - 1; i >= 0; i -= 1) {
                const entry = s.chat[i];
                if (
                  entry.kind === "message" &&
                  entry.message?.role === "user" &&
                  entry.message.content.trim() === m.content.trim() &&
                  entry.id.startsWith("local-")
                ) {
                  const next = [...s.chat];
                  next[i] = { kind: "message", id: m.id, message: m };
                  return {
                    chat: next,
                    agentItems: upsertWorkflowMessage(removeWorkflowItem(s.agentItems, entry.id), m),
                  };
                }
              }
            }
            return {
              chat: [...s.chat, { kind: "message", id: m.id, message: m }],
              agentItems: upsertWorkflowMessage(s.agentItems, m),
            };
          });
        },
        addToolCall: (tc) => {
          sawWorkflowArtifact = true;
          set((s) => {
            const idx = s.chat.findIndex((e) => e.id === tc.id);
            if (idx >= 0) {
              const next = [...s.chat];
              next[idx] = { kind: "tool_call", id: tc.id, toolCall: tc };
              return { chat: next, agentItems: upsertWorkflowTool(s.agentItems, tc) };
            }
            return {
              chat: [...s.chat, { kind: "tool_call", id: tc.id, toolCall: tc }],
              agentItems: upsertWorkflowTool(s.agentItems, tc),
            };
          });
        },
        addDiff: (p) => {
          sawWorkflowArtifact = true;
          set((s) => {
            const idx = s.chat.findIndex((e) => e.id === p.id);
            const nextChat =
              idx >= 0
                ? s.chat.map((e, i) => (i === idx ? { kind: "diff" as const, id: p.id, diff: p } : e))
                : [...s.chat, { kind: "diff" as const, id: p.id, diff: p }];
            const nextPending = s.pendingPatches.some((q) => q.id === p.id)
              ? s.pendingPatches.map((q) => (q.id === p.id ? p : q))
              : [...s.pendingPatches, p];
            return {
              chat: nextChat,
              pendingPatches: nextPending,
              agentItems: upsertWorkflowItem(s.agentItems, {
                type: "diff",
                id: p.id,
                patch: p,
                createdAt: new Date().toISOString(),
              }),
            };
          });
        },
        setPlan: (p) => {
          if (isPlaceholderPlan(p)) return;
          sawWorkflowArtifact = true;
          set((s) => ({
            plan: p,
            agentItems: upsertWorkflowPlan(s.agentItems, p),
          }));
        },
        updatePlanStep: (step) => {
          set((s) => {
            if (!s.plan) return {};
            const plan = {
              ...s.plan,
              steps: s.plan.steps.map((existing) =>
                existing.id === step.id ? { ...existing, ...step } : existing,
              ),
            };
            if (isPlaceholderPlan(plan)) return {};
            sawWorkflowArtifact = true;
            return {
              plan,
              agentItems: upsertWorkflowPlan(s.agentItems, plan),
            };
          });
        },
        addTask: (task) => {
          sawWorkflowArtifact = true;
          set((s) => ({
            replitTasks: mergeTasks(s.replitTasks, [task]),
            selectedReplitTaskId: s.selectedReplitTaskId ?? task.id,
            agentItems: upsertWorkflowTask(s.agentItems, task),
          }));
        },
        setTodos: (todos) => {
          sawWorkflowArtifact = true;
          set((s) => ({
            agentItems: upsertWorkflowItem(s.agentItems, {
              type: "todos",
              id: `${streamRunId}-todos`,
              todos,
              createdAt: new Date().toISOString(),
            }),
          }));
        },
        addTestRun: (result) => {
          sawWorkflowArtifact = true;
          set((s) => ({ agentItems: upsertWorkflowTest(s.agentItems, result) }));
        },
        addFinalSummary: (summary) => {
          const trimmed = summary.trim();
          if (!trimmed) return;
          const answer = assistantText.trim();
          if (answer && (!sawWorkflowArtifact || sameText(answer, trimmed))) return;
          set((s) => ({
            agentItems: upsertWorkflowItem(s.agentItems, {
              type: "final_summary",
              id: `${streamRunId}-final`,
              summary: trimmed,
              createdAt: new Date().toISOString(),
            }),
          }));
        },
        addError: (message) => {
          appendErrorChat(set, "agent.event", new Error(message));
        },
      });
    }
  } finally {
    finishAssistant();
  }
}


function mergeTasks(existing: ReplitTask[], incoming: ReplitTask[]): ReplitTask[] {
  const byId = new Map(existing.map((task) => [task.id, task]));
  for (const task of incoming) byId.set(task.id, { ...byId.get(task.id), ...task });
  return Array.from(byId.values()).sort(
    (a, b) => Date.parse(a.created_at) - Date.parse(b.created_at),
  );
}

function pollReplitTaskUntilSettled(taskId: string, attempts = 0): void {
  const delay = Math.min(2500 + attempts * 750, 8000);
  window.setTimeout(() => {
    const state = useApp.getState();
    void state.loadReplitWorkflow().then(() => state.selectReplitTask(taskId)).then(() => {
      const task = useApp.getState().replitTasks.find((item) => item.id === taskId);
      if (task?.status === "active" && attempts < 60) pollReplitTaskUntilSettled(taskId, attempts + 1);
    });
  }, delay);
}

function appendAssistantSummary(set: SetState, content: string): void {
  const id = `assistant-${Date.now()}`;
  const message: Message = {
    id,
    role: "assistant",
    content,
    created_at: new Date().toISOString(),
  };
  set((s) => ({
    chat: [...s.chat, { kind: "message", id, message }],
    agentItems: upsertWorkflowMessage(s.agentItems, message),
  }));
}

function appendErrorChat(set: SetState, stage: string, err: unknown): void {
  const message =
    err instanceof DOMException && err.name === "AbortError"
      ? "(cancelled)"
      : `Error: ${(err as Error).message}`;
  const id = `err-${Date.now()}`;
  set((s) => ({
    chat: [
      ...s.chat,
      {
        kind: "message",
        id,
        message: {
          id,
          role: "system",
          content: message,
          created_at: new Date().toISOString(),
        },
      },
    ],
    agentItems: appendWorkflowError(s.agentItems, message),
  }));
  void track("error", { stage, message }).catch(() => undefined);
}

/**
 * Maps each slash command to the single string field its backend recipe
 * expects (see `services/agent/src/llama_studio_agent/commands/recipes.py`).
 * `review`, `test`, `explain`, `refactor`, `docs` use `target`; `fix`,
 * `grok` use `query`. Anything else falls through as a normal prompt.
 */
const SLASH_ARG_FIELD: Record<SlashCommandName, "target" | "query"> = {
  review: "target",
  test: "target",
  explain: "target",
  refactor: "target",
  docs: "target",
  fix: "query",
  grok: "query",
};

/**
 * Parse a composer string like `"/test src/foo.ts"` into a slash command
 * name and an `args` payload matching the backend's per-command schema.
 * Returns `null` if the input isn't a recognised slash command so it
 * falls through to a normal prompt.
 */
/**
 * Build `excerpts` for `/v1/sessions/{id}/review` from currently open
 * editor buffers — gives the panel something to chew on when the user
 * triggers a review without typing a path or staged diff.
 */
function collectExcerptsForReview(state: AppState): Array<[string, string]> {
  const open = state.openFiles.slice(0, 3);
  return open.map((f) => [f.path, f.content] as [string, string]);
}

function activeWorkspaceRoot(state: AppState): string | null {
  return (
    state.workspaceRoot ??
    state.sessions.find((s) => s.id === state.activeSessionId)?.workspace_root ??
    null
  );
}

/**
 * Ensure a real backend session id exists before hitting session-scoped
 * endpoints. Only acts when the id is genuinely missing — a real session
 * (created by `loadSessions` or `createSession`) is used as-is. If the
 * client can't create a session (e.g. a partial mock in tests), the
 * original id is returned unchanged so callers still function.
 */
async function ensureBackendSession(
  client: AgentClient,
  get: () => AppState,
  set: SetState,
): Promise<string> {
  const current = get().activeSessionId;
  if (current) return current;
  if (typeof client.createSession !== "function") return current;
  const workspaceRoot = activeWorkspaceRoot(get()) || "/tmp";
  const { provider, model } = get().selectedModel;
  const session = await client.createSession({
    title: "Agent Session",
    workspace_root: workspaceRoot,
    provider: provider || undefined,
    model: model || undefined,
  });
  set((s) => ({
    sessions: [session, ...s.sessions.filter((x) => x.id !== session.id)],
    activeSessionId: session.id,
    liveMode: true,
  }));
  return session.id;
}

function activeEditorFile(state: AppState): OpenFile | null {
  return state.openFiles.find((f) => f.path === state.activeFile) ?? null;
}

function expandFileMentions(content: string, state: AppState): string {
  const active = state.activeFile;
  if (!active || !content.includes("@file")) return content;
  return content.replaceAll("@file", active);
}

type WorkflowIntent = {
  prompt: string;
  autoApprove: boolean;
  existingPlanId?: string;
};

function workflowIntentForMessage(content: string, state: AppState): WorkflowIntent | null {
  const trimmed = content.trim();
  if (!trimmed || trimmed.startsWith("/")) return null;
  const normalized = normalizeIntent(trimmed);

  // Only treat a message as an approval intent if it's an explicit
  // approval phrase AND there's a draft plan waiting. Never auto-approve
  // just because the message starts with a "build" verb — that creates
  // a brand new plan instead.
  const pendingReplit = latestDraftReplitPlan(state);
  if (isApprovalIntent(normalized) && pendingReplit) {
    return {
      prompt: promptFromReplitPlan(pendingReplit),
      autoApprove: true,
      existingPlanId: pendingReplit.id,
    };
  }

  // A free-form build request (no pending plan) creates a new plan
  // but does NOT auto-approve — the user must explicitly approve.
  if (isBuildRequest(normalized)) {
    return { prompt: trimmed, autoApprove: false };
  }
  return null;
}

function normalizeIntent(value: string): string {
  return value
    .toLowerCase()
    .replace(/[`"'.,!?;:()[\]{}]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function isApprovalIntent(normalized: string): boolean {
  return (
    /^(ok|okay|yes|yep|yeah|sure|approved?|confirm|go ahead|please)\s+(implement|build|create|make|start|run|execute|continue|do)\b/.test(normalized) ||
    /^(implement|build|create|make|start|run|execute)\s+(this|it|that|the plan|the task|the app|the website|the project)\b/.test(normalized) ||
    /^(go ahead|looks good|approved?|ship it|do it)$/.test(normalized)
  );
}

function isBuildRequest(normalized: string): boolean {
  return /^(build|create|make|implement|develop|scaffold|generate|add|fix|update|design)\b/.test(normalized);
}

function likelyFilesForPrompt(prompt: string): string[] {
  const normalized = normalizeIntent(prompt);
  if (/(website|web app|webapp|portfolio|landing page|homepage|frontend app)/.test(normalized)) {
    return ["package.json", "src/App.tsx", "src/main.tsx", "src/styles.css", "index.html"];
  }
  if (/(readme|docs|documentation)/.test(normalized)) return ["README.md"];
  if (/(test|spec|vitest|pytest)/.test(normalized)) return ["tests", "src"];
  return ["README.md", "src", "tests"];
}

function latestDraftReplitPlan(state: AppState): ReplitPlan | null {
  return state.replitPlans.find((plan) => plan.status === "draft") ?? null;
}

function promptFromReplitPlan(plan: ReplitPlan): string {
  return [
    `Implement this approved workflow: ${plan.title}`,
    plan.summary,
    "Tasks:",
    ...plan.tasks.map((task, index) => `${index + 1}. ${task.title}: ${task.summary}`),
  ].join("\n");
}

async function startFirstRunnableReplitTask(
  get: () => AppState,
  planId?: string,
): Promise<void> {
  const state = get();
  const tasks = state.replitTasks.filter((task) => !planId || task.plan_id === planId);
  const runnable = tasks.find((task) => {
    if (!["draft", "queued", "failed"].includes(task.status)) return false;
    return task.depends_on.every((dep) => {
      const dependency = state.replitTasks.find((candidate) => candidate.id === dep);
      return !dependency || ["done", "dismissed"].includes(dependency.status);
    });
  });
  if (runnable) await get().startReplitTask(runnable.id);
}

interface ProviderCreds {
  provider: string | null;
  apiKey: string | null;
  baseUrl: string | null;
}

/**
 * Resolve the bring-your-own cloud creds for the currently selected model.
 * Local (llamacpp) and mock providers need none; cloud providers supply their
 * OpenAI-compatible base URL (from the provider catalogue) and the saved key
 * (from the secure store) so the run routes to the right endpoint.
 */
async function resolveProviderCreds(state: AppState): Promise<ProviderCreds> {
  const providerId = state.selectedModel.provider;
  if (!providerId || providerId === "llamacpp" || providerId === "mock") {
    return { provider: providerId || null, apiKey: null, baseUrl: null };
  }
  const cfg = getProvider(providerId);
  if (!cfg) return { provider: providerId, apiKey: null, baseUrl: null };
  const apiKey = await secureStore.get(`provider.${providerId}.api_key`);
  return { provider: providerId, apiKey: apiKey?.trim() || null, baseUrl: cfg.baseUrl };
}

function buildRunAgentRequest(
  state: AppState,
  content: string,
): RunAgentRequest | null {
  const workspacePath = activeWorkspaceRoot(state);
  if (!workspacePath) return null;
  const active = activeEditorFile(state);
  return {
    sessionId: state.activeSessionId || null,
    message: content,
    prompt: content,
    workspacePath,
    activeFile: state.activeFile,
    openFiles: state.openFiles.slice(0, 12).map((file) => ({
      path: file.path,
      name: file.name,
      language: file.language,
      content: file.content,
      dirty: file.dirty,
    })),
    selectedText: null,
    editorContent: active?.content ?? null,
    mode: state.agentMode === "ask" ? "ask" : "agent",
    model: state.selectedModel.model || null,
    provider: state.selectedModel.provider ?? null,
    apiKey: null,
    baseUrl: null,
    maxIterations: 20,
    maxRepairAttempts: 2,
  };
}

function parseSlash(
  content: string,
): { name: SlashCommandName; args: Record<string, unknown> } | null {
  if (!content.startsWith("/")) return null;
  const trimmed = content.slice(1).trimStart();
  const space = trimmed.search(/\s/);
  const head = (space === -1 ? trimmed : trimmed.slice(0, space)).toLowerCase();
  const field = SLASH_ARG_FIELD[head as SlashCommandName];
  if (!field) return null;
  const rest = space === -1 ? "" : trimmed.slice(space + 1).trim();
  return {
    name: head as SlashCommandName,
    args: { [field]: rest },
  };
}

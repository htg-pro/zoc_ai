import { create } from "zustand";
import type {
  AgentEvent,
  CodeReviewReport,
  CheckpointInfo,
  ContextCandidate,
  ContextStatus,
  DiffPatch,
  IndexStatus,
  MemoryStats,
  Message,
  PermissionGrant,
  PermissionScope,
  Plan,
  PlanStep,
  ProjectRulesInfo,
  Session,
  SlashCommandName,
  TestGenerationResult,
  TodoItem,
  ToolCall,
  ToolDescriptor,
  ToolGrant,
} from "@zoc-studio/shared-types";

import type { AgentClient, CodeReviewRequest, TestGenRequest } from "./agent-client";
import { getAgentClient } from "./agent-client";
import { getProvider } from "./providers";
import { secureStore } from "./secure-store";
import { fsWriteText } from "./tauri-bridge";
import {
  fsCreateDir,
  fsCreateFile,
  fsDelete,
  fsDuplicate,
  fsMove,
  fsRename,
  fsReveal,
  fsReplaceApply,
  fsReplacePreview,
  fsSearch,
  type FileReplace,
  type ReplaceOptions,
  type ReplaceSummary,
  type ReplacedFile,
  type SearchOptions,
  type SearchResults,
} from "./tauri-bridge";
import {
  activeAfterDelete,
  basename,
  joinPath,
  openFilesAfterDelete,
  remapActive,
  remapOpenFiles,
  renamedPath,
} from "./paths";
import { recordRecentFile } from "./recents";
import { toast } from "@/components/ui/toast";
import {
  parseByKind,
  sourceForKind,
  type CheckKind,
  type Diagnostic,
} from "./problem-matchers";
import { runCheck, runTaskCommand } from "./tauri-bridge";
import {
  dedupeTasks,
  defaultBuildTask,
  defaultTestTask,
  detectCargo,
  detectMake,
  detectNpmScripts,
  detectPython,
  parseTasksJson,
  type Task,
} from "./tasks";
import { parseLaunchJson, type LaunchConfig } from "./launch-configs";
import {
  gitBranches,
  gitCheckout,
  gitCommit,
  gitCreateBranch,
  gitDiff,
  gitDiscard,
  gitLog,
  gitPull,
  gitPush,
  gitStage,
  gitStatus,
  gitUnstage,
  type GitBranchInfo,
  type GitCommit,
  type GitStatus,
} from "./tauri-bridge";
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
  DEFAULT_HOST,
  DEFAULT_PORT,
  loadLocalModels,
} from "./local-models";
import { track } from "./telemetry";
import { buildInlineEditPatch, spliceText, stripCodeFence } from "./inline-edit";
import type { AutonomyLevel } from "./run-machine";
import { decideIngest } from "./event-ingest";
// The single agent transport (gateway-client) + the pure Composer run-decision
// helper (prepare-agent-run). The Composer submit path posts runs to the
// Gateway through these and lets `useAgentStream` drive the feed — no legacy
// run/event transport is touched (task 4.1; R2.1, R4.x, R6.5).
import { postAgentRun } from "@/features/agent/gateway-client";
import { prepareAgentRun } from "@/features/agent/prepare-agent-run";
import { resolveSessionIntent } from "./session-lifecycle";
import { effectiveSettings, setSetting } from "./settings";
import { checkAction } from "./trust";

export type AgentMode = "ask" | "agent";

/** A user message held in the run queue (develop.md Phase 11). Multiple
 *  messages can be queued, reordered, and removed while a run is in flight. */
export interface QueuedMessage {
  id: string;
  content: string;
}

/** Output panel channels (develop.md Phase 5). */
export type OutputChannel = "Agent" | "Git" | "Tasks" | "MCP" | "Terminal" | "Extension Host";
export const OUTPUT_CHANNELS: OutputChannel[] = [
  "Agent",
  "Git",
  "Tasks",
  "MCP",
  "Terminal",
  "Extension Host",
];

export type LogLevel = "debug" | "info" | "warning" | "error";
export interface LogLine {
  ts: number;
  level: LogLevel;
  message: string;
}

/** A selectable shell profile for new terminals (develop.md Phase 8). */
export interface TerminalProfile {
  id: string;
  name: string;
  command: string;
  args?: string[];
}

/** Metadata for one terminal session (the live xterm + PTY live in the
 *  terminal manager; this is the serializable shadow that drives the tabs). */
export interface TerminalSession {
  id: string;
  title: string;
  profileId: string;
  status: "running" | "exited";
  exitCode: number | null;
}

export type ActivityView = "files" | "search" | "scm" | "debug" | "indexer" | "outline" | "timeline" | "sessions" | "settings";export type MainView = "editor" | "diff" | "sessions" | "settings" | "showcase";
export type BottomTab = "terminal" | "problems" | "output" | "tasks" | "logs" | "checkpoints";

/** Selection captured at Cmd-K time, used to build the inline-edit request. */
export interface InlineEditContext {
  filePath: string;
  language?: string | null;
  /** Half-open character offsets [start, end) of the selection in the file. */
  start: number;
  end: number;
  original: string;
  prefix: string;
  suffix: string;
}

export interface InlineEditUiState {
  open: boolean;
  filePath: string | null;
  language: string | null;
  start: number;
  end: number;
  original: string;
  prefix: string;
  suffix: string;
  status: "idle" | "loading" | "error";
  error: string | null;
}

const INLINE_EDIT_CLOSED: InlineEditUiState = {
  open: false,
  filePath: null,
  language: null,
  start: 0,
  end: 0,
  original: "",
  prefix: "",
  suffix: "",
  status: "idle",
  error: null,
};

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
      plan: Plan;
      status: "pending" | "approved" | "cancelled";
      createdAt: string;
    }
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
  /** Seed text the command palette opens with (e.g. ">" for command mode,
   *  "@" for symbol mode, "" for Go-to-File). Consumed once on open. */
  paletteSeed: string;
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
  /** The active run's id — the backend-issued (here client-supplied, backend
   *  echoed) `runId` the run is bound to. Drives cross-run event discarding
   *  via `decideIngest` (R1.2, R1.3). */
  runId: string | null;
  /** The user `Message.id` the active run answers, recorded when the run is
   *  bound in `sendUserMessage` (R1.1). `null` when no run is bound. */
  boundMessageId: string | null;
  selectedModel: { provider: string; model: string };
  /** Agent autonomy level for the active run config (R9.4). Replaces the
   *  previously hardcoded "High" badge in the Agent_Panel/Composer. */
  autonomy: AutonomyLevel;
  /** Conversation mode (redesign): "ask" = read-only Q&A, "agent" = full
   *  autonomy with file edits. Replaces the old Plan/Build text toggle. */
  agentMode: AgentMode;
  /** Effective mode for the currently active Gateway run. It can differ from
   *  the toggle when a plain chat prompt is auto-routed from Agent to Ask. */
  activeRunMode: AgentMode | null;
  /**
   * Latest snapshot from the llama-server supervisor (Rust). `null` means we
   * haven't subscribed yet (browser preview, or before `initLlamaCppStatus`
   * runs). When `running` is true, `loaded_model_id` is the source of truth
   * for which `.gguf` is actually in VRAM. `last_error` is sticky until the
   * next load attempt.
   */
  llamaCppStatus: LlamaCppStatus | null;
  attachments: { id: string; label: string; kind: "file" | "selection" | "folder" | "symbol" }[];
  pendingPatches: DiffPatch[];
  /** Id of the current isolated agent run awaiting review (review-before-apply
   *  model), captured from `checkpoint.created` / `run.awaiting_review` SSE
   *  events. `null` when no run is pending review. Drives whether the diff
   *  review card applies atomically via the backend or per-file via Tauri. */
  reviewRunId: string | null;
  /** End-of-run validation results (typecheck / build / tests run against the
   *  isolated copy), captured from the `diff.ready` SSE event. Keyed by check
   *  label → "pass" | "fail" | "skipped". `null` until a run reports them. */
  reviewValidation: Record<string, string> | null;
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
  /** Open the Settings view, optionally deep-linking to a section/tab
   *  (e.g. "extensions"). Consumed once by SettingsView. */
  settingsSection: string | null;
  openSettings: (section?: string) => void;
  setBottomTab: (t: BottomTab) => void;
  togglePalette: (open?: boolean) => void;
  /** Open the command palette seeded with a mode prefix (">", "@", or ""). */
  openPalette: (seed?: string) => void;
  toggleSide: () => void;
  toggleRight: () => void;
  toggleBottom: () => void;
  openFile: (path: string) => Promise<void>;
  closeFile: (path: string) => void;
  setActiveFile: (path: string) => void;
  updateFile: (path: string, content: string) => void;
  /** Persist the buffer at `path` to disk. Clears its dirty flag on success.
   *  Returns true when the write succeeded (or in browser preview where there
   *  is no disk to write to). */
  saveFile: (path: string) => Promise<boolean>;
  /** Persist the currently-active editor buffer. No-op when nothing is open. */
  saveActiveFile: () => Promise<boolean>;
  /** Persist every dirty buffer. Returns the count actually written. */
  saveAllFiles: () => Promise<number>;
  /** Reload the active file from disk (or mock), discarding unsaved edits. */
  revertActiveFile: () => Promise<boolean>;
  /** Editor view toggles (Phase 9). */
  editorSettings: { minimap: boolean; stickyScroll: boolean; breadcrumbs: boolean };
  toggleEditorSetting: (key: "minimap" | "stickyScroll" | "breadcrumbs") => void;
  /** Apply the merged user/workspace settings (Phase 10) into runtime state.
   *  Pass `includeMode` at startup to also seed the default conversation mode. */
  applyEffectiveSettings: (opts?: { includeMode?: boolean }) => void;
  /** Split editor: a second group showing an independently-active open file
   *  (shares the underlying model with the primary group). */
  splitView: boolean;
  rightActiveFile: string | null;
  splitEditor: () => void;
  closeRightGroup: () => void;
  openToSide: (path: string) => Promise<void>;
  setRightActiveFile: (path: string) => void;
  /** Tab management. */
  closeOtherFiles: (path: string) => void;
  closeSavedFiles: () => void;
  closeAllFiles: () => void;
  /** Bumped after any Explorer file operation so the file tree re-fetches the
   *  affected directories immediately (in addition to the fs watcher). */
  fsRefreshNonce: number;
  /** Create an empty file `name` inside `parentDir`; opens it. Returns the new
   *  absolute path, or null on failure / outside the desktop runtime. */
  createFile: (parentDir: string, name: string) => Promise<string | null>;
  /** Create a directory `name` inside `parentDir`. Returns the new path. */
  createFolder: (parentDir: string, name: string) => Promise<string | null>;
  /** Rename an entry's final component; remaps open tabs. Returns new path. */
  renameEntry: (path: string, newName: string) => Promise<string | null>;
  /** Duplicate a file/dir to a "… copy" sibling. Returns the new path. */
  duplicateEntry: (path: string) => Promise<string | null>;
  /** Delete a file/dir; closes affected tabs. Returns true on success. */
  deleteEntry: (path: string) => Promise<boolean>;
  /** Move an entry into `toDir`; remaps open tabs. Returns the new path. */
  moveEntry: (from: string, toDir: string) => Promise<string | null>;
  /** Reveal a path in the OS file manager (desktop only). */
  revealEntry: (path: string) => Promise<void>;
  /** Originals captured from the last replace-all, for a one-click undo. */
  lastReplaceUndo: ReplacedFile[] | null;
  /** Run a workspace text search. Empty result outside the desktop runtime. */
  searchWorkspace: (options: SearchOptions) => Promise<SearchResults>;
  /** Preview a replace without writing. */
  previewReplace: (options: ReplaceOptions) => Promise<FileReplace[]>;
  /** Apply a replace to disk, stashing originals for undo. */
  applyReplace: (options: ReplaceOptions) => Promise<ReplaceSummary | null>;
  /** Undo the most recent replace-all by restoring captured originals. */
  undoLastReplace: () => Promise<number>;
  /** Latest git working-tree status (null = not loaded / not a repo / no desktop). */
  git: GitStatus | null;
  /** Refresh git status into `git`. */
  refreshGit: () => Promise<void>;
  stageFiles: (paths: string[]) => Promise<void>;
  unstageFiles: (paths: string[]) => Promise<void>;
  discardFiles: (paths: string[]) => Promise<void>;
  /** Commit staged changes. Returns the new commit hash, or null on failure. */
  commitChanges: (message: string) => Promise<string | null>;
  listGitBranches: () => Promise<GitBranchInfo[]>;
  checkoutBranch: (branch: string) => Promise<void>;
  createGitBranch: (name: string) => Promise<void>;
  pullChanges: () => Promise<void>;
  pushChanges: () => Promise<void>;
  loadGitLog: (limit?: number) => Promise<GitCommit[]>;
  gitFileDiff: (path: string, staged: boolean) => Promise<string>;
  /** Diagnostics keyed by source ("typescript" | "eslint" | "ruff" | "cargo" | …). */
  diagnostics: Record<string, Diagnostic[]>;
  setDiagnostics: (source: string, items: Diagnostic[]) => void;
  clearDiagnostics: (source?: string) => void;
  /** Run a checker, parse its output into diagnostics, mirror raw to Tasks output. */
  runDiagnostics: (kind: CheckKind, cwd?: string) => Promise<void>;
  /** Per-channel output buffers (Agent / Git / Tasks / MCP / Terminal / …). */
  outputChannels: Record<OutputChannel, string[]>;
  appendOutput: (channel: OutputChannel, text: string) => void;
  clearOutput: (channel: OutputChannel) => void;
  /** Rolling log buffer for the Logs panel (real sidecar/desktop events). */
  logs: LogLine[];
  appendLog: (level: LogLevel, message: string) => void;
  clearLogs: () => void;
  /** Discovered tasks (config + auto-detected). */
  tasks: Task[];
  /** Per-task run status. */
  taskRuns: Record<string, "running" | "passed" | "failed">;
  /** Read project config/manifests and populate `tasks`. */
  discoverTasks: () => Promise<void>;
  /** Run a task by id; streams output to the Tasks channel and parses any
   *  problem matcher into diagnostics. */
  runTask: (id: string) => Promise<void>;
  /** Run the default build / test task (⌘⇧B and the test command). */
  runBuildTask: () => Promise<void>;
  runTestTask: () => Promise<void>;
  /** Breakpoints keyed by absolute file path → sorted 1-based line numbers. */
  breakpoints: Record<string, number[]>;
  toggleBreakpoint: (file: string, line: number) => void;
  clearBreakpoints: (file?: string) => void;
  /** Parsed launch.json debug configurations. */
  launchConfigs: LaunchConfig[];
  /** Currently-selected debug configuration name. */
  selectedDebugConfig: string | null;
  setSelectedDebugConfig: (name: string | null) => void;
  /** Read .vscode/.zoc launch.json and populate `launchConfigs`. */
  loadLaunchConfigs: () => Promise<void>;
  /** Terminal sessions (metadata; live instances live in the terminal manager). */
  terminals: TerminalSession[];
  activeTerminalId: string | null;
  terminalProfiles: TerminalProfile[];
  /** When true the terminal area shows two panes side-by-side. */
  terminalSplit: boolean;
  /** Create a new terminal session (optionally with a given profile). Returns id. */
  newTerminal: (profileId?: string) => string;
  closeTerminal: (id: string) => void;
  setActiveTerminal: (id: string) => void;
  renameTerminal: (id: string, title: string) => void;
  /** Mark a terminal exited with its code (called by the terminal manager). */
  setTerminalExited: (id: string, code: number | null) => void;
  toggleTerminalSplit: () => void;
  loadSessions: () => Promise<void>;
  selectSession: (id: string) => Promise<void>;
  createSession: (title: string, workspaceRoot: string) => Promise<Session | null>;
  renameSession: (id: string, newTitle: string) => Promise<boolean>;
  deleteSession: (id: string) => Promise<boolean>;
  /** Toggle pin state for a session (persisted). */
  togglePinnedSession: (id: string) => void;
  /** Set or clear a file's VCS status. Passing `null` removes the entry. */
  setFileStatus: (path: string, status: "A" | "M" | "D" | null) => void;
  sendUserMessage: (content: string) => Promise<void>;
  sendMessage: () => Promise<void>;
  setInput: (value: string) => void;
  runSlashCommand: (name: SlashCommandName, args?: Record<string, unknown>) => Promise<void>;
  approvePermission: (requestId: string) => Promise<void>;
  rejectPermission: (requestId: string) => Promise<void>;
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
  /** Messages the user composed while a run was active (develop.md Phase 11).
   *  Released one-by-one as each run reaches a terminal state (R4.11/R4.14). */
  messageQueue: QueuedMessage[];
  /** Queue a message to be sent when the active run finishes. No-op when no
   *  run is active (the caller should just send directly in that case). */
  queueUserMessage: (content: string) => void;
  /** Remove a single queued message by id. */
  dequeueMessage: (id: string) => void;
  /** Move a queued message from one index to another (drag reorder). */
  reorderQueue: (fromIndex: number, toIndex: number) => void;
  /** Drop every queued message. */
  clearQueue: () => void;
  /** Cancel the current run and send `content` immediately ("stop and send"). */
  stopAndSend: (content: string) => void;
  /** Mark the canonical Gateway run complete and release the next queued send. */
  finishGatewayRun: (runId?: string | null) => void;
  /** Persist the completed Ask stream before the transient SSE buffer is cleared. */
  commitAskStreamMessage: (runId: string, content: string, createdAt?: string) => void;
  setSelectedModel: (m: { provider: string; model: string }) => void;
  /** Set the agent autonomy level (R9.4, R9.7). */
  setAutonomy: (level: AutonomyLevel) => void;
  /** Set the conversation mode (Ask = read-only, Agent = full autonomy). */
  setAgentMode: (mode: AgentMode) => void;
  /** Wire up the llama-server status subscription. Called once at app start. */
  initLlamaCppStatus: () => Promise<void>;
  addAttachment: (a: { label: string; kind: "file" | "selection" | "folder" | "symbol" }) => void;
  /** Search workspace files/folders/symbols for the `@` context picker.
   *  Falls back to filtering open files when the sidecar is unavailable. */
  searchContextCandidates: (query: string) => Promise<ContextCandidate[]>;
  removeAttachment: (id: string) => void;
  clearAttachments: () => void;
  toggleHunk: (diffId: string, hunkIndex: number) => void;
  acceptHunk: (diffId: string, hunkIndex: number) => void;
  rejectHunk: (diffId: string, hunkIndex: number) => void;
  applyPatch: (diffId: string) => Promise<boolean>;
  rejectPatch: (diffId: string) => void;
  acceptAllForDiff: (diffId: string) => Promise<boolean>;
  rejectAllForDiff: (diffId: string) => void;
  /** Apply the current isolated (review-before-apply) run's changes onto the
   *  real workspace via the backend `/runs/{id}/apply` endpoint, then clear
   *  the pending review state. Returns false if there is no run to apply. */
  applyCurrentRun: () => Promise<boolean>;

  /** Run id of the most recently applied run whose pre-apply checkpoint can
   *  be restored. `null` when there is nothing to undo. */
  restorableRunId: string | null;
  /** Undo the most recently applied run by restoring its checkpoint (reverts
   *  modifications, deletes created files, recreates deleted ones). */
  restoreCurrentRun: () => Promise<boolean>;

  /** Restorable checkpoints for the session (newest first). */
  checkpoints: CheckpointInfo[];
  /** Fetch the session's checkpoint history. */
  loadCheckpoints: () => Promise<void>;
  /** Restore a specific checkpoint by its run id. */
  restoreCheckpoint: (runId: string) => Promise<boolean>;
  /** Discard the current isolated run — the real workspace stays untouched. */
  discardCurrentRun: () => Promise<void>;
  /** Queue a finding's suggested patch into `pendingPatches` (dedup by id)
   *  so it can be accepted/rejected like any agent-produced patch. */
  queueFindingPatch: (patch: DiffPatch) => void;
  /** Queue then immediately apply a finding's suggested patch. */
  applyFindingPatch: (patch: DiffPatch) => Promise<boolean>;

  /** Inline edit (Cmd-K) prompt + request state. Captured from the editor
   *  selection; the result is spliced back and queued as a pending patch. */
  inlineEdit: InlineEditUiState;
  /** Open the Cmd-K prompt for a captured selection. */
  openInlineEdit: (ctx: InlineEditContext) => void;
  /** Close/cancel the Cmd-K prompt. */
  closeInlineEdit: () => void;
  /** Send the instruction, splice the rewritten selection back into the file,
   *  and queue it as a pending patch for review/apply. */
  submitInlineEdit: (instruction: string) => Promise<boolean>;
  /** Latest memory snapshot from the agent sidecar. `null` until the
   *  first `loadMemoryStats` call resolves, or in browser preview where
   *  the sidecar is unreachable. */
  memoryStats: MemoryStats | null;
  /** Extended context status with model recommendations and action flags. */
  contextStatus: ContextStatus | null;
  loadMemoryStats: () => Promise<void>;
  compactMemory: () => Promise<void>;
  forgetMemory: (keepLast?: number) => Promise<void>;
  loadContextStatus: () => Promise<void>;
  /** Embeddings index status for the status bar / Indexer panel (Phase 14). */
  indexStatus: IndexStatus | null;
  loadIndexStatus: () => Promise<void>;
  /** Project rules (.zoc/rules) active for the current workspace, or null. */
  projectRules: ProjectRulesInfo | null;
  /** Fetch the active project rules for the current session. */
  loadProjectRules: () => Promise<void>;
  setLayoutSizes: (
    sizes: Partial<Pick<LayoutState, "sidePanelSize" | "rightPanelSize" | "bottomDockSize">>,
  ) => void;
}

const STORAGE_KEY = "zoc-studio.layout.v2";
const APPLIED_PATCHES_KEY = "zoc-studio.applied-patches.v1";
const PINNED_SESSIONS_KEY = "zoc-studio.pinned-sessions.v1";
const LAST_ACTIVE_SESSION_KEY = "zoc-studio.last-active-session.v1";

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

/** Read the persisted "last active" session pointer (R2.2). Returns `null`
 *  when unset or when localStorage is unavailable (browser preview / tests).
 *  The pointer is honored on app-open only if it names an existing session;
 *  `resolveSessionIntent` enforces that contract. */
function loadLastActiveSession(): string | null {
  if (typeof localStorage === "undefined") return null;
  try {
    const raw = localStorage.getItem(LAST_ACTIVE_SESSION_KEY);
    return typeof raw === "string" && raw.length > 0 ? raw : null;
  } catch {
    return null;
  }
}

/** Persist (or clear) the "last active" session pointer. Passing `null` or an
 *  empty string removes it, so a fresh/cleared state never resumes a stale
 *  session on the next app-open. */
function persistLastActiveSession(id: string | null): void {
  if (typeof localStorage === "undefined") return;
  try {
    if (id == null || id.length === 0) localStorage.removeItem(LAST_ACTIVE_SESSION_KEY);
    else localStorage.setItem(LAST_ACTIVE_SESSION_KEY, id);
  } catch {
    /* ignore */
  }
}

function defaultTerminalProfiles(): TerminalProfile[] {
  const isWin =
    typeof navigator !== "undefined" && /Win/i.test(navigator.userAgent || navigator.platform || "");
  if (isWin) {
    return [
      { id: "pwsh", name: "PowerShell", command: "powershell.exe" },
      { id: "cmd", name: "Command Prompt", command: "cmd.exe" },
    ];
  }
  return [
    { id: "bash", name: "bash", command: "/bin/bash" },
    { id: "zsh", name: "zsh", command: "/bin/zsh" },
    { id: "sh", name: "sh", command: "/bin/sh" },
  ];
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

function planStatus(plan: Plan): "pending" | "approved" | "cancelled" {
  if ("status" in plan) {
    if (plan.status === "approved") return "approved";
    if (plan.status === "archived") return "cancelled";
  }
  return "pending";
}

function planCreatedAt(plan: Plan): string {
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
  plan: Plan,
): AgentWorkflowItem[] {
  return upsertWorkflowItem(items, {
    type: "plan",
    id: `plan-${plan.id}`,
    plan,
    status: planStatus(plan),
    createdAt: planCreatedAt(plan),
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

function isPlaceholderPlan(plan: Plan): boolean {
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
  paletteSeed: "",
  settingsSection: null,
  fsRefreshNonce: 0,
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
  boundMessageId: null,
  selectedModel: { provider: "llamacpp", model: "" },
  autonomy: "High",
  agentMode: "agent",
  activeRunMode: null,
  agentPaused: false,
  messageQueue: [],
  llamaCppStatus: null,
  attachments: [],
  pendingPatches: [],
  reviewRunId: null,
  restorableRunId: null,
  checkpoints: [],
  inlineEdit: { ...INLINE_EDIT_CLOSED },
  reviewValidation: null,
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
  indexStatus: null,
  projectRules: null,

  setWorkspaceRoot: async (root) => {
    set({ workspaceRoot: root });
    if (isTauri()) await tauriSetWorkspaceRoot(root);
    void get().refreshGit();
  },

  setActivity: (a) => set({ activity: a }),
  setMainView: (v) => set({ mainView: v }),
  openSettings: (section) => set({ mainView: "settings", settingsSection: section ?? null }),
  setBottomTab: (t) => set({ bottomTab: t, layout: { ...get().layout, bottomDockOpen: true } }),
  togglePalette: (open) => set((s) => ({ paletteOpen: open ?? !s.paletteOpen })),
  openPalette: (seed) => set({ paletteOpen: true, paletteSeed: seed ?? "" }),
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
    recordRecentFile(path);
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
  saveFile: async (path) => {
    const file = get().openFiles.find((f) => f.path === path);
    if (!file) return false;
    if (!file.dirty) return true;
    // Browser preview: there is no disk, so just clear the dirty flag so the
    // UI reflects a "saved" state.
    if (!isTauri()) {
      set((s) => ({
        openFiles: s.openFiles.map((f) =>
          f.path === path ? { ...f, dirty: false } : f,
        ),
      }));
      return true;
    }
    const ok = await fsWriteText(file.path, file.content);
    if (ok) {
      set((s) => ({
        openFiles: s.openFiles.map((f) =>
          f.path === path ? { ...f, dirty: false } : f,
        ),
      }));
      toast.success("Saved", { description: file.name });
    } else {
      toast.error("Couldn't save file", {
        description: `${file.name} — check workspace permissions.`,
      });
    }
    return ok;
  },
  saveActiveFile: async () => {
    const active = get().activeFile;
    if (!active) return false;
    return get().saveFile(active);
  },
  saveAllFiles: async () => {
    const dirty = get().openFiles.filter((f) => f.dirty);
    if (dirty.length === 0) return 0;
    let saved = 0;
    for (const f of dirty) {
      // Sequential so each write surfaces its own toast/error and we keep a
      // truthful saved count even when one path fails permission checks.
      if (await get().saveFile(f.path)) saved += 1;
    }
    return saved;
  },
  revertActiveFile: async () => {
    const path = get().activeFile;
    if (!path) return false;
    const file = get().openFiles.find((f) => f.path === path);
    if (!file) return false;
    // Reload the on-disk (or mock) content and drop unsaved edits.
    let content: string | null = null;
    if (isTauri()) content = await fsReadText(path);
    if (content === null) content = MOCK_FILE_CONTENT[path]?.content ?? file.content;
    set((s) => ({
      openFiles: s.openFiles.map((f) =>
        f.path === path ? { ...f, content: content!, dirty: false } : f,
      ),
    }));
    toast.message("Reverted", { description: file.name });
    return true;
  },

  editorSettings: {
    minimap: effectiveSettings()["editor.minimap"] === true,
    stickyScroll: effectiveSettings()["editor.stickyScroll"] === true,
    breadcrumbs: effectiveSettings()["editor.breadcrumbs"] !== false,
  },
  toggleEditorSetting: (key) =>
    set((s) => {
      const next = !s.editorSettings[key];
      // Persist to the user scope so the choice survives reloads and stays in
      // sync with the Settings page (Phase 10).
      setSetting("user", `editor.${key}`, next);
      return { editorSettings: { ...s.editorSettings, [key]: next } };
    }),
  applyEffectiveSettings: (opts) => {
    const e = effectiveSettings();
    set((s) => ({
      editorSettings: {
        minimap: e["editor.minimap"] === true,
        stickyScroll: e["editor.stickyScroll"] === true,
        breadcrumbs: e["editor.breadcrumbs"] !== false,
      },
      autonomy: (e["agent.autonomy"] as AutonomyLevel) ?? s.autonomy,
      ...(opts?.includeMode ? { agentMode: e["agent.defaultMode"] as AgentMode } : {}),
    }));
  },

  splitView: false,
  rightActiveFile: null,
  splitEditor: () =>
    set((s) => (s.activeFile ? { splitView: true, rightActiveFile: s.activeFile } : {})),
  closeRightGroup: () => set({ splitView: false, rightActiveFile: null }),
  openToSide: async (path) => {
    await get().openFile(path);
    set({ splitView: true, rightActiveFile: path });
  },
  setRightActiveFile: (path) => set({ rightActiveFile: path }),
  closeOtherFiles: (path) =>
    set((s) => {
      const keep = s.openFiles.filter((f) => f.path === path);
      return {
        openFiles: keep,
        activeFile: keep.length ? path : null,
        rightActiveFile: s.rightActiveFile === path ? s.rightActiveFile : null,
        splitView: s.rightActiveFile === path && s.splitView,
      };
    }),
  closeSavedFiles: () =>
    set((s) => {
      const kept = s.openFiles.filter((f) => f.dirty);
      const active = kept.some((f) => f.path === s.activeFile)
        ? s.activeFile
        : kept[kept.length - 1]?.path ?? null;
      const right = kept.some((f) => f.path === s.rightActiveFile) ? s.rightActiveFile : null;
      return {
        openFiles: kept,
        activeFile: active,
        rightActiveFile: right,
        splitView: right !== null && s.splitView,
      };
    }),
  closeAllFiles: () =>
    set({ openFiles: [], activeFile: null, rightActiveFile: null, splitView: false }),

  createFile: async (parentDir, name) => {
    const trimmed = name.trim();
    if (!trimmed) return null;
    if (!isTauri()) {
      toast.message("File operations require the desktop app");
      return null;
    }
    try {
      const created = await fsCreateFile(joinPath(parentDir, trimmed));
      set((s) => ({ fsRefreshNonce: s.fsRefreshNonce + 1 }));
      await get().openFile(created);
      toast.success("Created file", { description: basename(created) });
      return created;
    } catch (err) {
      toast.error("Couldn't create file", { description: (err as Error).message });
      return null;
    }
  },
  createFolder: async (parentDir, name) => {
    const trimmed = name.trim();
    if (!trimmed) return null;
    if (!isTauri()) {
      toast.message("File operations require the desktop app");
      return null;
    }
    try {
      const created = await fsCreateDir(joinPath(parentDir, trimmed));
      set((s) => ({ fsRefreshNonce: s.fsRefreshNonce + 1 }));
      toast.success("Created folder", { description: basename(created) });
      return created;
    } catch (err) {
      toast.error("Couldn't create folder", { description: (err as Error).message });
      return null;
    }
  },
  renameEntry: async (path, newName) => {
    const trimmed = newName.trim();
    if (!trimmed || trimmed === basename(path)) return null;
    if (!isTauri()) {
      toast.message("File operations require the desktop app");
      return null;
    }
    try {
      const to = renamedPath(path, trimmed);
      const newPath = await fsRename(path, to);
      set((s) => ({
        openFiles: remapOpenFiles(s.openFiles, path, newPath),
        activeFile: remapActive(s.activeFile, path, newPath),
        fsRefreshNonce: s.fsRefreshNonce + 1,
      }));
      toast.success("Renamed", { description: basename(newPath) });
      return newPath;
    } catch (err) {
      toast.error("Couldn't rename", { description: (err as Error).message });
      return null;
    }
  },
  duplicateEntry: async (path) => {
    if (!isTauri()) {
      toast.message("File operations require the desktop app");
      return null;
    }
    try {
      const created = await fsDuplicate(path);
      set((s) => ({ fsRefreshNonce: s.fsRefreshNonce + 1 }));
      toast.success("Duplicated", { description: basename(created) });
      return created;
    } catch (err) {
      toast.error("Couldn't duplicate", { description: (err as Error).message });
      return null;
    }
  },
  deleteEntry: async (path) => {
    if (!isTauri()) {
      toast.message("File operations require the desktop app");
      return false;
    }
    try {
      await fsDelete(path);
      set((s) => ({
        openFiles: openFilesAfterDelete(s.openFiles, path),
        activeFile: activeAfterDelete(s.openFiles, s.activeFile, path),
        fsRefreshNonce: s.fsRefreshNonce + 1,
      }));
      toast.message("Deleted", { description: basename(path) });
      return true;
    } catch (err) {
      toast.error("Couldn't delete", { description: (err as Error).message });
      return false;
    }
  },
  moveEntry: async (from, toDir) => {
    if (!isTauri()) {
      toast.message("File operations require the desktop app");
      return null;
    }
    try {
      const newPath = await fsMove(from, joinPath(toDir, basename(from)));
      set((s) => ({
        openFiles: remapOpenFiles(s.openFiles, from, newPath),
        activeFile: remapActive(s.activeFile, from, newPath),
        fsRefreshNonce: s.fsRefreshNonce + 1,
      }));
      toast.success("Moved", { description: basename(newPath) });
      return newPath;
    } catch (err) {
      toast.error("Couldn't move", { description: (err as Error).message });
      return null;
    }
  },
  revealEntry: async (path) => {
    if (!isTauri()) {
      toast.message("Reveal requires the desktop app");
      return;
    }
    try {
      await fsReveal(path);
    } catch (err) {
      toast.error("Couldn't reveal in file manager", { description: (err as Error).message });
    }
  },

  lastReplaceUndo: null,
  searchWorkspace: async (options) => {
    const empty: SearchResults = { files: [], total: 0, truncated: false };
    if (!isTauri() || !options.query.trim()) return empty;
    try {
      return (await fsSearch(options)) ?? empty;
    } catch (err) {
      toast.error("Search failed", { description: (err as Error).message });
      return empty;
    }
  },
  previewReplace: async (options) => {
    if (!isTauri() || !options.query.trim()) return [];
    try {
      return (await fsReplacePreview(options)) ?? [];
    } catch (err) {
      toast.error("Couldn't preview replace", { description: (err as Error).message });
      return [];
    }
  },
  applyReplace: async (options) => {
    if (!isTauri()) {
      toast.message("Replace requires the desktop app");
      return null;
    }
    if (!options.query.trim()) return null;
    try {
      const summary = await fsReplaceApply(options);
      // Refresh any open editor buffers for changed files so the editor shows
      // the replaced content (and reset their dirty flag from disk truth).
      const changed = new Set(summary.files.map((f) => f.file));
      const updated = await Promise.all(
        get().openFiles.map(async (f) => {
          if (!changed.has(f.path)) return f;
          const content = await fsReadText(f.path);
          return content === null ? f : { ...f, content, dirty: false };
        }),
      );
      set((s) => ({
        openFiles: updated,
        lastReplaceUndo: summary.files.length > 0 ? summary.files : s.lastReplaceUndo,
        fsRefreshNonce: s.fsRefreshNonce + 1,
      }));
      if (summary.total_replacements > 0) {
        toast.success(
          `Replaced ${summary.total_replacements} occurrence${
            summary.total_replacements === 1 ? "" : "s"
          } in ${summary.files.length} file${summary.files.length === 1 ? "" : "s"}`,
          { description: "Undo available from the Search panel." },
        );
      } else {
        toast.message("No occurrences replaced");
      }
      return summary;
    } catch (err) {
      toast.error("Replace failed", { description: (err as Error).message });
      return null;
    }
  },
  undoLastReplace: async () => {
    const undo = get().lastReplaceUndo;
    if (!undo || undo.length === 0) return 0;
    if (!isTauri()) return 0;
    let restored = 0;
    for (const file of undo) {
      if (await fsWriteText(file.file, file.original)) restored += 1;
    }
    const restoredPaths = new Set(undo.map((f) => f.file));
    set((s) => ({
      openFiles: s.openFiles.map((f) => {
        const orig = undo.find((u) => u.file === f.path);
        return orig && restoredPaths.has(f.path) ? { ...f, content: orig.original, dirty: false } : f;
      }),
      lastReplaceUndo: null,
      fsRefreshNonce: s.fsRefreshNonce + 1,
    }));
    toast.message(`Reverted replace in ${restored} file${restored === 1 ? "" : "s"}`);
    return restored;
  },

  git: null,
  refreshGit: async () => {
    if (!isTauri()) {
      set({ git: null });
      return;
    }
    try {
      set({ git: await gitStatus() });
    } catch {
      set({ git: null });
    }
  },
  stageFiles: async (paths) => {
    if (!isTauri() || paths.length === 0) return;
    try {
      await gitStage(paths);
      await get().refreshGit();
    } catch (err) {
      toast.error("Couldn't stage", { description: (err as Error).message });
    }
  },
  unstageFiles: async (paths) => {
    if (!isTauri() || paths.length === 0) return;
    try {
      await gitUnstage(paths);
      await get().refreshGit();
    } catch (err) {
      toast.error("Couldn't unstage", { description: (err as Error).message });
    }
  },
  discardFiles: async (paths) => {
    if (!isTauri() || paths.length === 0) return;
    try {
      await gitDiscard(paths);
      // Discarded files changed on disk — refresh open buffers from truth.
      const changed = new Set(paths);
      const updated = await Promise.all(
        get().openFiles.map(async (f) => {
          if (!changed.has(f.path)) return f;
          const content = await fsReadText(f.path);
          return content === null ? f : { ...f, content, dirty: false };
        }),
      );
      set((s) => ({ openFiles: updated, fsRefreshNonce: s.fsRefreshNonce + 1 }));
      await get().refreshGit();
      toast.message("Discarded changes");
    } catch (err) {
      toast.error("Couldn't discard", { description: (err as Error).message });
    }
  },
  commitChanges: async (message) => {
    if (!isTauri()) {
      toast.message("Commit requires the desktop app");
      return null;
    }
    if (!message.trim()) {
      toast.error("A commit message is required");
      return null;
    }
    try {
      const hash = await gitCommit(message);
      await get().refreshGit();
      toast.success("Committed", { description: hash.slice(0, 8) });
      return hash;
    } catch (err) {
      // Surfaces git's own message, e.g. missing identity or nothing staged.
      toast.error("Commit failed", { description: (err as Error).message });
      return null;
    }
  },
  listGitBranches: async () => {
    if (!isTauri()) return [];
    try {
      return await gitBranches();
    } catch {
      return [];
    }
  },
  checkoutBranch: async (branch) => {
    if (!isTauri()) return;
    try {
      await gitCheckout(branch);
      set((s) => ({ fsRefreshNonce: s.fsRefreshNonce + 1 }));
      await get().refreshGit();
      toast.success(`Switched to ${branch}`);
    } catch (err) {
      toast.error("Couldn't switch branch", { description: (err as Error).message });
    }
  },
  createGitBranch: async (name) => {
    if (!isTauri()) return;
    try {
      await gitCreateBranch(name);
      await get().refreshGit();
      toast.success(`Created branch ${name.trim()}`);
    } catch (err) {
      toast.error("Couldn't create branch", { description: (err as Error).message });
    }
  },
  pullChanges: async () => {
    if (!isTauri()) return;
    try {
      const out = await gitPull();
      set((s) => ({ fsRefreshNonce: s.fsRefreshNonce + 1 }));
      await get().refreshGit();
      toast.success("Pulled", { description: out.split("\n")[0] || undefined });
    } catch (err) {
      toast.error("Pull failed", { description: (err as Error).message });
    }
  },
  pushChanges: async () => {
    if (!isTauri()) return;
    try {
      const out = await gitPush();
      await get().refreshGit();
      toast.success("Pushed", { description: out.split("\n")[0] || undefined });
    } catch (err) {
      toast.error("Push failed", { description: (err as Error).message });
    }
  },
  loadGitLog: async (limit) => {
    if (!isTauri()) return [];
    try {
      return await gitLog(limit);
    } catch {
      return [];
    }
  },
  gitFileDiff: async (path, staged) => {
    if (!isTauri()) return "";
    try {
      return await gitDiff(path, staged);
    } catch {
      return "";
    }
  },

  diagnostics: {},
  setDiagnostics: (source, items) =>
    set((s) => ({ diagnostics: { ...s.diagnostics, [source]: items } })),
  clearDiagnostics: (source) =>
    set((s) => {
      if (!source) return { diagnostics: {} };
      const next = { ...s.diagnostics };
      delete next[source];
      return { diagnostics: next };
    }),
  runDiagnostics: async (kind, cwd) => {
    const source = sourceForKind(kind);
    if (!isTauri()) {
      toast.message("Validation requires the desktop app");
      return;
    }
    get().appendLog("info", `Running ${kind} check…`);
    try {
      const result = await runCheck(kind, cwd);
      if (!result) {
        get().appendLog("error", `${kind}: checker unavailable`);
        return;
      }
      const combined = `${result.stdout}\n${result.stderr}`;
      get().appendOutput("Tasks", `$ ${kind}\n${combined.trim()}\n(exit ${result.code})`);
      const items = parseByKind(kind, combined);
      get().setDiagnostics(source, items);
      get().appendLog(
        items.length ? "warning" : "info",
        `${kind}: ${items.length} problem${items.length === 1 ? "" : "s"} (exit ${result.code})`,
      );
      toast.message(
        items.length
          ? `${kind}: ${items.length} problem${items.length === 1 ? "" : "s"}`
          : `${kind}: no problems`,
      );
    } catch (err) {
      get().appendLog("error", `${kind}: ${(err as Error).message}`);
      toast.error(`${kind} check failed`, { description: (err as Error).message });
    }
  },

  outputChannels: {
    Agent: [],
    Git: [],
    Tasks: [],
    MCP: [],
    Terminal: [],
    "Extension Host": [],
  },
  appendOutput: (channel, text) =>
    set((s) => {
      const prev = s.outputChannels[channel] ?? [];
      // Cap each channel so a noisy producer can't grow memory unbounded.
      const next = [...prev, text].slice(-2000);
      return { outputChannels: { ...s.outputChannels, [channel]: next } };
    }),
  clearOutput: (channel) =>
    set((s) => ({ outputChannels: { ...s.outputChannels, [channel]: [] } })),

  logs: [],
  appendLog: (level, message) =>
    set((s) => ({ logs: [...s.logs, { ts: Date.now(), level, message }].slice(-2000) })),
  clearLogs: () => set({ logs: [] }),

  tasks: [],
  taskRuns: {},
  discoverTasks: async () => {
    const root = get().workspaceRoot;
    if (!isTauri() || !root) {
      set({ tasks: [] });
      return;
    }
    const read = async (rel: string): Promise<string | null> => fsReadText(joinPath(root, rel));
    const [pkg, cargo, makefile, pyproject, vscodeTasks, zocTasks] = await Promise.all([
      read("package.json"),
      read("Cargo.toml"),
      read("Makefile"),
      read("pyproject.toml"),
      read(".vscode/tasks.json"),
      read(".zoc/tasks.json"),
    ]);
    const tasks = dedupeTasks([
      // Config sources first so they win on id collisions.
      ...(vscodeTasks ? parseTasksJson(vscodeTasks, "vscode") : []),
      ...(zocTasks ? parseTasksJson(zocTasks, "zoc") : []),
      ...(pkg ? detectNpmScripts(pkg) : []),
      ...(cargo ? detectCargo(cargo) : []),
      ...(makefile ? detectMake(makefile) : []),
      ...(pyproject ? detectPython(pyproject) : []),
    ]);
    set({ tasks });
  },
  runTask: async (id) => {
    const task = get().tasks.find((t) => t.id === id);
    if (!task) return;
    if (!isTauri()) {
      toast.message("Tasks require the desktop app");
      return;
    }
    // Workspace Trust + permission gate (Phase 13). A restricted workspace
    // blocks task execution; the decision is recorded in the audit log.
    const decision = checkAction(
      { kind: "task", name: `${task.command} ${task.args.join(" ")}`.trim(), destructive: false },
      get().workspaceRoot,
    );
    if (decision.effect === "deny") {
      get().appendLog("warning", `Task blocked: ${task.label} — ${decision.reason}`);
      toast.error("Task blocked", { description: decision.reason });
      return;
    }
    set((s) => ({ taskRuns: { ...s.taskRuns, [id]: "running" } }));
    get().appendLog("info", `Task started: ${task.label}`);
    get().appendOutput("Tasks", `$ ${task.command} ${task.args.join(" ")}`.trim());
    try {
      const result = await runTaskCommand(task.command, task.args, task.cwd ?? undefined);
      if (!result) {
        set((s) => ({ taskRuns: { ...s.taskRuns, [id]: "failed" } }));
        get().appendLog("error", `Task unavailable: ${task.label}`);
        return;
      }
      const combined = `${result.stdout}\n${result.stderr}`;
      get().appendOutput("Tasks", `${combined.trim()}\n(exit ${result.code})`);
      // Feed a problem matcher into the diagnostics store when the task declares one.
      if (task.problemMatcher) {
        const kind = task.problemMatcher as CheckKind;
        get().setDiagnostics(sourceForKind(kind), parseByKind(kind, combined));
      }
      const ok = result.code === 0;
      set((s) => ({ taskRuns: { ...s.taskRuns, [id]: ok ? "passed" : "failed" } }));
      get().appendLog(ok ? "info" : "error", `Task ${ok ? "succeeded" : "failed"}: ${task.label} (exit ${result.code})`);
      toast[ok ? "success" : "error"](`${task.label} ${ok ? "passed" : "failed"}`);
    } catch (err) {
      set((s) => ({ taskRuns: { ...s.taskRuns, [id]: "failed" } }));
      get().appendLog("error", `Task error: ${task.label} — ${(err as Error).message}`);
      toast.error(`${task.label} failed`, { description: (err as Error).message });
    }
  },
  runBuildTask: async () => {
    if (get().tasks.length === 0) await get().discoverTasks();
    const task = defaultBuildTask(get().tasks);
    if (!task) {
      toast.message("No build task found", { description: "Add one in tasks.json or package.json." });
      return;
    }
    await get().runTask(task.id);
  },
  runTestTask: async () => {
    if (get().tasks.length === 0) await get().discoverTasks();
    const task = defaultTestTask(get().tasks);
    if (!task) {
      toast.message("No test task found", { description: "Add one in tasks.json or package.json." });
      return;
    }
    await get().runTask(task.id);
  },

  breakpoints: {},
  toggleBreakpoint: (file, line) =>
    set((s) => {
      const cur = s.breakpoints[file] ?? [];
      const has = cur.includes(line);
      const next = has ? cur.filter((l) => l !== line) : [...cur, line].sort((a, b) => a - b);
      const map = { ...s.breakpoints };
      if (next.length === 0) delete map[file];
      else map[file] = next;
      return { breakpoints: map };
    }),
  clearBreakpoints: (file) =>
    set((s) => {
      if (!file) return { breakpoints: {} };
      const map = { ...s.breakpoints };
      delete map[file];
      return { breakpoints: map };
    }),
  launchConfigs: [],
  selectedDebugConfig: null,
  setSelectedDebugConfig: (name) => set({ selectedDebugConfig: name }),
  loadLaunchConfigs: async () => {
    const root = get().workspaceRoot;
    if (!isTauri() || !root) {
      set({ launchConfigs: [] });
      return;
    }
    const [vscode, zoc] = await Promise.all([
      fsReadText(joinPath(root, ".vscode/launch.json")),
      fsReadText(joinPath(root, ".zoc/launch.json")),
    ]);
    const configs = [
      ...(vscode ? parseLaunchJson(vscode) : []),
      ...(zoc ? parseLaunchJson(zoc) : []),
    ];
    set((s) => ({
      launchConfigs: configs,
      selectedDebugConfig:
        s.selectedDebugConfig && configs.some((c) => c.name === s.selectedDebugConfig)
          ? s.selectedDebugConfig
          : configs[0]?.name ?? null,
    }));
  },

  terminals: [],
  activeTerminalId: null,
  terminalProfiles: defaultTerminalProfiles(),
  terminalSplit: false,
  newTerminal: (profileId) => {
    const profiles = get().terminalProfiles;
    const profile = profiles.find((p) => p.id === profileId) ?? profiles[0];
    const id = `term-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
    const count = get().terminals.filter((t) => t.profileId === profile.id).length + 1;
    const session: TerminalSession = {
      id,
      title: count > 1 ? `${profile.name} (${count})` : profile.name,
      profileId: profile.id,
      status: "running",
      exitCode: null,
    };
    set((s) => ({ terminals: [...s.terminals, session], activeTerminalId: id }));
    return id;
  },
  closeTerminal: (id) =>
    set((s) => {
      const next = s.terminals.filter((t) => t.id !== id);
      const active =
        s.activeTerminalId === id ? next[next.length - 1]?.id ?? null : s.activeTerminalId;
      return { terminals: next, activeTerminalId: active };
    }),
  setActiveTerminal: (id) => set({ activeTerminalId: id }),
  renameTerminal: (id, title) =>
    set((s) => ({
      terminals: s.terminals.map((t) => (t.id === id ? { ...t, title: title.trim() || t.title } : t)),
    })),
  setTerminalExited: (id, code) =>
    set((s) => ({
      terminals: s.terminals.map((t) =>
        t.id === id ? { ...t, status: "exited" as const, exitCode: code } : t,
      ),
    })),
  toggleTerminalSplit: () => set((s) => ({ terminalSplit: !s.terminalSplit })),

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
    const client = await getAgentClient();

    // Backend reachability is decided by the Gateway `/health` endpoint — the
    // single canonical sidecar — NOT the legacy `/v1/sessions` API, which was
    // removed in the ecosystem merge. Deriving `liveMode` from `/health` keeps
    // chat runs (which DO have a live Gateway route, `POST /v1/agent/run`) from
    // being wrongly diverted to the offline mock path just because the session
    // store is gone. Partial clients/mocks without `health()` skip this probe.
    if (typeof client.health === "function") {
      try {
        await client.health();
        set({ liveMode: true });
      } catch {
        // Gateway not reachable (e.g. browser preview); a successful
        // listSessions below can still flip liveMode true for a legacy backend.
      }
    }

    // Session hydration is best-effort: the Gateway has no session store, so a
    // 404/failure here is expected. Keep any locally-cached sessions in that
    // case and leave `liveMode` as the `/health` probe set it.
    let sessions: Session[];
    try {
      sessions = await client.listSessions();
    } catch {
      return;
    }

    // R2.2: resolve the app-open intent from the persisted "last active"
    // pointer instead of unconditionally selecting sessions[0]. A `resume`
    // is produced only when `lastActiveId` names a session that still
    // exists; otherwise the resolver yields `fresh` and we start clean.
    const lastActiveId = loadLastActiveSession();
    const intent = resolveSessionIntent({
      trigger: "app-open",
      sessions,
      lastActiveId,
    });

    if (intent.kind === "resume" || intent.kind === "select") {
      const target = sessions.find((s) => s.id === intent.sessionId) ?? sessions[0];
      set({
        sessions,
        liveMode: true,
        activeSessionId: target.id,
        chat: entriesFromSession(target),
        agentItems: workflowItemsFromSession(target),
        plan: target.plan ?? null,
        workspaceRoot: target.workspace_root ?? get().workspaceRoot,
      });
      persistLastActiveSession(target.id);
      void get().loadMemoryStats();
      return;
    }

    // intent.kind === "fresh": never auto-resume a prior session.
    if (!sessions.length) {
      // No sessions yet — auto-create a single clean session so the user
      // can start working immediately. Best-effort: if the backend has no
      // session store, leave the panel empty (the user can start a local
      // session from the Sessions view).
      const workspaceRoot = get().workspaceRoot || "/tmp";
      const { provider, model } = get().selectedModel;
      try {
        const session = await client.createSession({
          title: "New Session",
          workspace_root: workspaceRoot,
          provider: provider || undefined,
          model: model || undefined,
        });
        set({
          sessions: [session],
          liveMode: true,
          activeSessionId: session.id,
          chat: entriesFromSession(session),
          agentItems: workflowItemsFromSession(session),
          plan: session.plan ?? null,
          workspaceRoot: session.workspace_root ?? get().workspaceRoot,
        });
        persistLastActiveSession(session.id);
        void get().loadMemoryStats();
      } catch {
        // No server-side session store — nothing to hydrate.
      }
      return;
    }

    // Sessions exist but none is an explicit resume target — keep the list
    // for the sidebar but start with a clean/empty active state rather than
    // auto-resuming the most-recent prior session.
    set({
      sessions,
      liveMode: true,
      activeSessionId: "",
      chat: [],
      agentItems: [],
      plan: null,
    });
    void get().loadMemoryStats();
  },

  selectSession: async (id) => {
    // R2.3/R2.4: a user-driven select. Route through the resolver so an id
    // that no longer exists falls back to a clean/fresh state instead of
    // leaving a dangling active pointer.
    const intent = resolveSessionIntent({
      trigger: "select",
      sessions: get().sessions,
      lastActiveId: loadLastActiveSession(),
      selectedId: id,
    });
    if (intent.kind !== "select") {
      set({ activeSessionId: "", chat: [], agentItems: [], plan: null });
      persistLastActiveSession(null);
      return;
    }
    // Load the conversation from the locally-cached session immediately so the
    // panel reflects the resumed session even when the backend has no session
    // store (the Gateway does not persist sessions). A successful backend
    // fetch below refreshes it with authoritative data.
    const cached = get().sessions.find((s) => s.id === intent.sessionId);
    set({
      activeSessionId: intent.sessionId,
      chat: cached ? entriesFromSession(cached) : [],
      agentItems: cached ? workflowItemsFromSession(cached) : [],
      plan: cached?.plan ?? null,
    });
    persistLastActiveSession(intent.sessionId);
    if (get().liveMode) {
      try {
        const client = await getAgentClient();
        const session = await client.getSession(intent.sessionId);
        set((s) => ({
          sessions: s.sessions.map((x) => (x.id === intent.sessionId ? session : x)),
          chat: entriesFromSession(session),
          agentItems: workflowItemsFromSession(session),
          plan: session.plan ?? null,
        }));
      } catch {
        /* keep cached */
      }
    }
    void get().loadMemoryStats();
    void get().loadProjectRules();
    void get().loadCheckpoints();
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
      }));
      // R2.1: "new chat" yields a fresh session. Persist its id as the new
      // last-active pointer so a later app-open resumes this one (not a
      // stale prior session).
      persistLastActiveSession(session.id);
      await track("session.created", { id: session.id });
      return session;
    } catch {
      // The canonical Gateway has no session store, so the create call 404s in
      // a Gateway-only deployment. Fall back to a locally-managed session so
      // the panel still connects and a fresh conversation can start.
      const { provider, model } = get().selectedModel;
      const now = new Date().toISOString();
      const session: Session = {
        id: `local-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        title,
        status: "active",
        workspace_root: workspaceRoot,
        provider: provider || null,
        model: model || null,
        created_at: now,
        updated_at: now,
        messages: [],
        plan: null,
        tool_calls: [],
      };
      set((s) => ({
        sessions: [session, ...s.sessions],
        activeSessionId: session.id,
        chat: [],
        agentItems: [],
        plan: null,
      }));
      persistLastActiveSession(session.id);
      await track("session.created", { id: session.id, local: true });
      return session;
    }
  },

  renameSession: async (id, newTitle) => {
    const title = newTitle.trim();
    if (!title) return false;
    const existing = get().sessions.find((s) => s.id === id);
    if (!existing) return false;
    if (existing.title === title) return true;

    const updatedAt = new Date().toISOString();
    const optimistic: Session = { ...existing, title, updated_at: updatedAt };
    set((s) => ({
      sessions: s.sessions.map((session) => (session.id === id ? optimistic : session)),
      chat: s.activeSessionId === id ? entriesFromSession(optimistic) : s.chat,
      agentItems: s.activeSessionId === id ? workflowItemsFromSession(optimistic) : s.agentItems,
      plan: s.activeSessionId === id ? optimistic.plan ?? null : s.plan,
    }));

    if (get().liveMode) {
      try {
        const client = await getAgentClient();
        const session = await client.updateSession(id, { title });
        set((s) => ({
          sessions: s.sessions.map((item) => (item.id === id ? session : item)),
          chat: s.activeSessionId === id ? entriesFromSession(session) : s.chat,
          agentItems: s.activeSessionId === id ? workflowItemsFromSession(session) : s.agentItems,
          plan: s.activeSessionId === id ? session.plan ?? null : s.plan,
        }));
      } catch (err) {
        await track("error", {
          stage: "renameSession",
          message: (err as Error).message,
        }).catch(() => undefined);
      }
    }

    await track("session.renamed", { id }).catch(() => undefined);
    return true;
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

    if (deletingActive) {
      // R2.5: deleting the active session yields a `fresh` intent — do NOT
      // auto-jump into another session. Start from a clean/empty state and
      // clear the last-active pointer so the next app-open does not resume
      // the now-deleted session.
      const intent = resolveSessionIntent({
        trigger: "delete-active",
        sessions: nextSessions,
        lastActiveId: loadLastActiveSession(),
        selectedId: id,
      });
      // intent.kind is always "fresh" for delete-active.
      void intent;
      set({
        sessions: nextSessions,
        activeSessionId: "",
        chat: [],
        agentItems: [],
        plan: null,
      });
      persistLastActiveSession(null);
    } else {
      set({ sessions: nextSessions });
      // If the deleted session happened to be the persisted pointer (but not
      // the active one), drop the stale pointer too.
      if (loadLastActiveSession() === id) persistLastActiveSession(null);
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
    const sessionId = get().activeSessionId;
    const outgoing = expandFileMentions(content, get());
    // Ask mode is pure read-only Q&A. Explicit slash commands are honored
    // below; everything else is submitted to the Gateway as a run.

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

    // Single run-decision + validation point (task 4.1). `prepareAgentRun`
    // trims the input, maps the Composer's Ask/Agent toggle to the Gateway
    // `mode` (R4.1, R4.2), and rejects empty/whitespace-only input by
    // producing NO request (R4.5). It is the only validation gate on this
    // path — no legacy `buildRunAgentRequest` payload is built here.
    const request = prepareAgentRun(outgoing, get().agentMode);
    if (!request) {
      // Empty / whitespace-only (or otherwise invalid) input — send nothing.
      return;
    }

    const userMsg: Message = {
      id: `local-${Date.now()}`,
      role: "user",
      content: request.input,
      created_at: new Date().toISOString(),
    };

    // Terminate any previous in-flight (e.g. slash-command) stream before
    // starting a new run so a stale stream's terminal handler can't clobber
    // the new run's state.
    currentAbort?.abort();
    currentAbort = null;

    // Echo the user message into the panel and mark a run active. The Gateway
    // issues the authoritative `runId` (set below once accepted); the single
    // SSE client `useAgentStream` — mounted in the run feed — drives the feed
    // from `GET /v1/agent/events` (R3.1). It renders text chunks while Ask is
    // active and structured Event_Rows while Agent is active (R4.3, R4.4).
    set((s) => ({
      chat: [...s.chat, { kind: "message", id: userMsg.id, message: userMsg }],
      agentItems: upsertWorkflowMessage(s.agentItems, userMsg),
      streaming: true,
      isRunning: true,
      runId: null,
      activeRunMode: request.mode,
      boundMessageId: userMsg.id,
    }));
    await track("session.message_sent", { id: sessionId });

    if (!get().liveMode) {
      // Mock fallback for browser preview (no sidecar reachable).
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
          activeRunMode: null,
        }));
      }, 400);
      return;
    }

    // Route the run to the Gateway — the single agent transport (R2.1, R2.6).
    // No legacy `agent-client` run/event/approval path is touched (R6.5).
    // `postAgentRun` resolves when the run is *accepted*; the run's lifecycle
    // (and completion) is observed on the SSE feed by `useAgentStream`.
    try {
      await ensureSelectedModelReady(get(), set);
      const modelContext = await resolveRunModelContext(get());
      const { runId } = await postAgentRun({
        ...request,
        model: modelContext.model,
        provider: modelContext.provider,
        apiKey: modelContext.apiKey,
        baseUrl: modelContext.baseUrl,
        workspaceRoot: modelContext.workspaceRoot,
        ...(modelContext.temperature !== undefined
          ? { temperature: modelContext.temperature }
          : {}),
        ...(modelContext.topP !== undefined ? { topP: modelContext.topP } : {}),
        ...(modelContext.topK !== undefined ? { topK: modelContext.topK } : {}),
        ...(modelContext.repeatPenalty !== undefined
          ? { repeatPenalty: modelContext.repeatPenalty }
          : {}),
        ...(modelContext.maxTokens !== undefined ? { maxTokens: modelContext.maxTokens } : {}),
      });
      set({ runId });
    } catch (err) {
      appendErrorChat(set, "sendUserMessage", err);
      set({ streaming: false, isRunning: false, runId: null, activeRunMode: null });
      // The submit failed and no run is active — release the next queued
      // message (if any) so the queue does not stall.
      const [next, ...rest] = get().messageQueue;
      if (next) {
        set({ messageQueue: rest });
        void get().sendUserMessage(next.content);
      }
    } finally {
      // Refresh the memory snapshot so the indicator reflects the new turn.
      // Best-effort — failure leaves the stale snapshot alone.
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
    // Legacy agent approval transport removed in the agent-ecosystem merge
    // (task 9.2). Agent approvals are now resolved through the Gateway via the
    // ApprovalRow → postAgentDecision path (gateway-client.ts); this
    // permission-grant shim only records the decision locally.
    await track("permission.resolve_approval", { callId, allowed });
    return true;
  },

  retryApproval: async (callId) => {
    // Legacy agent approval-retry transport removed in the agent-ecosystem
    // merge (task 9.2). The Gateway run loop owns run lifecycle/retries now;
    // this shim records the intent without re-driving a legacy run.
    await track("permission.retry_approval", { callId });
    return true;
  },

  cancelStream: () => {
    currentAbort?.abort();
    currentAbort = null;
    set({
      streaming: false,
      isRunning: false,
      runId: null,
      activeRunMode: null,
      agentPaused: false,
      messageQueue: [],
    });
  },

  pauseAgent: () => {
    // Only meaningful while a run is active; gating happens in consumeStream.
    if (get().streaming || get().isRunning) set({ agentPaused: true });
  },
  resumeAgent: () => set({ agentPaused: false }),

  queueUserMessage: (content) => {
    const text = content.trim();
    if (!text) return;
    // Only hold a message while a run is active; otherwise it would never be
    // released. Callers send directly when idle.
    if (get().streaming || get().isRunning) {
      const id = `q-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
      set((s) => ({ messageQueue: [...s.messageQueue, { id, content: text }] }));
    }
  },

  dequeueMessage: (id) =>
    set((s) => ({ messageQueue: s.messageQueue.filter((m) => m.id !== id) })),

  clearQueue: () => set({ messageQueue: [] }),

  reorderQueue: (fromIndex, toIndex) =>
    set((s) => {
      const queue = [...s.messageQueue];
      if (
        fromIndex < 0 ||
        fromIndex >= queue.length ||
        toIndex < 0 ||
        toIndex >= queue.length ||
        fromIndex === toIndex
      ) {
        return {};
      }
      const [moved] = queue.splice(fromIndex, 1);
      queue.splice(toIndex, 0, moved);
      return { messageQueue: queue };
    }),

  stopAndSend: (content) => {
    const text = content.trim();
    // Cancel the in-flight run (clears the queue) then send immediately.
    get().cancelStream();
    if (text) void get().sendUserMessage(text);
  },

  finishGatewayRun: (finishedRunId) => {
    const current = get().runId;
    if (finishedRunId && current && finishedRunId !== current) {
      return;
    }
    const [next, ...rest] = get().messageQueue;
    set({
      streaming: false,
      isRunning: false,
      runId: null,
      activeRunMode: null,
      agentPaused: false,
      messageQueue: rest,
    });
    if (next) {
      void get().sendUserMessage(next.content);
    }
  },

  commitAskStreamMessage: (runId, content, createdAt) => {
    const trimmed = content.trim();
    if (!trimmed) return;
    const id = `ask-final-${runId}`;
    const message: Message = {
      id,
      role: "assistant",
      content,
      created_at: createdAt ?? new Date().toISOString(),
    };
    set((s) => {
      if (s.chat.some((entry) => entry.id === id)) {
        return {};
      }
      return {
        chat: [...s.chat, { kind: "message", id, message }],
        agentItems: upsertWorkflowMessage(s.agentItems, message),
      };
    });
  },

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
    set((s) => ({ attachments: [...s.attachments, { id: `att-${Date.now()}`, ...a }] })),  removeAttachment: (id) =>
    set((s) => ({ attachments: s.attachments.filter((a) => a.id !== id) })),
  searchContextCandidates: async (query) => {
    const openFileFallback = (): ContextCandidate[] => {
      const q = query.toLowerCase();
      return get()
        .openFiles.filter((f) => f.path.toLowerCase().includes(q))
        .slice(0, 25)
        .map((f) => ({ kind: "file" as const, label: f.name, path: f.path, detail: f.path, line: null }));
    };
    if (!get().liveMode || !get().activeSessionId) return openFileFallback();
    try {
      const client = await getAgentClient();
      const out = await client.searchContext(get().activeSessionId, query, 25);
      return out.length > 0 ? out : openFileFallback();
    } catch {
      return openFileFallback();
    }
  },
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

  applyCurrentRun: async () => {
    const runId = get().reviewRunId;
    const sessionId = get().activeSessionId;
    if (!runId || !sessionId || !get().liveMode) return false;
    try {
      const client = await getAgentClient();
      const result = await client.applyRun(sessionId, runId);
      const failed = result.failed_files ?? [];
      await track("agent.run.applied", {
        runId,
        files: result.applied_files.length,
        failed: failed.length,
      });
      if (failed.length > 0) {
        // Partial apply: some files couldn't be written to the real
        // workspace. The backend has already torn down the isolated copy,
        // so the review can't be retried — surface the failures and clear
        // the (now-defunct) review state.
        appendErrorChat(
          set,
          "applyCurrentRun",
          new Error(
            `Applied ${result.applied_files.length} file(s), but ${failed.length} failed: ` +
              `${failed.slice(0, 5).join(", ")}${failed.length > 5 ? "…" : ""}. ` +
              "Check workspace permissions and re-run the agent for the rest.",
          ),
        );
        set({
          reviewRunId: null,
          pendingPatches: [],
          acceptedHunks: {},
          reviewValidation: null,
        });
        return false;
      }
      // The whole run landed atomically — clear the pending review queue so
      // the diff card collapses into its "all reviewed" state. Remember the
      // checkpoint so the user can one-click Undo this run.
      set((s) => {
        const appliedIds = s.pendingPatches.map((p) => p.id);
        const nextApplied = new Set(s.appliedPatchIds);
        for (const id of appliedIds) nextApplied.add(id);
        persistAppliedPatchIds(nextApplied);
        return {
          reviewRunId: null,
          pendingPatches: [],
          appliedPatchIds: nextApplied,
          acceptedHunks: {},
          reviewValidation: null,
          restorableRunId: result.checkpoint_id ?? runId,
        };
      });
      void get().loadCheckpoints();
      return true;
    } catch (err) {
      appendErrorChat(set, "applyCurrentRun", err as Error);
      return false;
    }
  },
  restoreCurrentRun: async () => {
    const runId = get().restorableRunId;
    const sessionId = get().activeSessionId;
    if (!runId || !sessionId || !get().liveMode) return false;
    try {
      const client = await getAgentClient();
      const result = await client.restoreRun(sessionId, runId);
      await track("agent.run.restored", { runId, files: result.restored_files.length });
      // Undo landed: the applied files are reverted on disk; the fs watcher
      // will refresh open buffers. Clear the undo affordance.
      set({ restorableRunId: null });
      return true;
    } catch (err) {
      appendErrorChat(set, "restoreCurrentRun", err as Error);
      return false;
    }
  },
  loadCheckpoints: async () => {
    if (!get().liveMode || !get().activeSessionId) {
      set({ checkpoints: [] });
      return;
    }
    try {
      const client = await getAgentClient();
      set({ checkpoints: await client.listCheckpoints(get().activeSessionId) });
    } catch {
      // Sidecar offline / endpoint missing — leave the list untouched.
    }
  },
  restoreCheckpoint: async (runId) => {
    const sessionId = get().activeSessionId;
    if (!runId || !sessionId || !get().liveMode) return false;
    try {
      const client = await getAgentClient();
      const result = await client.restoreRun(sessionId, runId);
      await track("agent.run.restored", { runId, files: result.restored_files.length });
      set((s) => ({
        restorableRunId: s.restorableRunId === runId ? null : s.restorableRunId,
      }));
      void get().loadCheckpoints();
      return true;
    } catch (err) {
      appendErrorChat(set, "restoreCheckpoint", err as Error);
      return false;
    }
  },
  discardCurrentRun: async () => {
    const runId = get().reviewRunId;
    const sessionId = get().activeSessionId;
    if (!runId || !sessionId || !get().liveMode) {
      set({ reviewRunId: null, pendingPatches: [], acceptedHunks: {}, reviewValidation: null });
      return;
    }
    try {
      const client = await getAgentClient();
      await client.discardRun(sessionId, runId);
      await track("agent.run.discarded", { runId });
    } catch (err) {
      appendErrorChat(set, "discardCurrentRun", err as Error);
    } finally {
      set({ reviewRunId: null, pendingPatches: [], acceptedHunks: {}, reviewValidation: null });
    }
  },

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

  openInlineEdit: (ctx) =>
    set({
      inlineEdit: {
        open: true,
        filePath: ctx.filePath,
        language: ctx.language ?? null,
        start: ctx.start,
        end: ctx.end,
        original: ctx.original,
        prefix: ctx.prefix,
        suffix: ctx.suffix,
        status: "idle",
        error: null,
      },
    }),
  closeInlineEdit: () => set({ inlineEdit: { ...INLINE_EDIT_CLOSED } }),
  submitInlineEdit: async (instruction) => {
    const ie = get().inlineEdit;
    const text = instruction.trim();
    if (!ie.open || !ie.filePath || !text) return false;
    set((s) => ({ inlineEdit: { ...s.inlineEdit, status: "loading", error: null } }));
    try {
      const client = await getAgentClient();
      const sessionId = await ensureBackendSession(client, get, set);
      const creds = await resolveProviderCreds(get());
      const result = await client.inlineEdit(sessionId, {
        selection: ie.original,
        instruction: text,
        language: ie.language,
        prefix: ie.prefix,
        suffix: ie.suffix,
        model: get().selectedModel.model || null,
        provider: creds.provider,
        apiKey: creds.apiKey,
        baseUrl: creds.baseUrl,
      });
      const edited = stripCodeFence(result.edited ?? "");
      const file = get().openFiles.find((f) => f.path === ie.filePath);
      if (!file) {
        set({ inlineEdit: { ...INLINE_EDIT_CLOSED } });
        return false;
      }
      const newFull = spliceText(file.content, ie.start, ie.end, edited);
      const patch = buildInlineEditPatch(file.path, file.content, newFull, `Inline edit: ${text}`);
      if (!patch) {
        // Model returned an identical selection — nothing to review.
        set({ inlineEdit: { ...INLINE_EDIT_CLOSED } });
        return false;
      }
      get().queueFindingPatch(patch);
      await track("inline_edit.queued", { file: file.path });
      set({ inlineEdit: { ...INLINE_EDIT_CLOSED }, mainView: "editor", activeFile: file.path });
      return true;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      set((s) => ({ inlineEdit: { ...s.inlineEdit, status: "error", error: message } }));
      return false;
    }
  },


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

  loadIndexStatus: async () => {
    if (!get().liveMode || !get().activeSessionId) return;
    try {
      const client = await getAgentClient();
      set({ indexStatus: await client.indexStatus(get().activeSessionId) });
    } catch {
      // Sidecar offline / endpoint missing — leave status untouched.
    }
  },

  loadProjectRules: async () => {
    if (!get().liveMode || !get().activeSessionId) {
      set({ projectRules: null });
      return;
    }
    try {
      const client = await getAgentClient();
      set({ projectRules: await client.getProjectRules(get().activeSessionId) });
    } catch {
      // Sidecar offline / endpoint missing — leave rules unset.
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
  setTodos: (todos: TodoItem[]) => void;
  addTestRun: (result: AgentTestRun) => void;
  addFinalSummary: (summary: string) => void;
  addError: (message: string) => void;
  /** Record/clear the id of the isolated run awaiting review. */
  setReviewRunId: (runId: string | null) => void;
  /** Record end-of-run validation results for the review card. */
  setReviewValidation: (validation: Record<string, string>) => void;
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
    // Unified run lifecycle (Part 4) + review-before-apply (Part 2.5).
    // The isolated-run id arrives on `checkpoint.created` (emitted before the
    // run) and is reasserted on `run.awaiting_review`; it is cleared once the
    // run is applied or discarded. Other lifecycle types remain no-ops here
    // to avoid duplicate cards during the migration.
    case "checkpoint.created":
      if (ev.run_id) h.setReviewRunId(ev.run_id);
      break;
    case "run.awaiting_review":
      if (ev.run_id) h.setReviewRunId(ev.run_id);
      break;
    case "run.applied":
    case "run.discarded":
      h.setReviewRunId(null);
      break;
    case "run.started":
    case "run.context_ready":
    case "run.error":
      break;
    case "diff.ready":
      if (ev.validation && Object.keys(ev.validation).length > 0) {
        h.setReviewValidation(ev.validation);
      }
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
  opts: { mode?: AgentMode; activeRunId?: string | null } = {},
): Promise<void> {
  // Capture the run mode at send time. Ask mode is a read-only Q&A transcript:
  // it must never accrete workspace-analysis / plan / to-do / diff / review /
  // final-summary workflow cards, even if the backend (or a misbehaving model)
  // emits those events. Assistant message streaming is always honored.
  const mode: AgentMode = opts.mode ?? useApp.getState().agentMode;
  const isAsk = mode === "ask";
  // The active run id the stream is bound to (R1.2). Events tagged with a
  // different `run_id` are stale cross-run replays and are discarded by
  // `decideIngest`. `null`/undefined (slash commands, retry) disables the
  // cross-run rule, preserving the prior behavior for those callers.
  const activeRunId: string | null = opts.activeRunId ?? null;
  // Per-run ingest seq floor used by `decideIngest` to drop duplicate/stale
  // deliveries (R1.4). The single shared `SeqCursor` authority in
  // `agent-client` owns the resubscribe cursor; this mirrors the applied floor
  // within this stream so re-delivered events are idempotently ignored.
  let highestSeq = 0;
  let assistantId: string | null = null;
  let assistantText = "";
  // Namespace workflow item ids by the bound run id when available so cards
  // stay associated with the run that produced them; otherwise fall back to a
  // synthetic id (slash commands / retries have no bound run).
  let streamRunId = activeRunId ?? `run-${Date.now()}`;
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
      // Ingestion gate (R1.2, R1.4): discard events from a superseded run
      // (cross-run `run_id` mismatch) and duplicate/stale re-deliveries before
      // applying anything to the chat or workflow timeline. The pause gate
      // above has already cleared, so the only outcomes here are apply/discard.
      const decision = decideIngest(ev, {
        highestSeq,
        paused: false,
        stopped: false,
        activeRunId,
      });
      if (decision === "discard") continue;
      highestSeq = Math.max(highestSeq, ev.seq);
      // Mirror sidecar log events into the Logs panel + the Agent output channel.
      if (ev.type === "log") {
        const level =
          ev.level === "warning" || ev.level === "error" || ev.level === "debug"
            ? ev.level
            : "info";
        useApp.getState().appendLog(level, ev.message);
        useApp.getState().appendOutput("Agent", `[${ev.level}] ${ev.message}`);
      }
      applyAgentEvent(ev, {
        startRun: () => {
          // Keep the run bound to the id assigned at send time (R1.3). Only
          // synthesize an id for callers that did not bind one (slash/retry).
          if (!activeRunId) {
            streamRunId = `run-${ev.seq || Date.now()}`;
            set({ runId: streamRunId, isRunning: true });
          } else {
            set({ isRunning: true });
          }
        },
        contextLoading: (message) => {
          if (isAsk) return;
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
          if (isAsk) return;
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
          if (isAsk) return;
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
          if (isAsk) return;
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
          if (isAsk) return;
          if (isPlaceholderPlan(p)) return;
          sawWorkflowArtifact = true;
          set((s) => ({
            plan: p,
            agentItems: upsertWorkflowPlan(s.agentItems, p),
          }));
        },
        updatePlanStep: (step) => {
          if (isAsk) return;
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
        setTodos: (todos) => {
          if (isAsk) return;
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
          if (isAsk) return;
          sawWorkflowArtifact = true;
          set((s) => ({ agentItems: upsertWorkflowTest(s.agentItems, result) }));
        },
        addFinalSummary: (summary) => {
          if (isAsk) return;
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
        setReviewRunId: (runId) => {
          if (isAsk) return;
          set({ reviewRunId: runId });
        },
        setReviewValidation: (validation) => {
          if (isAsk) return;
          set({ reviewValidation: validation });
        },
      });
    }
  } finally {
    finishAssistant();
  }
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
 * expects (see `services/agent/src/zoc_studio_agent/commands/recipes.py`).
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

function expandFileMentions(content: string, state: AppState): string {
  const active = state.activeFile;
  if (!active || !content.includes("@file")) return content;
  return content.replaceAll("@file", active);
}

interface ProviderCreds {
  provider: string | null;
  apiKey: string | null;
  baseUrl: string | null;
}

interface RunModelContext extends ProviderCreds {
  model: string | null;
  workspaceRoot: string | null;
  temperature?: number;
  topP?: number;
  topK?: number;
  repeatPenalty?: number;
  maxTokens?: number;
}

async function ensureSelectedModelReady(
  state: AppState,
  set: SetState,
): Promise<LlamaCppStatus | null> {
  const provider = state.selectedModel.provider;
  const model = state.selectedModel.model?.trim() || null;
  if (provider !== "llamacpp") {
    return null;
  }
  if (!model) {
    throw new Error("Select a local .gguf model before sending a llama.cpp run.");
  }
  const local = loadLocalModels().find((lm) => lm.id === model);
  if (!local) {
    throw new Error("The selected local .gguf model is no longer registered.");
  }
  const current = state.llamaCppStatus;
  if (current?.running && current.loaded_model_id === local.id && current.base_url) {
    return current;
  }

  const ngl = local.n_gpu_layers ?? DEFAULT_N_GPU_LAYERS;
  set((s) => ({
    llamaCppStatus: {
      running: false,
      host: s.llamaCppStatus?.host ?? local.host ?? null,
      port: s.llamaCppStatus?.port ?? local.port ?? null,
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

  let loaded: LlamaCppStatus;
  try {
    loaded = await llamacppLoad(
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
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    set((s) => ({
      llamaCppStatus: {
        running: false,
        host: s.llamaCppStatus?.host ?? local.host ?? null,
        port: s.llamaCppStatus?.port ?? local.port ?? null,
        base_url: null,
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
        last_error: message,
      },
    }));
    throw err;
  }
  set({ llamaCppStatus: loaded });
  if (!loaded.running || !loaded.base_url) {
    throw new Error(
      loaded.last_error || "llama-server did not become ready for the selected model.",
    );
  }
  return loaded;
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

async function resolveRunModelContext(state: AppState): Promise<RunModelContext> {
  const creds = await resolveProviderCreds(state);
  const model = state.selectedModel.model?.trim() || null;
  let baseUrl = creds.baseUrl;
  const sampling: Pick<
    RunModelContext,
    "temperature" | "topP" | "topK" | "repeatPenalty" | "maxTokens"
  > = {};

  if (creds.provider === "llamacpp") {
    baseUrl = state.llamaCppStatus?.base_url ?? null;
    if (model) {
      const local = loadLocalModels().find((lm) => lm.id === model);
      if (local) {
        sampling.temperature = local.temperature ?? DEFAULT_TEMPERATURE;
        sampling.topP = local.top_p ?? DEFAULT_TOP_P;
        sampling.topK = local.top_k ?? DEFAULT_TOP_K;
        sampling.repeatPenalty = local.repeat_penalty ?? DEFAULT_REPEAT_PENALTY;
        sampling.maxTokens = local.max_tokens ?? DEFAULT_MAX_TOKENS;
        if (!baseUrl) {
          const host = local.host || DEFAULT_HOST;
          const port = local.port || DEFAULT_PORT;
          baseUrl = `http://${host}:${port}`;
        }
      }
    }
    if (!model) {
      throw new Error("Select a local .gguf model before sending a llama.cpp run.");
    }
    if (!baseUrl) {
      throw new Error("llama-server is not ready for the selected local model.");
    }
  } else if (creds.provider && creds.provider !== "mock") {
    const cfg = getProvider(creds.provider);
    if (!model) {
      throw new Error(`Select a model for ${cfg?.name ?? creds.provider}.`);
    }
    if (!baseUrl) {
      throw new Error(`Provider ${cfg?.name ?? creds.provider} is missing a base URL.`);
    }
    if (cfg?.requiresKey && !creds.apiKey) {
      throw new Error(`Add an API key for ${cfg.name} in Settings before sending.`);
    }
  }

  return {
    provider: creds.provider,
    apiKey: creds.apiKey,
    baseUrl,
    model,
    workspaceRoot: activeWorkspaceRoot(state),
    ...sampling,
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

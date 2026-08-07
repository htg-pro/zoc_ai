/**
 * Typed wrappers around the Tauri commands exposed by the desktop shell.
 *
 * Argument names and return shapes here MUST match the Rust command
 * signatures in apps/desktop/src/*.rs verbatim — Tauri serializes args by
 * field name, so a mismatch silently degrades to "command not found" or
 * deserialization errors at runtime.
 *
 * In a pure-browser dev preview (no Tauri runtime) every call resolves to
 * a safe noop / mock value. We never throw — UI surfaces should gracefully
 * degrade when running outside the shell.
 */

export interface AgentStatus {
  port: number | null;
  running: boolean;
  restarts: number;
  last_error: string | null;
  /** Lifecycle phase from the Rust supervisor (§11.1). */
  status?: "starting" | "running" | "crashed" | "stopped";
  /** Absolute path of the crash report for the latest crash, if any. */
  crash_report?: string | null;
}

/** Mirrors Rust `sidecar::CrashReport` plus the file it was read from. */
export interface CrashReport {
  timestamp: string;
  exit_code: number | null;
  reason: string;
  last_log_lines: string[];
  rust_version: string;
  app_version: string;
  os_info: string;
  file?: string;
  path?: string;
}

/** Mirrors Rust `llama_server::LlamaServerStatus`. */
export interface LlamaCppStatus {
  running: boolean;
  /**
   * R3.9 — exactly one of stopped | starting | ready | error. Optional here so
   * the mirror stays compatible with a Desktop_Shell that has not yet been
   * rebuilt with the four-state supervisor; consumers fall back to `running`.
   */
  state?: "stopped" | "starting" | "ready" | "error";
  host: string | null;
  port: number | null;
  base_url: string | null;
  loaded_model_id: string | null;
  loaded_model_path: string | null;
  n_gpu_layers: number | null;
  n_ctx: number | null;
  n_threads: number | null;
  n_batch: number | null;
  temperature: number | null;
  top_p: number | null;
  top_k: number | null;
  repeat_penalty: number | null;
  max_tokens: number | null;
  flash_attn: boolean | null;
  /** R3.4 — trailing captured process output, populated on the error state. */
  log_tail?: string[];
  last_error: string | null;
}

/** Mirrors Rust `fs_commands::FileNode`. */
export interface FileNode {
  name: string;
  path: string;
  kind: "file" | "dir";
  children: FileNode[] | null;
}

export interface DesktopConfig {
  workspace_root: string | null;
  first_run_done: boolean;
  telemetry_opt_in: boolean;
  legacy_imported: boolean;
  /**
   * The Desktop_Core-owned local-model list (R13.6, task 22.1).
   *
   * Optional and read-only in practice: `desktop_config_set` ignores whatever a
   * caller sends here and carries the stored list across, so a config writer
   * cannot wipe the models by omitting them. Read it through `localModelsGet`
   * and write it through `localModelsSet`, which is the pair that owns it.
   */
  local_models?: unknown[];
}

export interface LegacyDetection {
  present: boolean;
  path: string | null;
  session_count: number;
}

export interface LegacyImportResult {
  imported_sessions: number;
  imported_settings: boolean;
}

/** Mirrors Rust `patch::ApplyPatchResult`. */
export interface ApplyPatchResult {
  path: string;
  created: boolean;
  deleted: boolean;
  bytes_written: number;
}

/** One operation staged by Rust before an all-or-nothing commit. */
export type TransactionOperation =
  | { kind: "write"; path: string; content: string }
  | { kind: "delete"; path: string }
  | { kind: "patch"; path: string; unified_diff: string };

/** Mirrors Rust `patch::ApplyTransactionResult`. */
export interface ApplyTransactionResult {
  written: number;
  deleted: number;
  checkpoint: string | null;
  checkpoint_error: string | null;
}

/** Payload emitted by the Rust watcher on `fs://changed`: a list of
 *  absolute paths that changed within the active debounce window. */
export type FsChangedPayload = string[];

type Invoke = <T>(cmd: string, args?: Record<string, unknown>) => Promise<T>;
type Listen = <T>(event: string, cb: (e: { payload: T }) => void) => Promise<() => void>;

interface TauriBindings {
  invoke: Invoke;
  listen: Listen;
}

let cached: TauriBindings | null | undefined;

async function bindings(): Promise<TauriBindings | null> {
  if (cached !== undefined) return cached;
  try {
    const core = await import("@tauri-apps/api/core");
    const event = await import("@tauri-apps/api/event");
    cached = {
      invoke: core.invoke as Invoke,
      listen: event.listen as unknown as Listen,
    };
  } catch {
    cached = null;
  }
  return cached;
}

export function isTauri(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in (window as object);
}

export async function minimizeWindow(): Promise<void> {
  if (!isTauri()) return;
  try {
    const { getCurrentWindow } = await import("@tauri-apps/api/window");
    await getCurrentWindow().minimize();
  } catch {
    /* browser preview or window API unavailable */
  }
}

export async function toggleMaximizeWindow(): Promise<void> {
  if (!isTauri()) return;
  try {
    const { getCurrentWindow } = await import("@tauri-apps/api/window");
    const win = getCurrentWindow();
    if (await win.isMaximized()) await win.unmaximize();
    else await win.maximize();
  } catch {
    /* browser preview or window API unavailable */
  }
}

export async function closeWindow(): Promise<void> {
  if (!isTauri()) return;
  try {
    const { getCurrentWindow } = await import("@tauri-apps/api/window");
    await getCurrentWindow().close();
  } catch {
    /* browser preview or window API unavailable */
  }
}

async function callOrNull<T>(cmd: string, args?: Record<string, unknown>): Promise<T | null> {
  const b = await bindings();
  if (!b) return null;
  try {
    return await b.invoke<T>(cmd, args);
  } catch {
    return null;
  }
}

async function callOrThrow<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  const b = await bindings();
  if (!b) throw new Error(`Tauri runtime unavailable for ${cmd}`);
  return b.invoke<T>(cmd, args);
}

export async function agentPort(): Promise<number | null> {
  return callOrNull<number>("agent_port");
}

export async function agentStatus(): Promise<AgentStatus | null> {
  return callOrNull<AgentStatus>("agent_status");
}

// ── Crash reporting & recovery (§11.1) ────────────────────────────────────

/** Persisted crash reports, newest first. Empty outside the desktop shell. */
export async function agentCrashReports(): Promise<CrashReport[]> {
  return (await callOrNull<CrashReport[]>("agent_crash_reports")) ?? [];
}

/** Delete every persisted crash report; returns how many were removed. */
export async function agentCrashReportsClear(): Promise<number> {
  return (await callOrNull<number>("agent_crash_reports_clear")) ?? 0;
}

/** Ask the supervisor to restart the sidecar now. */
export async function agentRestart(): Promise<void> {
  await callOrNull<void>("agent_restart");
}

export async function secretGet(key: string): Promise<string | null> {
  return callOrNull<string | null>("secret_get", { key });
}

export async function secretSet(key: string, value: string): Promise<void> {
  await callOrNull<void>("secret_set", { key, value });
}

export async function secretClear(key: string): Promise<void> {
  await callOrNull<void>("secret_clear", { key });
}

// ── Agent_Runtime (zoc-agent-chat-rebuild R3.4, R3.8, R13.6) ──────────────

/** Mirrors Rust `sidecar::RuntimeStatus`. */
export interface RuntimeStatus {
  port: number | null;
  running: boolean;
  restarts: number;
  last_error: string | null;
  status?: "starting" | "running" | "crashed" | "stopped";
  crash_report?: string | null;
}

/**
 * Mirrors Rust `sidecar::RuntimeEndpoint`.
 *
 * `token` is the per-launch bearer credential. It is withheld until the child is
 * actually running, so a `null` token with a `port` means "not ready yet" rather
 * than "unauthenticated runtime".
 */
export interface RuntimeEndpoint {
  port: number | null;
  token: string | null;
  status: "starting" | "running" | "crashed" | "stopped";
}

export async function agentRuntimeEndpoint(): Promise<RuntimeEndpoint | null> {
  return callOrNull<RuntimeEndpoint>("agent_runtime_endpoint");
}

export async function agentRuntimeStatus(): Promise<RuntimeStatus | null> {
  return callOrNull<RuntimeStatus>("agent_runtime_status");
}

/** Ask the supervisor to restart the Agent_Runtime now (R3.8). */
export async function runtimeRestart(): Promise<void> {
  await callOrNull<void>("runtime_restart");
}

export async function onRuntimeStatus(cb: (ev: RuntimeStatus) => void): Promise<() => void> {
  const b = await bindings();
  if (!b) return () => undefined;
  try {
    return await b.listen<RuntimeStatus>("runtime://status", (e) => cb(e.payload));
  } catch {
    return () => undefined;
  }
}

/** Mirrors Rust `hardware_fit::HardwareFit` (R13.6). */
export interface HardwareFit {
  state: "fits" | "tight" | "exceeds";
  reason: string;
  model_size_gb: number;
  required_gb: number;
  total_memory_gb: number | null;
  available_memory_gb: number | null;
  vram_gb: number | null;
  n_gpu_layers: number;
  gpu_bound: boolean;
}

/**
 * Probe whether a local GGUF will load on this machine (R13.6).
 *
 * Returns `null` outside the desktop shell rather than a synthetic verdict: the
 * model picker renders no fit chip at all in a browser preview, which is honest,
 * whereas a fabricated "fits" would be a claim about hardware we never saw.
 */
export async function localModelHardwareFit(
  model: string,
  nGpuLayers?: number,
): Promise<HardwareFit | null> {
  return callOrNull<HardwareFit>("local_model_hardware_fit", {
    model,
    nGpuLayers: nGpuLayers ?? 0,
  });
}

// ── Web (non-Tauri) HTTP helpers ──────────────────────────────────────────
// These are used when running in a plain browser (Replit preview) instead of
// the Tauri desktop shell.  All paths passed from the store are the absolute
// paths returned by the backend's file-tree, so the backend's `safePath`
// helper accepts them directly.

async function webFsGet<T>(
  endpoint: string,
  params: Record<string, string> = {},
): Promise<T | null> {
  try {
    const qs = new URLSearchParams(params).toString();
    const url = `${endpoint}${qs ? "?" + qs : ""}`;
    const res = await fetch(url);
    if (!res.ok) return null;
    return res.json() as Promise<T>;
  } catch {
    return null;
  }
}

async function webFsPost<T>(endpoint: string, body: unknown): Promise<T | null> {
  try {
    const res = await fetch(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!res.ok) return null;
    return res.json() as Promise<T>;
  } catch {
    return null;
  }
}

/** Lists a directory tree rooted at `root`, recursive up to `depth`. */
export async function fsListDir(root: string, depth?: number): Promise<FileNode[]> {
  if (!isTauri()) {
    const tree = await webFsGet<FileNode[]>("/api/fs/list", {
      path: root,
      depth: String(depth ?? 4),
    });
    return tree ?? [];
  }
  return (await callOrNull<FileNode[]>("fs_list_dir", { root, depth })) ?? [];
}

export async function fsReadText(path: string): Promise<string | null> {
  if (!isTauri()) {
    const data = await webFsGet<{ content: string }>("/api/fs/read", { path });
    return data?.content ?? null;
  }
  return callOrNull<string>("fs_read_text", { path });
}

export async function fsWriteText(path: string, content: string): Promise<boolean> {
  if (!isTauri()) {
    const res = await webFsPost<{ ok: boolean }>("/api/fs/write", { path, content });
    return res?.ok ?? false;
  }
  const b = await bindings();
  if (!b) return false;
  try {
    await b.invoke<void>("fs_write_text", { path, content });
    return true;
  } catch {
    return false;
  }
}

/** Mirrors Rust `fs_commands::FileStat`. */
export interface FileStat {
  exists: boolean;
  is_dir: boolean;
  is_file: boolean;
  size: number;
  modified_ms: number | null;
}

export async function fsStat(path: string): Promise<FileStat | null> {
  if (!isTauri()) {
    return webFsGet<FileStat>("/api/fs/stat", { path });
  }
  return callOrNull<FileStat>("fs_stat", { path });
}

/** Create an empty file. Throws (with the Rust error string) on failure or
 *  outside the desktop runtime. Returns the created absolute path. */
export async function fsCreateFile(path: string): Promise<string> {
  if (!isTauri()) {
    const res = await webFsPost<{ ok: boolean; path: string }>("/api/fs/create", { path });
    if (!res?.ok) throw new Error(`Failed to create file: ${path}`);
    return res.path;
  }
  return callOrThrow<string>("fs_create_file", { path });
}

export async function fsCreateDir(path: string): Promise<string> {
  if (!isTauri()) {
    const res = await webFsPost<{ ok: boolean; path: string }>("/api/fs/mkdir", { path });
    if (!res?.ok) throw new Error(`Failed to create directory: ${path}`);
    return res.path;
  }
  return callOrThrow<string>("fs_create_dir", { path });
}

export async function fsRename(from: string, to: string): Promise<string> {
  if (!isTauri()) {
    const res = await webFsPost<{ ok: boolean; path: string }>("/api/fs/rename", { from, to });
    if (!res?.ok) throw new Error(`Failed to rename ${from} → ${to}`);
    return res.path;
  }
  return callOrThrow<string>("fs_rename", { from, to });
}

export async function fsMove(from: string, to: string): Promise<string> {
  if (!isTauri()) {
    const res = await webFsPost<{ ok: boolean; path: string }>("/api/fs/move", { from, to });
    if (!res?.ok) throw new Error(`Failed to move ${from} → ${to}`);
    return res.path;
  }
  return callOrThrow<string>("fs_move", { from, to });
}

export async function fsDelete(path: string): Promise<void> {
  if (!isTauri()) {
    await fetch(`/api/fs/delete?path=${encodeURIComponent(path)}`, { method: "DELETE" });
    return;
  }
  await callOrThrow<void>("fs_delete", { path });
}

/** Duplicate a file/dir to a "… copy" sibling. Returns the new absolute path. */
export async function fsDuplicate(path: string): Promise<string> {
  if (!isTauri()) {
    const res = await webFsPost<{ ok: boolean; path: string }>("/api/fs/duplicate", { path });
    if (!res?.ok) throw new Error(`Failed to duplicate: ${path}`);
    return res.path;
  }
  return callOrThrow<string>("fs_duplicate", { path });
}

/** Reveal a path in the OS file manager (best-effort, no-op in web mode). */
export async function fsReveal(path: string): Promise<void> {
  if (!isTauri()) return; // No-op in browser
  await callOrThrow<void>("fs_reveal", { path });
}

// ── Workspace text search & replace (Phase 3) ─────────────────────────────
// Field names are snake_case to match the Rust `SearchOptions`/`ReplaceOptions`.

export interface SearchOptions {
  query: string;
  is_regex: boolean;
  case_sensitive: boolean;
  whole_word: boolean;
  includes: string[];
  excludes: string[];
  use_gitignore: boolean;
  max_results?: number;
}

export interface SearchLineMatch {
  line: number;
  column: number;
  start: number;
  end: number;
  text: string;
}

export interface SearchFileMatches {
  file: string;
  matches: SearchLineMatch[];
}

export interface SearchResults {
  files: SearchFileMatches[];
  total: number;
  truncated: boolean;
}

export interface ReplaceOptions extends SearchOptions {
  replacement: string;
  paths?: string[] | null;
}

export interface LinePreview {
  line: number;
  before: string;
  after: string;
}

export interface FileReplace {
  file: string;
  replacements: number;
  previews: LinePreview[];
}

export interface ReplacedFile {
  file: string;
  replacements: number;
  original: string;
}

export interface ReplaceSummary {
  files: ReplacedFile[];
  total_replacements: number;
}

export async function fsSearch(options: SearchOptions): Promise<SearchResults | null> {
  return callOrNull<SearchResults>("fs_search", { options });
}

export async function fsReplacePreview(options: ReplaceOptions): Promise<FileReplace[] | null> {
  return callOrNull<FileReplace[]>("fs_replace_preview", { options });
}

export async function fsReplaceApply(options: ReplaceOptions): Promise<ReplaceSummary> {
  return callOrThrow<ReplaceSummary>("fs_replace_apply", { options });
}

// ── Source control (Phase 4) ──────────────────────────────────────────────

export interface GitEntry {
  path: string;
  x: string;
  y: string;
  label: string;
}

export interface GitStatus {
  is_repo: boolean;
  branch: string | null;
  upstream: string | null;
  ahead: number;
  behind: number;
  staged: GitEntry[];
  unstaged: GitEntry[];
  untracked: GitEntry[];
  conflicts: GitEntry[];
}

export interface GitBranchInfo {
  name: string;
  current: boolean;
}

export interface GitCommit {
  hash: string;
  short: string;
  author: string;
  email: string;
  timestamp: number;
  subject: string;
}

export interface BlameLine {
  line: number;
  sha: string;
  author: string;
  summary: string;
}

export async function gitStatus(): Promise<GitStatus | null> {
  return callOrNull<GitStatus>("git_status", {});
}

export async function gitDiff(path: string, staged: boolean): Promise<string> {
  return (await callOrNull<string>("git_diff", { path, staged })) ?? "";
}

export async function gitStage(paths: string[]): Promise<void> {
  await callOrThrow<void>("git_stage", { paths });
}

export async function gitUnstage(paths: string[]): Promise<void> {
  await callOrThrow<void>("git_unstage", { paths });
}

export async function gitDiscard(paths: string[]): Promise<void> {
  await callOrThrow<void>("git_discard", { paths });
}

export async function gitCommit(message: string): Promise<string> {
  return callOrThrow<string>("git_commit", { message });
}

export async function gitCheckpointCommit(message: string): Promise<string> {
  return callOrThrow<string>("git_checkpoint_commit", { message });
}

export async function gitBranches(): Promise<GitBranchInfo[]> {
  return (await callOrNull<GitBranchInfo[]>("git_branches", {})) ?? [];
}

export async function gitCheckout(branch: string): Promise<void> {
  await callOrThrow<void>("git_checkout", { branch });
}

export async function gitCreateBranch(name: string): Promise<void> {
  await callOrThrow<void>("git_create_branch", { name });
}

export async function gitPull(): Promise<string> {
  return callOrThrow<string>("git_pull", {});
}

export async function gitPush(): Promise<string> {
  return callOrThrow<string>("git_push", {});
}

export async function gitLog(limit?: number): Promise<GitCommit[]> {
  return (await callOrNull<GitCommit[]>("git_log", { limit })) ?? [];
}

export async function gitConflicts(): Promise<string[]> {
  return (await callOrNull<string[]>("git_conflicts", {})) ?? [];
}

export async function gitBlame(path: string): Promise<BlameLine[]> {
  return (await callOrNull<BlameLine[]>("git_blame", { path })) ?? [];
}

// ── Validation checks (Phase 5) ───────────────────────────────────────────

export interface CheckResult {
  kind: string;
  stdout: string;
  stderr: string;
  code: number;
}

export async function runCheck(kind: string, cwd?: string): Promise<CheckResult | null> {
  return callOrNull<CheckResult>("run_check", { kind, cwd });
}

export interface TaskRunResult {
  stdout: string;
  stderr: string;
  code: number;
}

export async function runTaskCommand(
  command: string,
  args: string[],
  cwd?: string | null,
): Promise<TaskRunResult | null> {
  return callOrNull<TaskRunResult>("run_task", { command, args, cwd: cwd ?? undefined });
}

export async function fsWatchStart(root: string): Promise<boolean> {
  const b = await bindings();
  if (!b) return false;
  try {
    await b.invoke<void>("fs_watch_start", { root });
    return true;
  } catch {
    return false;
  }
}

export async function fsWatchStop(): Promise<boolean> {
  const b = await bindings();
  if (!b) return false;
  try {
    await b.invoke<void>("fs_watch_stop");
    return true;
  } catch {
    return false;
  }
}

/**
 * Open the native OS folder picker and return the chosen absolute path, or
 * `null` if the user cancelled or the dialog plugin is unavailable (browser
 * preview). Uses the Tauri dialog plugin directly so we don't need a custom
 * Rust command.
 */
export async function pickDirectory(defaultPath?: string | null): Promise<string | null> {
  try {
    const dialog = await import("@tauri-apps/plugin-dialog");
    const selected = await dialog.open({
      directory: true,
      multiple: false,
      title: "Choose your workspace folder",
      ...(defaultPath ? { defaultPath } : {}),
    });
    if (typeof selected === "string") return selected;
    return null;
  } catch {
    return null;
  }
}

/**
 * Open the native OS file picker filtered to llama.cpp `.gguf` weights. Used
 * by Settings → Models to register a locally-downloaded model. Returns the
 * absolute path or `null` if the user cancelled / the dialog plugin is
 * unavailable (browser preview).
 */
export async function pickGgufFile(defaultPath?: string | null): Promise<string | null> {
  try {
    const dialog = await import("@tauri-apps/plugin-dialog");
    const selected = await dialog.open({
      directory: false,
      multiple: false,
      title: "Choose a llama.cpp .gguf model",
      filters: [{ name: "GGUF weights", extensions: ["gguf"] }],
      ...(defaultPath ? { defaultPath } : {}),
    });
    if (typeof selected === "string") return selected;
    return null;
  } catch {
    return null;
  }
}

/** Push the active workspace root into the Rust supervisor so FS / patch
 *  commands have an authoritative scope to validate against. */
export async function setWorkspaceRoot(root: string | null): Promise<boolean> {
  const b = await bindings();
  if (!b) return false;
  try {
    await b.invoke<void>("set_workspace_root", { root });
    return true;
  } catch {
    return false;
  }
}

/** Apply a unified diff to a file inside the active workspace. Throws on
 *  rejection (mismatch, outside workspace) so the caller can surface the
 *  error to the user instead of silently swallowing a failed accept. */
export async function applyPatch(
  workspaceRoot: string,
  filePath: string,
  unifiedDiff: string,
): Promise<ApplyPatchResult | null> {
  const b = await bindings();
  if (!b) return null;
  return b.invoke<ApplyPatchResult>("apply_patch", {
    args: {
      workspace_root: workspaceRoot,
      file_path: filePath,
      unified_diff: unifiedDiff,
    },
  });
}

/** Stage and commit a set of workspace operations atomically in Rust. */
export async function applyTransaction(
  workspaceRoot: string,
  ops: TransactionOperation[],
): Promise<ApplyTransactionResult | null> {
  const b = await bindings();
  if (!b) return null;
  return b.invoke<ApplyTransactionResult>("apply_transaction", {
    args: { workspace_root: workspaceRoot, ops },
  });
}

export async function desktopConfigGet(): Promise<DesktopConfig> {
  return (
    (await callOrNull<DesktopConfig>("desktop_config_get")) ?? {
      workspace_root: null,
      first_run_done: false,
      telemetry_opt_in: false,
      legacy_imported: false,
    }
  );
}

export async function desktopConfigSet(config: DesktopConfig): Promise<DesktopConfig> {
  const out = await callOrNull<DesktopConfig>("desktop_config_set", { config });
  return out ?? config;
}

// ── Local-model list, Desktop_Core-owned (R13.6, task 22.1) ────────────────
//
// Two dedicated commands rather than a field on `desktopConfigSet`, because the
// models list and the workspace root are edited from different surfaces at
// different times: a whole-config write from either would carry the other's
// stale copy. Shapes stay `unknown[]` here — `lib/local-models.ts` owns the
// `LocalModel` type and narrows what comes back, so the bridge has no second
// definition to keep in step.

/** The stored list, or `null` outside the desktop shell. */
export async function localModelsGet(): Promise<unknown[] | null> {
  return callOrNull<unknown[]>("local_models_get");
}

/** Replace the stored list, returning what Desktop_Core wrote, or `null` outside the shell. */
export async function localModelsSet(models: readonly unknown[]): Promise<unknown[] | null> {
  return callOrNull<unknown[]>("local_models_set", { models });
}

export async function legacyDetect(): Promise<LegacyDetection> {
  return (
    (await callOrNull<LegacyDetection>("legacy_detect")) ?? {
      present: false,
      path: null,
      session_count: 0,
    }
  );
}

export async function legacyImport(): Promise<LegacyImportResult> {
  return (
    (await callOrNull<LegacyImportResult>("legacy_import")) ?? {
      imported_sessions: 0,
      imported_settings: false,
    }
  );
}

export async function telemetryLog(
  kind: string,
  meta: Record<string, unknown> = {},
): Promise<void> {
  await callOrNull<void>("telemetry_log", { event: { kind, meta } });
}

// ── Anonymous usage telemetry (§11.2) ─────────────────────────────────────
// `telemetry_event` writes to ~/.zoc-studio/telemetry.jsonl, the *only* store
// eligible for batch upload. `telemetry_log` above is the local-only diagnostic
// channel and is never uploaded.

export interface TelemetryStats {
  opted_in: boolean;
  events: number;
  bytes: number;
  path: string;
}

export async function telemetryEvent(
  kind: string,
  meta: Record<string, unknown> = {},
): Promise<void> {
  await callOrNull<void>("telemetry_event", { event: { kind, meta } });
}

export async function telemetryStats(): Promise<TelemetryStats> {
  return (
    (await callOrNull<TelemetryStats>("telemetry_stats")) ?? {
      opted_in: false,
      events: 0,
      bytes: 0,
      path: "",
    }
  );
}

export async function telemetryDrain(limit?: number): Promise<unknown[]> {
  return (await callOrNull<unknown[]>("telemetry_drain", { limit })) ?? [];
}

export async function telemetryClear(): Promise<void> {
  await callOrNull<void>("telemetry_clear");
}

// ── Read-only LAN session sharing (§10.1) ─────────────────────────────────

/** Mirrors Rust `share::ShareInfo`. */
export interface ShareInfo {
  url: string;
  token: string;
  run_id: string;
  port: number;
  lan_ip: string;
  viewers: number;
}

/**
 * Start (or return) the read-only LAN share. Throws with the Rust error string
 * when the sidecar isn't up yet or the port can't be bound, so the UI can tell
 * the user *why* sharing is unavailable instead of silently doing nothing.
 */
export async function shareSession(runId: string): Promise<ShareInfo> {
  return callOrThrow<ShareInfo>("share_session", { runId });
}

export async function shareSessionStop(): Promise<void> {
  await callOrNull<void>("share_session_stop");
}

export async function shareSessionStatus(): Promise<ShareInfo | null> {
  return callOrNull<ShareInfo | null>("share_session_status");
}

/** Subscribe to live viewer-count changes. Returns an unsubscribe fn. */
export async function onShareViewers(cb: (count: number) => void): Promise<() => void> {
  const b = await bindings();
  if (!b) return () => undefined;
  try {
    return await b.listen<number>("share://viewers", (e) => cb(e.payload));
  } catch {
    return () => undefined;
  }
}

/** Subscribe to fs://changed events. Returns an unsubscribe fn. */
export async function onFsChanged(cb: (paths: FsChangedPayload) => void): Promise<() => void> {
  const b = await bindings();
  if (!b) return () => undefined;
  try {
    return await b.listen<FsChangedPayload>("fs://changed", (e) => cb(e.payload));
  } catch {
    return () => undefined;
  }
}

export async function onAgentStatus(cb: (ev: AgentStatus) => void): Promise<() => void> {
  const b = await bindings();
  if (!b) return () => undefined;
  try {
    return await b.listen<AgentStatus>("agent://status", (e) => cb(e.payload));
  } catch {
    return () => undefined;
  }
}

/**
 * Ask the desktop shell to spawn `llama-server` with the given `.gguf` weights
 * loaded into VRAM. Resolves when `/health` returns 200, rejects on validation
 * or startup failure. Any previously-running `llama-server` is killed first.
 *
 * Browser preview (no Tauri runtime) returns a synthetic offline status so
 * the picker can fall back to a "desktop only" message instead of throwing.
 */
export async function llamacppLoad(
  modelId: string,
  path: string,
  nGpuLayers: number,
  nCtx?: number,
  nThreads?: number,
  nBatch?: number,
  flashAttn?: boolean,
  temperature?: number,
  topP?: number,
  topK?: number,
  repeatPenalty?: number,
  maxTokens?: number,
  host?: string,
  port?: number,
  readinessDeadlineSecs?: number,
): Promise<LlamaCppStatus> {
  const b = await bindings();
  if (!b) {
    const h = host?.trim() || "127.0.0.1";
    const p = port ?? 8080;
    const base = `http://${h}:${p}`;
    try {
      const res = await fetch(`${base}/health`);
      if (res.ok) {
        return {
          running: true,
          host: h,
          port: p,
          base_url: base,
          loaded_model_id: modelId,
          loaded_model_path: path,
          n_gpu_layers: nGpuLayers,
          n_ctx: nCtx ?? null,
          n_threads: nThreads ?? null,
          n_batch: nBatch ?? null,
          temperature: temperature ?? null,
          top_p: topP ?? null,
          top_k: topK ?? null,
          repeat_penalty: repeatPenalty ?? null,
          max_tokens: maxTokens ?? null,
          flash_attn: flashAttn ?? null,
          last_error: null,
        };
      }
    } catch {
      // fall through to offline status
    }
    return {
      running: false,
      host: h,
      port: p,
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
      last_error:
        "Tauri runtime unavailable (browser preview). Start llama-server on the configured host/port or use the desktop app.",
    };
  }
  return b.invoke<LlamaCppStatus>("llamacpp_load", {
    modelId,
    path,
    nGpuLayers,
    nCtx,
    nThreads,
    nBatch,
    flashAttn,
    temperature,
    topP,
    topK,
    repeatPenalty,
    maxTokens,
    host,
    port,
    // R3.10 — the per-model Readiness_Deadline override; the Desktop_Shell
    // falls back to DEFAULT_READINESS_DEADLINE when this is undefined (R3.11).
    readinessDeadlineSecs,
  });
}

export async function llamacppUnload(): Promise<LlamaCppStatus | null> {
  return callOrNull<LlamaCppStatus>("llamacpp_unload");
}

export async function llamacppStatus(): Promise<LlamaCppStatus | null> {
  return callOrNull<LlamaCppStatus>("llamacpp_status");
}

export async function onLlamaCppStatus(cb: (ev: LlamaCppStatus) => void): Promise<() => void> {
  const b = await bindings();
  if (!b) return () => undefined;
  try {
    return await b.listen<LlamaCppStatus>("llamacpp://status", (e) => cb(e.payload));
  } catch {
    return () => undefined;
  }
}

// Re-export to keep callOrThrow available for callers that want a real
// rejection (e.g. interactive Apply button surfaces) instead of `null`.
export const _tauriInvokeOrThrow = callOrThrow;

/** Test-only reset. */
export function __resetTauriBridge(): void {
  cached = undefined;
}

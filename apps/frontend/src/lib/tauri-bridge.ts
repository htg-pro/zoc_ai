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
}

/** Mirrors Rust `llama_server::LlamaServerStatus`. */
export interface LlamaCppStatus {
  running: boolean;
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

export async function secretGet(key: string): Promise<string | null> {
  return callOrNull<string | null>("secret_get", { key });
}

export async function secretSet(key: string, value: string): Promise<void> {
  await callOrNull<void>("secret_set", { key, value });
}

export async function secretClear(key: string): Promise<void> {
  await callOrNull<void>("secret_clear", { key });
}

/** Lists a directory tree rooted at `root`, recursive up to `depth`. */
export async function fsListDir(root: string, depth?: number): Promise<FileNode[]> {
  return (await callOrNull<FileNode[]>("fs_list_dir", { root, depth })) ?? [];
}

export async function fsReadText(path: string): Promise<string | null> {
  return callOrNull<string>("fs_read_text", { path });
}

export async function fsWriteText(path: string, content: string): Promise<boolean> {
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
  return callOrNull<FileStat>("fs_stat", { path });
}

/** Create an empty file. Throws (with the Rust error string) on failure or
 *  outside the desktop runtime. Returns the created absolute path. */
export async function fsCreateFile(path: string): Promise<string> {
  return callOrThrow<string>("fs_create_file", { path });
}

export async function fsCreateDir(path: string): Promise<string> {
  return callOrThrow<string>("fs_create_dir", { path });
}

export async function fsRename(from: string, to: string): Promise<string> {
  return callOrThrow<string>("fs_rename", { from, to });
}

export async function fsMove(from: string, to: string): Promise<string> {
  return callOrThrow<string>("fs_move", { from, to });
}

export async function fsDelete(path: string): Promise<void> {
  await callOrThrow<void>("fs_delete", { path });
}

/** Duplicate a file/dir to a "… copy" sibling. Returns the new absolute path. */
export async function fsDuplicate(path: string): Promise<string> {
  return callOrThrow<string>("fs_duplicate", { path });
}

/** Reveal a path in the OS file manager (best-effort). */
export async function fsReveal(path: string): Promise<void> {
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

export async function telemetryLog(kind: string, meta: Record<string, unknown> = {}): Promise<void> {
  await callOrNull<void>("telemetry_log", { event: { kind, meta } });
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
): Promise<LlamaCppStatus> {
  const b = await bindings();
  if (!b) {
    return {
      running: false,
      host: null,
      port: null,
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
      last_error: "Tauri runtime unavailable (browser preview)",
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
  });
}

export async function llamacppUnload(): Promise<LlamaCppStatus | null> {
  return callOrNull<LlamaCppStatus>("llamacpp_unload");
}

export async function llamacppStatus(): Promise<LlamaCppStatus | null> {
  return callOrNull<LlamaCppStatus>("llamacpp_status");
}

export async function onLlamaCppStatus(
  cb: (ev: LlamaCppStatus) => void,
): Promise<() => void> {
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

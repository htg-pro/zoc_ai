/**
 * Typed client for the FastAPI agent sidecar (Phase 4 wiring).
 *
 * Resolves its loopback port via the Tauri `agent_port` command and falls
 * back to `VITE_AGENT_PORT` in browser-only dev. Streaming endpoints are
 * built by opening a GET SSE subscription on `/agent/events` while POSTing
 * the trigger (`/agent/run` or `/commands/{id}/run`) in the background, so
 * a single `AsyncIterable<AgentEvent>` cleanly covers both ad-hoc prompts
 * and slash commands.
 */
import type {
  AgentEvent,
  CodeReviewReport,
  ContextStatus,
  CreateSessionRequest,
  CreateReplitTaskRequest,
  ReviseReplitPlanRequest,
  ReplitCheckpoint,
  ReplitPlan,
  ReplitTask,
  ReplitTaskLog,
  HealthResponse,
  IndexConfig,
  IndexQueryResult,
  IndexStatus,
  MemoryStats,
  Message,
  PermissionGrant,
  PostMessageRequest,
  ProviderDescriptor,
  RunAgentRequest,
  RunSlashCommandRequest,
  Session,
  SettingsSnapshot,
  SlashCommandDescriptor,
  TerminalSession,
  TestGenerationResult,
  ToolDescriptor,
  ToolGrant,
  UpdateIndexConfigRequest,
  UpdateSettingsRequest,
} from "@llama-studio/shared-types";

import { sseJson } from "./sse";
import { agentPort, agentStatus, isTauri } from "./tauri-bridge";

let cached: AgentClient | null = null;
let cachedPort: number | null = null;
const DESKTOP_AGENT_PORT_WAIT_MS = 20_000;
const DESKTOP_AGENT_PORT_POLL_MS = 250;
const DESKTOP_AGENT_HEALTH_WAIT_MS = 10_000;

/**
 * Per-session highest seen agent-event sequence number. Used to suppress
 * replay of historical events when (re)subscribing to `/agent/events`
 * after a previous run on the same session. Exported for tests.
 */
const lastSeq = new Map<string, number>();

export function __setLastSeq(sessionId: string, seq: number): void {
  lastSeq.set(sessionId, seq);
}

export function __resetLastSeq(sessionId?: string): void {
  if (sessionId) lastSeq.delete(sessionId);
  else lastSeq.clear();
}

export interface SpawnTerminalOpts {
  args?: string[];
  cwd?: string;
  cols?: number;
  rows?: number;
}

export interface CodeReviewRequest {
  diff?: string | null;
  excerpts?: Array<[string, string]> | null;
}

export interface TestGenRequest {
  target: string;
  max_attempts?: number;
}

export interface TestRunRequest {
  test_file: string;
  target?: string;
}

export interface DiscoveredModel {
  id: string;
  name: string;
}

export interface AgentClient {
  readonly baseUrl: string;
  readonly port: number;
  health(): Promise<HealthResponse>;
  listSessions(): Promise<Session[]>;
  getSession(id: string): Promise<Session>;
  createSession(req: CreateSessionRequest): Promise<Session>;
  deleteSession(id: string): Promise<void>;
  listMessages(sessionId: string): Promise<Message[]>;
  postMessage(sessionId: string, req: PostMessageRequest): Promise<Message>;
  runAgent(sessionId: string, req: RunAgentRequest, signal?: AbortSignal): AsyncIterable<AgentEvent>;
  listSlashCommands(): Promise<SlashCommandDescriptor[]>;
  runSlashCommand(
    sessionId: string,
    req: RunSlashCommandRequest,
    signal?: AbortSignal,
  ): AsyncIterable<AgentEvent>;
  codeReview(sessionId: string, req: CodeReviewRequest): Promise<CodeReviewReport>;
  testGen(sessionId: string, req: TestGenRequest): Promise<TestGenerationResult>;
  testRun(sessionId: string, req: TestRunRequest): Promise<TestGenerationResult>;
  listPermissions(sessionId: string): Promise<PermissionGrant[]>;
  setPermissions(sessionId: string, grants: PermissionGrant[]): Promise<PermissionGrant[]>;
  listToolGrants(sessionId: string): Promise<ToolGrant[]>;
  setToolGrants(sessionId: string, grants: ToolGrant[]): Promise<ToolGrant[]>;
  resolveApproval(sessionId: string, callId: string, allowed: boolean): Promise<{ resolved: boolean }>;
  retryApproval(sessionId: string, callId: string, signal?: AbortSignal): AsyncIterable<AgentEvent>;
  listTools(): Promise<ToolDescriptor[]>;
  listProviders(): Promise<ProviderDescriptor[]>;
  discoverModels(baseUrl: string, apiKey: string | null): Promise<DiscoveredModel[]>;
  getSettings(): Promise<SettingsSnapshot>;
  updateSettings(req: UpdateSettingsRequest): Promise<SettingsSnapshot>;
  indexStatus(sessionId: string): Promise<IndexStatus>;
  indexQuery(sessionId: string, q: string, k?: number): Promise<IndexQueryResult[]>;
  indexRebuild(sessionId: string): Promise<IndexStatus>;
  getIndexConfig(sessionId: string): Promise<IndexConfig>;
  updateIndexConfig(sessionId: string, req: UpdateIndexConfigRequest): Promise<IndexConfig>;
  spawnTerminal(cmd: string, opts?: SpawnTerminalOpts): Promise<TerminalSession>;
  stopTerminal(id: string): Promise<TerminalSession>;
  writeTerminal(id: string, data: string): Promise<void>;
  resizeTerminal(id: string, cols: number, rows: number): Promise<void>;
  terminalStream(id: string, signal?: AbortSignal): AsyncIterable<TerminalStreamEvent>;

  createReplitPlan(sessionId: string, prompt: string): Promise<ReplitPlan>;
  listReplitPlans(sessionId: string): Promise<ReplitPlan[]>;
  reviseReplitPlan(sessionId: string, planId: string, req: ReviseReplitPlanRequest): Promise<ReplitPlan>;
  approveReplitPlan(sessionId: string, planId: string): Promise<ReplitPlan>;
  listReplitTasks(sessionId: string): Promise<ReplitTask[]>;
  createReplitTask(sessionId: string, req: CreateReplitTaskRequest): Promise<ReplitTask>;
  queueReplitTask(sessionId: string, taskId: string): Promise<ReplitTask>;
  startReplitTask(sessionId: string, taskId: string): Promise<ReplitTask>;
  markReplitTaskReady(sessionId: string, taskId: string): Promise<ReplitTask>;
  applyReplitTask(sessionId: string, taskId: string): Promise<ReplitTask>;
  dismissReplitTask(sessionId: string, taskId: string): Promise<ReplitTask>;
  cancelReplitTask(sessionId: string, taskId: string): Promise<ReplitTask>;
  replitTaskLogs(sessionId: string, taskId: string): Promise<ReplitTaskLog[]>;
  replitTaskDiff(sessionId: string, taskId: string): Promise<{ diff: string }>;
  replitTaskTestResults(sessionId: string, taskId: string): Promise<{ output: string }>;
  listReplitCheckpoints(sessionId: string): Promise<ReplitCheckpoint[]>;
  rollbackReplitCheckpoint(sessionId: string, checkpointId: string): Promise<ReplitCheckpoint>;
  memoryStats(sessionId: string): Promise<MemoryStats>;
  compactMemory(sessionId: string): Promise<MemoryStats>;
  contextStatus(sessionId: string): Promise<ContextStatus>;
  forgetMemory(sessionId: string, keepLast?: number): Promise<MemoryStats>;
}

export type TerminalStreamEvent =
  | { type: "data"; chunk: string }
  | { type: "exit"; code: number | null }
  | { type: "error"; message: string };

async function resolvePort(): Promise<number> {
  const port = await agentPort();
  if (typeof port === "number" && port > 0) {
    if (isTauri()) await waitForAgentHealth(port);
    return port;
  }
  if (isTauri()) {
    return waitForDesktopAgentPort();
  }
  const env = (import.meta as { env?: Record<string, string | undefined> }).env;
  const fallback = env?.VITE_AGENT_PORT;
  return fallback ? Number.parseInt(fallback, 10) : 8765;
}

async function waitForDesktopAgentPort(): Promise<number> {
  const deadline = Date.now() + DESKTOP_AGENT_PORT_WAIT_MS;
  let lastError: string | null = null;

  while (Date.now() < deadline) {
    const status = await agentStatus();
    if (typeof status?.port === "number" && status.port > 0) {
      await waitForAgentHealth(status.port);
      return status.port;
    }
    if (status?.last_error) lastError = status.last_error;

    const port = await agentPort();
    if (typeof port === "number" && port > 0) {
      await waitForAgentHealth(port);
      return port;
    }

    await delay(DESKTOP_AGENT_PORT_POLL_MS);
  }

  throw new Error(
    lastError
      ? `Agent sidecar did not become ready: ${lastError}`
      : "Agent sidecar did not become ready before the startup timeout.",
  );
}

async function waitForAgentHealth(port: number): Promise<void> {
  const deadline = Date.now() + DESKTOP_AGENT_HEALTH_WAIT_MS;
  let lastError: string | null = null;
  const url = `http://127.0.0.1:${port}/health`;

  while (Date.now() < deadline) {
    try {
      const res = await fetch(url);
      if (res.ok) return;
      lastError = `http ${res.status}`;
    } catch (err) {
      lastError = (err as Error).message;
    }
    await delay(DESKTOP_AGENT_PORT_POLL_MS);
  }

  throw new Error(`Agent sidecar port ${port} did not pass /health: ${lastError ?? "timed out"}`);
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => globalThis.setTimeout(resolve, ms));
}

async function jsonFetch<T>(url: string, init: RequestInit = {}): Promise<T> {
  const headers = new Headers(init.headers ?? {});
  if (init.body && !headers.has("Content-Type")) headers.set("Content-Type", "application/json");
  const res = await fetch(url, { ...init, headers });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    let detail = text;
    try {
      const parsed = JSON.parse(text) as { detail?: unknown };
      if (typeof parsed.detail === "string") detail = parsed.detail;
      else if (parsed.detail !== undefined) detail = JSON.stringify(parsed.detail);
    } catch {
      /* keep raw text */
    }
    throw new Error(detail || `${init.method ?? "GET"} ${url} -> http ${res.status}`);
  }
  if (res.status === 204) return undefined as T;
  const ct = res.headers.get("content-type") ?? "";
  if (!ct.includes("application/json")) return undefined as T;
  return (await res.json()) as T;
}

/**
 * Open the session's SSE event stream, fire the given trigger POST, and
 * yield events until the trigger has settled and a `done`/`error` event
 * arrives (or the caller aborts).
 *
 * The agent backend's run / slash-command endpoints return their final
 * payload synchronously over POST while publishing events on a shared
 * per-session bus, which the `/agent/events` SSE handler replays-then-
 * subscribes. To make this reliable for the UI we must:
 *
 *   1. Open the SSE response *first*, awaiting headers, so the
 *      subscription is registered on the bus before the trigger fires.
 *   2. Pass `since_seq=<lastSeenForSession>` so we don't replay events
 *      from previous runs on the same session.
 *   3. Only treat a `done`/`error` event as the end of the stream once
 *      the trigger POST has actually settled — otherwise a replayed
 *      `done` from a prior run could close the iterator before the new
 *      run emits anything.
 */
async function* eventStream(
  v1: string,
  sessionId: string,
  trigger: { url: string; body: unknown },
  signal?: AbortSignal,
): AsyncIterable<AgentEvent> {
  if (!sessionId) {
    throw new Error("Cannot open event stream: no active session. Create or select a session first.");
  }
  const since = lastSeq.get(sessionId) ?? 0;
  const eventsUrl = `${v1}/sessions/${sessionId}/agent/events?since_seq=${since}`;
  const eventsHeaders = new Headers({ Accept: "text/event-stream" });
  // Send Last-Event-ID header for SSE reconnection support
  if (since > 0) {
    eventsHeaders.set("Last-Event-ID", String(since));
  }
  // 1. Establish the SSE connection (headers received) before triggering.
  const res = await fetch(eventsUrl, { headers: eventsHeaders, signal });
  if (!res.ok || !res.body) {
    throw new Error(`SSE ${eventsUrl} → http ${res.status}`);
  }

  // 2. Fire the trigger; we'll observe `triggerSettled` to gate stream end.
  let triggerError: Error | null = null;
  let triggerSettled = false;
  const triggerPromise = jsonFetch(trigger.url, {
    method: "POST",
    body: JSON.stringify(trigger.body),
    signal,
  })
    .catch((err: Error) => {
      triggerError = err;
    })
    .finally(() => {
      triggerSettled = true;
    });

  // 3. Parse SSE inline (so we control the reader lifecycle alongside the
  //    trigger) and yield typed events.
  const reader = res.body.getReader();
  void triggerPromise.then(() => {
    if (triggerError) {
      void reader.cancel();
    }
  });
  const decoder = new TextDecoder("utf-8");
  let buffer = "";
  try {
    outer: while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let sep: number;
      while ((sep = nextSseSeparator(buffer)) !== -1) {
        const raw = buffer.slice(0, sep);
        buffer = buffer.slice(sep + (buffer[sep] === "\r" ? 4 : 2));
        const parsed = parseSseEvent(raw);
        if (!parsed || !parsed.data) continue;
        const ev = parsed.data as AgentEvent;
        if (parsed.id !== undefined) {
          const seq = parseInt(parsed.id, 10);
          if (!isNaN(seq)) {
            const prev = lastSeq.get(sessionId) ?? 0;
            if (seq > prev) lastSeq.set(sessionId, seq);
          }
        }
        if (typeof ev.seq === "number") {
          const prev = lastSeq.get(sessionId) ?? 0;
          if (ev.seq > prev) lastSeq.set(sessionId, ev.seq);
        }
        yield ev;
        if (ev.type === "error") break outer;
        if (ev.type === "done" && triggerSettled) break outer;
      }
    }
  } finally {
    try {
      await reader.cancel();
    } catch {
      /* ignore */
    }
  }
  await triggerPromise;
  if (triggerError) throw triggerError;
}

async function* runAgentStream(
  v1: string,
  sessionId: string,
  req: RunAgentRequest,
  signal?: AbortSignal,
): AsyncIterable<AgentEvent> {
  const url = `${v1}/sessions/${sessionId}/agent/run`;
  try {
    for await (const ev of eventStream(v1, sessionId, { url, body: req }, signal)) {
      yield ev;
    }
  } catch (err) {
    if (signal?.aborted || !isLegacyRunAgentValidationError(err)) {
      throw err;
    }
    for await (const ev of eventStream(
      v1,
      sessionId,
      { url, body: legacyRunAgentRequest(req) },
      signal,
    )) {
      yield ev;
    }
  }
}

function legacyRunAgentRequest(req: RunAgentRequest): { prompt: string } {
  const prompt = req.prompt ?? req.message ?? "";
  const context = legacyWorkspaceContext(req);
  if (!context) return { prompt };
  return {
    prompt: `${prompt}\n\n---\nCurrent workspace context from the editor:\n${context}\nUse this already-open workspace. Inspect the workspace root directly; do not ask the user to upload or paste project files.`,
  };
}

function isLegacyRunAgentValidationError(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err);
  return message.includes("extra_forbidden") || message.includes("Extra inputs are not permitted");
}

function legacyWorkspaceContext(req: RunAgentRequest): string {
  const lines: string[] = [];
  if (req.workspacePath) lines.push(`workspace_root: ${req.workspacePath}`);
  if (req.activeFile) lines.push(`active_file: ${req.activeFile}`);
  if (req.selectedText) {
    lines.push("selected_text:");
    lines.push(fenced(clip(req.selectedText, 8_000)));
  }
  if (req.editorContent) {
    lines.push("active_editor_content:");
    lines.push(fenced(clip(req.editorContent, 16_000)));
  }
  const openFiles = req.openFiles ?? [];
  if (openFiles.length) {
    lines.push("open_files:");
    for (const file of openFiles.slice(0, 12)) {
      const dirty = file.dirty ? " dirty" : "";
      lines.push(`- ${file.path} (${file.language || "text"}${dirty})`);
      if (!req.editorContent && file.path === req.activeFile && file.content) {
        lines.push(fenced(clip(file.content, 12_000)));
      }
    }
  }
  return lines.join("\n");
}

function fenced(value: string): string {
  return `\`\`\`\n${value}\n\`\`\``;
}

function clip(value: string, limit: number): string {
  return value.length > limit ? `${value.slice(0, limit)}\n...[truncated]` : value;
}

function nextSseSeparator(buf: string): number {
  const a = buf.indexOf("\n\n");
  const b = buf.indexOf("\r\n\r\n");
  if (a === -1) return b;
  if (b === -1) return a;
  return Math.min(a, b);
}

function parseSseEvent(raw: string): { id?: string; data: unknown } | null {
  const lines = raw.split(/\r?\n/);
  const data: string[] = [];
  let id: string | undefined;
  for (const line of lines) {
    if (line.startsWith(":")) continue;
    if (line.startsWith("id:")) {
      id = line.slice(3).trim();
    } else if (line.startsWith("data:")) {
      data.push(line.slice(5).replace(/^\s/, ""));
    }
  }
  if (data.length === 0) return null;
  const payload = data.join("\n");
  try {
    return { id, data: JSON.parse(payload) };
  } catch {
    return { id, data: payload };
  }
}

function makeClient(port: number): AgentClient {
  const baseUrl = `http://127.0.0.1:${port}`;
  const v1 = `${baseUrl}/v1`;
  return {
    baseUrl,
    port,
    health: () => jsonFetch<HealthResponse>(`${baseUrl}/health`),
    listSessions: () => jsonFetch<Session[]>(`${v1}/sessions`),
    getSession: (id) => jsonFetch<Session>(`${v1}/sessions/${id}`),
    createSession: (req) =>
      jsonFetch<Session>(`${v1}/sessions`, { method: "POST", body: JSON.stringify(req) }),
    deleteSession: (id) => jsonFetch<void>(`${v1}/sessions/${id}`, { method: "DELETE" }),
    listMessages: (sessionId) => jsonFetch<Message[]>(`${v1}/sessions/${sessionId}/messages`),
    postMessage: (sessionId, req) =>
      jsonFetch<Message>(`${v1}/sessions/${sessionId}/messages`, {
        method: "POST",
        body: JSON.stringify(req),
      }),
    runAgent: (sessionId, req, signal) => runAgentStream(v1, sessionId, req, signal),
    listSlashCommands: () => jsonFetch<SlashCommandDescriptor[]>(`${v1}/commands`),
    runSlashCommand: (sessionId, req, signal) =>
      eventStream(
        v1,
        sessionId,
        { url: `${v1}/commands/${sessionId}/run`, body: req },
        signal,
      ),
    codeReview: (sessionId, req) =>
      jsonFetch<CodeReviewReport>(`${v1}/sessions/${sessionId}/review`, {
        method: "POST",
        body: JSON.stringify(req),
      }),
    testGen: (sessionId, req) =>
      jsonFetch<TestGenerationResult>(`${v1}/sessions/${sessionId}/testgen`, {
        method: "POST",
        body: JSON.stringify({ max_attempts: 2, ...req }),
      }),
    testRun: (sessionId, req) =>
      jsonFetch<TestGenerationResult>(`${v1}/sessions/${sessionId}/testrun`, {
        method: "POST",
        body: JSON.stringify(req),
      }),
    listPermissions: (sessionId) =>
      jsonFetch<PermissionGrant[]>(`${v1}/sessions/${sessionId}/permissions`),
    setPermissions: (sessionId, grants) =>
      jsonFetch<PermissionGrant[]>(`${v1}/sessions/${sessionId}/permissions`, {
        method: "POST",
        body: JSON.stringify(grants),
      }),
    listToolGrants: (sessionId) =>
      jsonFetch<ToolGrant[]>(`${v1}/sessions/${sessionId}/tool-grants`),
    setToolGrants: (sessionId, grants) =>
      jsonFetch<ToolGrant[]>(`${v1}/sessions/${sessionId}/tool-grants`, {
        method: "POST",
        body: JSON.stringify(grants),
      }),
    resolveApproval: (sessionId, callId, allowed) =>
      jsonFetch<{ resolved: boolean }>(
        `${v1}/sessions/${sessionId}/agent/approvals/${callId}`,
        { method: "POST", body: JSON.stringify({ allowed }) },
      ),
    retryApproval: (sessionId, callId, signal) =>
      eventStream(
        v1,
        sessionId,
        { url: `${v1}/sessions/${sessionId}/agent/approvals/${callId}/retry`, body: {} },
        signal,
      ),
    listTools: () => jsonFetch<ToolDescriptor[]>(`${v1}/tools`),
    listProviders: () => jsonFetch<ProviderDescriptor[]>(`${v1}/providers`),
    discoverModels: async (baseUrl, apiKey) => {
      const res = await jsonFetch<{ models: DiscoveredModel[] }>(`${v1}/providers/discover-models`, {
        method: "POST",
        body: JSON.stringify({ base_url: baseUrl, api_key: apiKey }),
      });
      return res?.models ?? [];
    },
    getSettings: () => jsonFetch<SettingsSnapshot>(`${v1}/settings`),
    updateSettings: (req) =>
      jsonFetch<SettingsSnapshot>(`${v1}/settings`, {
        method: "PATCH",
        body: JSON.stringify(req),
      }),
    indexStatus: (sessionId) =>
      jsonFetch<IndexStatus>(`${v1}/sessions/${sessionId}/index/status`),
    indexQuery: (sessionId, q, k = 8) =>
      jsonFetch<IndexQueryResult[]>(`${v1}/sessions/${sessionId}/index/query`, {
        method: "POST",
        body: JSON.stringify({ query: q, top_k: k }),
      }),
    indexRebuild: (sessionId) =>
      jsonFetch<IndexStatus>(`${v1}/sessions/${sessionId}/index/reindex`, {
        method: "POST",
      }),
    getIndexConfig: (sessionId) =>
      jsonFetch<IndexConfig>(`${v1}/sessions/${sessionId}/index/config`),
    updateIndexConfig: (sessionId, req) =>
      jsonFetch<IndexConfig>(`${v1}/sessions/${sessionId}/index/config`, {
        method: "PUT",
        body: JSON.stringify(req),
      }),
    spawnTerminal: (cmd, opts = {}) =>
      jsonFetch<TerminalSession>(`${v1}/terminal`, {
        method: "POST",
        body: JSON.stringify({
          cmd,
          args: opts.args ?? [],
          cwd: opts.cwd ?? null,
          cols: opts.cols ?? 120,
          rows: opts.rows ?? 32,
        }),
      }),
    stopTerminal: (id) =>
      jsonFetch<TerminalSession>(`${v1}/terminal/${id}/stop`, { method: "POST" }),
    writeTerminal: (id, data) =>
      jsonFetch<void>(`${v1}/terminal/${id}/input`, {
        method: "POST",
        body: JSON.stringify({ data }),
      }),
    resizeTerminal: (id, cols, rows) =>
      jsonFetch<void>(`${v1}/terminal/${id}/resize`, {
        method: "POST",
        body: JSON.stringify({ cols, rows }),
      }),
    terminalStream: (id, signal) =>
      sseJson<TerminalStreamEvent>(`${v1}/terminal/${id}/stream`, { signal }),

    createReplitPlan: (sessionId, prompt) =>
      jsonFetch<ReplitPlan>(`${v1}/sessions/${sessionId}/replit/plans`, {
        method: "POST",
        body: JSON.stringify({ prompt }),
      }),
    listReplitPlans: (sessionId) =>
      jsonFetch<ReplitPlan[]>(`${v1}/sessions/${sessionId}/replit/plans`),
    reviseReplitPlan: (sessionId, planId, req) =>
      jsonFetch<ReplitPlan>(`${v1}/sessions/${sessionId}/replit/plans/${planId}/revise`, {
        method: "POST",
        body: JSON.stringify(req),
      }),
    approveReplitPlan: (sessionId, planId) =>
      jsonFetch<ReplitPlan>(`${v1}/sessions/${sessionId}/replit/plans/${planId}/approve`, {
        method: "POST",
      }),
    listReplitTasks: (sessionId) =>
      jsonFetch<ReplitTask[]>(`${v1}/sessions/${sessionId}/replit/tasks`),
    createReplitTask: (sessionId, req) =>
      jsonFetch<ReplitTask>(`${v1}/sessions/${sessionId}/replit/tasks`, {
        method: "POST",
        body: JSON.stringify(req),
      }),
    queueReplitTask: (sessionId, taskId) =>
      jsonFetch<ReplitTask>(`${v1}/sessions/${sessionId}/replit/tasks/${taskId}/queue`, {
        method: "POST",
      }),
    startReplitTask: (sessionId, taskId) =>
      jsonFetch<ReplitTask>(`${v1}/sessions/${sessionId}/replit/tasks/${taskId}/start`, {
        method: "POST",
      }),
    markReplitTaskReady: (sessionId, taskId) =>
      jsonFetch<ReplitTask>(`${v1}/sessions/${sessionId}/replit/tasks/${taskId}/ready`, {
        method: "POST",
      }),
    applyReplitTask: (sessionId, taskId) =>
      jsonFetch<ReplitTask>(`${v1}/sessions/${sessionId}/replit/tasks/${taskId}/apply`, {
        method: "POST",
      }),
    dismissReplitTask: (sessionId, taskId) =>
      jsonFetch<ReplitTask>(`${v1}/sessions/${sessionId}/replit/tasks/${taskId}/dismiss`, {
        method: "POST",
      }),
    cancelReplitTask: (sessionId, taskId) =>
      jsonFetch<ReplitTask>(`${v1}/sessions/${sessionId}/replit/tasks/${taskId}/cancel`, {
        method: "POST",
      }),
    replitTaskLogs: (sessionId, taskId) =>
      jsonFetch<ReplitTaskLog[]>(`${v1}/sessions/${sessionId}/replit/tasks/${taskId}/logs`),
    replitTaskDiff: (sessionId, taskId) =>
      jsonFetch<{ diff: string }>(`${v1}/sessions/${sessionId}/replit/tasks/${taskId}/diff`),
    replitTaskTestResults: (sessionId, taskId) =>
      jsonFetch<{ output: string }>(
        `${v1}/sessions/${sessionId}/replit/tasks/${taskId}/test-results`,
      ),
    listReplitCheckpoints: (sessionId) =>
      jsonFetch<ReplitCheckpoint[]>(`${v1}/sessions/${sessionId}/replit/checkpoints`),
    rollbackReplitCheckpoint: (sessionId, checkpointId) =>
      jsonFetch<ReplitCheckpoint>(
        `${v1}/sessions/${sessionId}/replit/checkpoints/${checkpointId}/rollback`,
        { method: "POST" },
      ),
    memoryStats: (sessionId) =>
      jsonFetch<MemoryStats>(`${v1}/sessions/${sessionId}/memory/stats`),
    compactMemory: (sessionId) =>
      jsonFetch<MemoryStats>(`${v1}/sessions/${sessionId}/memory/compact`, {
        method: "POST",
      }),
    forgetMemory: (sessionId, keepLast = 20) =>
      jsonFetch<MemoryStats>(`${v1}/sessions/${sessionId}/memory/forget`, {
        method: "POST",
        body: JSON.stringify({ keep_last: keepLast }),
      }),
    contextStatus: (sessionId) =>
      jsonFetch<ContextStatus>(`${v1}/sessions/${sessionId}/context-status`),
  };
}

export async function getAgentClient(): Promise<AgentClient> {
  if (cached) return cached;
  const port = await resolvePort();
  cachedPort = port;
  cached = makeClient(port);
  return cached;
}

/** Build a client for an explicit port (tests, mock servers). */
export function makeAgentClient(port: number): AgentClient {
  return makeClient(port);
}

/** Reset the cached client (tests / port change). */
export function __resetAgentClient(): void {
  cached = null;
  cachedPort = null;
}

export function __cachedPort(): number | null {
  return cachedPort;
}

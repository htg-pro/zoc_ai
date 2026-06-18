/**
 * Typed client for the FastAPI sidecar (editor-support + slash-command paths).
 *
 * Resolves its loopback port via the Tauri `agent_port` command and falls
 * back to `VITE_AGENT_PORT` in browser-only dev.
 *
 * NOTE (zoc-agent-ecosystem-merge, task 9.2): the legacy **agent run / event /
 * approval transport** that previously lived here has been removed. The agent
 * run is now driven by the Gateway via `features/agent/gateway-client.ts`
 * (`postAgentRun` / `postAgentDecision`) and consumed by the single SSE client
 * `features/agent/useAgentStream.ts`. The `runAgent` streaming method, the
 * bespoke `/agent/events` SSE machinery (`eventStream`/`pumpSse`/
 * `resilientEventStream`), the `seq-cursor`/`reconnect` resume helpers, and the
 * legacy `resolveApproval`/`retryApproval` approval transport are all gone
 * (design.md "Deduplication and Collision-Resolution Map", table C). What
 * remains are the editor-support endpoints (sessions, messages, review,
 * inline-edit, providers, settings, indexer, terminal, memory, permissions,
 * tools) and the slash-command list/run path the surviving UI still uses.
 */
import type {
  AgentEvent,
  CheckpointInfo,
  CodeReviewReport,
  ContextCandidate,
  ContextStatus,
  CreateSessionRequest,
  HealthResponse,
  IndexConfig,
  IndexQueryResult,
  IndexStatus,
  InlineEditResult,
  MemoryStats,
  Message,
  PermissionGrant,
  PostMessageRequest,
  ProjectRulesInfo,
  ProviderDescriptor,
  RunSlashCommandRequest,
  Session,
  SettingsSnapshot,
  SlashCommandDescriptor,
  TerminalSession,
  TestGenerationResult,
  ToolDescriptor,
  ToolGrant,
  UpdateIndexConfigRequest,
  UpdateSessionRequest,
  UpdateSettingsRequest,
} from "@zoc-studio/shared-types";

import { resolveAgentPort } from "./agent-port";

let cached: AgentClient | null = null;
let cachedPort: number | null = null;

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

export interface InlineEditRequest {
  selection: string;
  instruction: string;
  language?: string | null;
  prefix?: string;
  suffix?: string;
  /** Optional model + bring-your-own cloud creds (same shape as run). */
  model?: string | null;
  provider?: string | null;
  apiKey?: string | null;
  baseUrl?: string | null;
}

export interface ApplyRunResult {
  run_id: string;
  status: string;
  applied_files: string[];
  /** Files that couldn't be written to the real workspace (partial apply). */
  failed_files?: string[];
  /** Run id of the captured pre-apply checkpoint (null if nothing applied). */
  checkpoint_id?: string | null;
}

export interface RestoreRunResult {
  run_id: string;
  status: string;
  restored_files: string[];
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
  updateSession(id: string, req: UpdateSessionRequest): Promise<Session>;
  deleteSession(id: string): Promise<void>;
  listMessages(sessionId: string): Promise<Message[]>;
  postMessage(sessionId: string, req: PostMessageRequest): Promise<Message>;
  /** Apply an isolated (review-before-apply) run's changes onto the real
   *  workspace. The single explicit approval gate for agent-authored edits. */
  applyRun(sessionId: string, runId: string): Promise<ApplyRunResult>;
  /** Undo a previously-applied run, restoring the pre-apply checkpoint. */
  restoreRun(sessionId: string, runId: string): Promise<RestoreRunResult>;
  /** List restorable checkpoints for the session, newest first. */
  listCheckpoints(sessionId: string): Promise<CheckpointInfo[]>;
  /** Search workspace files/folders/symbols for the `@` context picker. */
  searchContext(sessionId: string, query: string, limit?: number): Promise<ContextCandidate[]>;
  /** Discard an isolated run's changes — the real workspace stays untouched. */
  discardRun(sessionId: string, runId: string): Promise<{ run_id: string; status: string }>;
  listSlashCommands(): Promise<SlashCommandDescriptor[]>;
  runSlashCommand(
    sessionId: string,
    req: RunSlashCommandRequest,
    signal?: AbortSignal,
  ): AsyncIterable<AgentEvent>;
  codeReview(sessionId: string, req: CodeReviewRequest): Promise<CodeReviewReport>;
  /** Inline edit (Cmd-K): rewrite a selection per an instruction. */
  inlineEdit(sessionId: string, req: InlineEditRequest): Promise<InlineEditResult>;
  /** Project rules (.zoc/rules) active for the session's workspace. */
  getProjectRules(sessionId: string): Promise<ProjectRulesInfo>;
  testGen(sessionId: string, req: TestGenRequest): Promise<TestGenerationResult>;
  testRun(sessionId: string, req: TestRunRequest): Promise<TestGenerationResult>;
  listPermissions(sessionId: string): Promise<PermissionGrant[]>;
  setPermissions(sessionId: string, grants: PermissionGrant[]): Promise<PermissionGrant[]>;
  listToolGrants(sessionId: string): Promise<ToolGrant[]>;
  setToolGrants(sessionId: string, grants: ToolGrant[]): Promise<ToolGrant[]>;
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

  memoryStats(sessionId: string): Promise<MemoryStats>;
  compactMemory(sessionId: string): Promise<MemoryStats>;
  contextStatus(sessionId: string): Promise<ContextStatus>;
  forgetMemory(sessionId: string, keepLast?: number): Promise<MemoryStats>;
}

export type TerminalStreamEvent =
  | { type: "data"; chunk: string }
  | { type: "exit"; code: number | null }
  | { type: "error"; message: string };

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
 * Minimal text/event-stream parser exposed as an async iterator over typed
 * JSON payloads (inlined from the former `lib/sse.ts`, which was removed in the
 * agent-transport dedup). Used by `terminalStream` and the slash-command run
 * path. Each yielded value is the parsed `data:` line; multi-line `data:`
 * blocks are concatenated with newlines per the SSE spec.
 */
async function* sseJson<T = unknown>(
  url: string,
  init: RequestInit & { signal?: AbortSignal } = {},
): AsyncIterable<T> {
  const headers = new Headers(init.headers ?? {});
  headers.set("Accept", "text/event-stream");
  if (init.body && !headers.has("Content-Type")) {
    headers.set("Content-Type", "application/json");
  }
  const res = await fetch(url, { ...init, headers });
  if (!res.ok || !res.body) {
    const detail =
      res.status === 404
        ? `SSE ${url} → http 404 (session not found — the agent may need a valid session created first)`
        : `SSE ${url} → http ${res.status}`;
    throw new Error(detail);
  }
  const reader = res.body.getReader();
  const decoder = new TextDecoder("utf-8");
  let buffer = "";
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) {
        if (buffer.trim()) {
          const ev = parseSsePayload(buffer);
          if (ev !== undefined) yield ev as T;
        }
        return;
      }
      buffer += decoder.decode(value, { stream: true });
      let sep: number;
      while ((sep = nextSseSeparator(buffer)) !== -1) {
        const raw = buffer.slice(0, sep);
        buffer = buffer.slice(sep + (buffer[sep] === "\r" ? 4 : 2));
        const ev = parseSsePayload(raw);
        if (ev !== undefined) yield ev as T;
      }
    }
  } finally {
    try {
      await reader.cancel();
    } catch {
      /* ignore */
    }
  }
}

function nextSseSeparator(buf: string): number {
  const a = buf.indexOf("\n\n");
  const b = buf.indexOf("\r\n\r\n");
  if (a === -1) return b;
  if (b === -1) return a;
  return Math.min(a, b);
}

function parseSsePayload(raw: string): unknown {
  const lines = raw.split(/\r?\n/);
  const dataLines: string[] = [];
  for (const line of lines) {
    if (line.startsWith(":")) continue; // comment / heartbeat
    if (line.startsWith("data:")) {
      dataLines.push(line.slice(5).replace(/^\s/, ""));
    }
  }
  if (dataLines.length === 0) return undefined;
  const payload = dataLines.join("\n");
  try {
    return JSON.parse(payload);
  } catch {
    return payload;
  }
}

/**
 * Self-contained slash-command stream: open the session's `/agent/events` SSE
 * subscription, fire the slash-command trigger POST, and yield typed events
 * until the trigger settles and a `done`/`error` arrives (or the caller
 * aborts). This is intentionally simpler than the removed agent-run transport
 * — there is no seq-cursor resume or bounded reconnect (those belonged to the
 * retired agent run loop, now owned by the Gateway's `useAgentStream`).
 */
async function* slashCommandStream(
  v1: string,
  sessionId: string,
  trigger: { url: string; body: unknown },
  signal?: AbortSignal,
): AsyncIterable<AgentEvent> {
  if (!sessionId) {
    throw new Error("Cannot open event stream: no active session. Create or select a session first.");
  }
  const eventsUrl = `${v1}/sessions/${sessionId}/agent/events`;
  const res = await fetch(eventsUrl, {
    headers: new Headers({ Accept: "text/event-stream" }),
    signal,
  });
  if (!res.ok || !res.body) {
    throw new Error(`SSE ${eventsUrl} → http ${res.status}`);
  }

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

  const reader = res.body.getReader();
  void triggerPromise.then(() => {
    if (triggerError) void reader.cancel();
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
        const payload = parseSsePayload(raw);
        if (payload === undefined) continue;
        const ev = payload as AgentEvent;
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
    updateSession: (id, req) =>
      jsonFetch<Session>(`${v1}/sessions/${id}`, { method: "PATCH", body: JSON.stringify(req) }),
    deleteSession: (id) => jsonFetch<void>(`${v1}/sessions/${id}`, { method: "DELETE" }),
    listMessages: (sessionId) => jsonFetch<Message[]>(`${v1}/sessions/${sessionId}/messages`),
    postMessage: (sessionId, req) =>
      jsonFetch<Message>(`${v1}/sessions/${sessionId}/messages`, {
        method: "POST",
        body: JSON.stringify(req),
      }),
    applyRun: (sessionId, runId) =>
      jsonFetch<ApplyRunResult>(`${v1}/sessions/${sessionId}/agent/runs/${runId}/apply`, {
        method: "POST",
      }),
    restoreRun: (sessionId, runId) =>
      jsonFetch<RestoreRunResult>(`${v1}/sessions/${sessionId}/agent/runs/${runId}/restore`, {
        method: "POST",
      }),
    discardRun: (sessionId, runId) =>
      jsonFetch<{ run_id: string; status: string }>(
        `${v1}/sessions/${sessionId}/agent/runs/${runId}/discard`,
        { method: "POST" },
      ),
    listSlashCommands: () => jsonFetch<SlashCommandDescriptor[]>(`${v1}/commands`),
    runSlashCommand: (sessionId, req, signal) =>
      slashCommandStream(
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
    inlineEdit: (sessionId, req) =>
      jsonFetch<InlineEditResult>(`${v1}/sessions/${sessionId}/inline-edit`, {
        method: "POST",
        body: JSON.stringify({
          selection: req.selection,
          instruction: req.instruction,
          language: req.language ?? null,
          prefix: req.prefix ?? "",
          suffix: req.suffix ?? "",
          model: req.model ?? null,
          provider: req.provider ?? null,
          api_key: req.apiKey ?? null,
          base_url: req.baseUrl ?? null,
        }),
      }),
    getProjectRules: (sessionId) =>
      jsonFetch<ProjectRulesInfo>(`${v1}/sessions/${sessionId}/rules`),
    listCheckpoints: (sessionId) =>
      jsonFetch<CheckpointInfo[]>(`${v1}/sessions/${sessionId}/agent/checkpoints`),
    searchContext: (sessionId, query, limit = 25) =>
      jsonFetch<ContextCandidate[]>(
        `${v1}/sessions/${sessionId}/context/search?q=${encodeURIComponent(query)}&limit=${limit}`,
      ),
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
  const port = await resolveAgentPort();
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

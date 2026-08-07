/**
 * Workspace_Services client — zoc-agent-chat-rebuild R2.1, R6.3, R6.5, task 22.1.
 *
 * The calls the renderer makes to the retained Python surface **outside a Run**.
 * During a Run the renderer talks only to the Agent_Runtime (R6.5), so nothing
 * here is reachable from a streaming turn: this is the client for a session list
 * that has to load before there is a Run, a transcript that has to be restored
 * after one, and the settings, index, rules, and terminal surfaces that have
 * nothing to do with one.
 *
 * ## What is here, and why each group survived
 *
 * | Group | Why the renderer still calls it |
 * |---|---|
 * | `health` | The runtime-unavailable banner needs to say which process is down. |
 * | sessions | R15.1–R15.11's list, rename, archive, and delete. Metadata, never parts. |
 * | messages | R15.6: a completed Run's transcript is persisted here and read back on selection. |
 * | checkpoints | R10.5's references travel with a restored transcript. |
 * | context search | R12.1's mention index, which resolves while the user types — before a Run. |
 * | rules | R30.1 discovery, for the header's "rules applied" display. |
 * | settings | Gateway-scoped settings, read by Settings and never during a Run. |
 * | index | R6.1 names it: status, query, rebuild, files-changed, config. |
 * | terminal | The PTY host's control calls (spawn, stop, input, resize). |
 *
 * ## What is deliberately absent
 *
 * - **`slashCommandStream`, `sseJson`, `parseSsePayload`.** Named for removal in
 *   the module disposition. Every streaming path the Chat_Surface needs is the
 *   custom transport's (11.1), and the terminal's output stream stays on
 *   `agent-client.ts` until 26.2 rather than reintroducing an SSE parser here for
 *   one caller that the deletion step is about to repoint anyway.
 * - **Anything that makes a provider call**: inline edit, completions, providers,
 *   discover-models, memory compaction, context-status, tools, permissions, tool
 *   grants. R6.2 moved all of them to the Agent_Runtime.
 * - **Slash commands, review, testgen.** Retired, with the user-visible loss
 *   recorded in the design's retired-behaviour register.
 * - **`hardware`.** Relocated to Desktop_Core (R13.6); the renderer asks
 *   `local_model_hardware_fit` instead.
 * - **`apply` / `restore` / `discard` / `testrun`.** They survive on
 *   Workspace_Services but the *runtime* is their caller — they are tools inside
 *   the loop, and a renderer-side path to them would be a second way to write to
 *   the workspace that no permission gate sits in front of.
 *
 * `agent-client.ts` stays in place until 26.2, because eleven other features and
 * the Legacy_Panel still call through it. This module is additive: new code uses
 * it, and the old client is deleted with the panel rather than before it.
 *
 * ## Errors carry their body
 *
 * A failure throws {@link WorkspaceServicesRequestError} with the parsed body
 * attached, not a flattened string. `lib/errors.ts` already understands the
 * gateway's envelope — bare or wrapped in FastAPI's `detail` — and flattening
 * here would throw away the `code` and `retryable` fields every retry affordance
 * reads. Same shape as the transport's `RuntimeRequestError`, for the same reason.
 */

import type {
  CheckpointInfo,
  ContextCandidate,
  CreateSessionRequest,
  HealthResponse,
  IndexConfig,
  IndexQueryResult,
  IndexStatus,
  ProjectRulesInfo,
  Session,
  SettingsSnapshot,
  TerminalSession,
  UpdateIndexConfigRequest,
  UpdateSessionRequest,
  UpdateSettingsRequest,
} from "@zoc-studio/shared-types";

import {
  resolveWorkspaceServicesEndpoint,
  type ResolvedWorkspaceServices,
} from "./workspace-services-endpoint";

/** A non-2xx answer from Workspace_Services, with its body intact. */
export class WorkspaceServicesRequestError extends Error {
  readonly status: number;
  /** The parsed JSON body, or the raw text when it was not JSON. `null` when empty. */
  readonly body: unknown;

  constructor(status: number, message: string, body: unknown) {
    super(message);
    this.name = "WorkspaceServicesRequestError";
    this.status = status;
    this.body = body;
  }
}

export interface SpawnTerminalOpts {
  args?: string[];
  cwd?: string;
  cols?: number;
  rows?: number;
}

export interface WorkspaceServicesClient {
  readonly baseUrl: string;
  readonly port: number;

  health(): Promise<HealthResponse>;

  // ── Sessions (R15.1–R15.11, R35.1) ──────────────────────────────────────
  listSessions(): Promise<Session[]>;
  getSession(id: string): Promise<Session>;
  createSession(req: CreateSessionRequest): Promise<Session>;
  /** Rename, re-provider, re-model, or archive (`status: "closed"`, R15.11). */
  updateSession(id: string, req: UpdateSessionRequest): Promise<Session>;
  deleteSession(id: string): Promise<void>;

  // ── Transcript persistence (R15.6) ──────────────────────────────────────
  // ── Transcript persistence (R15.6) ──────────────────────────────────────
  //
  // Records are `unknown` here on purpose. A stored message is an AI SDK
  // `UIMessage` whose part union belongs to the Chat_Surface, so `lib` — which
  // R2.3 keeps free of chat-surface logic — is the wrong place to name it.
  // `features/chat/transcript-persistence.ts` is the one module that narrows them.
  listMessages(sessionId: string): Promise<readonly unknown[]>;
  /** Append one message, replacing any earlier record with the same id (R15.7). */
  postMessage(sessionId: string, message: unknown): Promise<readonly unknown[]>;
  /** Replace the whole transcript. The runtime's path; here for tests and tooling. */
  replaceMessages(sessionId: string, messages: readonly unknown[]): Promise<readonly unknown[]>;

  /** Restorable checkpoints, newest first (R10.5). */
  listCheckpoints(sessionId: string): Promise<CheckpointInfo[]>;

  /** Files, folders, and symbols for the composer's `@` index (R12.1). */
  searchContext(sessionId: string, query: string, limit?: number): Promise<ContextCandidate[]>;

  /** `.zoc/rules`, `.cursor/rules`, and `AGENTS.md` discovery (R30.1). */
  getProjectRules(sessionId: string): Promise<ProjectRulesInfo>;

  // ── Settings and the context index (R6.1, R6.3) ─────────────────────────
  getSettings(): Promise<SettingsSnapshot>;
  updateSettings(req: UpdateSettingsRequest): Promise<SettingsSnapshot>;
  indexStatus(sessionId: string): Promise<IndexStatus>;
  indexQuery(sessionId: string, query: string, topK?: number): Promise<IndexQueryResult[]>;
  indexRebuild(sessionId: string): Promise<IndexStatus>;
  indexFilesChanged(sessionId: string, paths: string[]): Promise<{ accepted: number }>;
  getIndexConfig(sessionId: string): Promise<IndexConfig>;
  updateIndexConfig(sessionId: string, req: UpdateIndexConfigRequest): Promise<IndexConfig>;

  // ── Terminal control, without its output stream (see the header) ─────────
  spawnTerminal(cmd: string, opts?: SpawnTerminalOpts): Promise<TerminalSession>;
  stopTerminal(id: string): Promise<TerminalSession>;
  writeTerminal(id: string, data: string): Promise<void>;
  resizeTerminal(id: string, cols: number, rows: number): Promise<void>;
}

async function readBody(response: Response): Promise<unknown> {
  const text = await response.text().catch(() => "");
  if (text.length === 0) return null;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

/** The sentence to put on the thrown error when the body has no better one. */
function messageOf(body: unknown, method: string, url: string, status: number): string {
  if (typeof body === "string" && body.trim().length > 0) return body;
  if (typeof body === "object" && body !== null) {
    const detail = (body as { detail?: unknown }).detail;
    if (typeof detail === "string" && detail.length > 0) return detail;
    const nested = typeof detail === "object" && detail !== null ? detail : body;
    const message = (nested as { message?: unknown }).message;
    if (typeof message === "string" && message.length > 0) return message;
  }
  return `${method} ${url} → http ${String(status)}`;
}

async function jsonFetch<T>(url: string, init: RequestInit = {}): Promise<T> {
  const headers = new Headers(init.headers ?? {});
  if (init.body !== undefined && init.body !== null && !headers.has("Content-Type")) {
    headers.set("Content-Type", "application/json");
  }
  const response = await fetch(url, { ...init, headers });
  if (!response.ok) {
    const body = await readBody(response);
    throw new WorkspaceServicesRequestError(
      response.status,
      messageOf(body, init.method ?? "GET", url, response.status),
      body,
    );
  }
  // 204 and a non-JSON 200 both mean "no value" to every caller here. Returning
  // `undefined` rather than throwing keeps `deleteSession` and the two terminal
  // writes from needing a second return shape.
  if (response.status === 204) return undefined as T;
  const contentType = response.headers.get("content-type") ?? "";
  if (!contentType.includes("application/json")) return undefined as T;
  return (await response.json()) as T;
}

export function makeWorkspaceServicesClient(port: number): WorkspaceServicesClient {
  const baseUrl = `http://127.0.0.1:${String(port)}`;
  const v1 = `${baseUrl}/v1`;
  const post = (body?: unknown): RequestInit => ({
    method: "POST",
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });

  return {
    baseUrl,
    port,

    health: () => jsonFetch<HealthResponse>(`${baseUrl}/health`),

    listSessions: () => jsonFetch<Session[]>(`${v1}/sessions`),
    getSession: (id) => jsonFetch<Session>(`${v1}/sessions/${id}`),
    createSession: (req) => jsonFetch<Session>(`${v1}/sessions`, post(req)),
    updateSession: (id, req) =>
      jsonFetch<Session>(`${v1}/sessions/${id}`, {
        method: "PATCH",
        body: JSON.stringify(req),
      }),
    deleteSession: (id) => jsonFetch<void>(`${v1}/sessions/${id}`, { method: "DELETE" }),

    listMessages: async (sessionId) =>
      (await jsonFetch<{ messages?: unknown[] }>(`${v1}/sessions/${sessionId}/messages`))
        .messages ?? [],
    postMessage: async (sessionId, message) =>
      (
        await jsonFetch<{ messages?: unknown[] }>(
          `${v1}/sessions/${sessionId}/messages`,
          post({ message }),
        )
      ).messages ?? [],
    replaceMessages: async (sessionId, messages) =>
      (
        await jsonFetch<{ messages?: unknown[] }>(`${v1}/sessions/${sessionId}/messages`, {
          method: "PUT",
          body: JSON.stringify({ messages }),
        })
      ).messages ?? [],

    listCheckpoints: (sessionId) =>
      jsonFetch<CheckpointInfo[]>(`${v1}/sessions/${sessionId}/agent/checkpoints`),

    searchContext: (sessionId, query, limit = 25) =>
      jsonFetch<ContextCandidate[]>(
        `${v1}/sessions/${sessionId}/context/search?q=${encodeURIComponent(query)}` +
          `&limit=${String(limit)}`,
      ),

    getProjectRules: (sessionId) =>
      jsonFetch<ProjectRulesInfo>(`${v1}/sessions/${sessionId}/rules`),

    getSettings: () => jsonFetch<SettingsSnapshot>(`${v1}/settings`),
    updateSettings: (req) =>
      jsonFetch<SettingsSnapshot>(`${v1}/settings`, {
        method: "PATCH",
        body: JSON.stringify(req),
      }),
    indexStatus: (sessionId) => jsonFetch<IndexStatus>(`${v1}/sessions/${sessionId}/index/status`),
    indexQuery: (sessionId, query, topK = 8) =>
      jsonFetch<IndexQueryResult[]>(
        `${v1}/sessions/${sessionId}/index/query`,
        post({ query, top_k: topK }),
      ),
    indexRebuild: (sessionId) =>
      jsonFetch<IndexStatus>(`${v1}/sessions/${sessionId}/index/reindex`, post()),
    indexFilesChanged: (sessionId, paths) =>
      jsonFetch<{ accepted: number }>(
        `${v1}/sessions/${sessionId}/index/fs-changed`,
        post({ paths }),
      ),
    getIndexConfig: (sessionId) =>
      jsonFetch<IndexConfig>(`${v1}/sessions/${sessionId}/index/config`),
    updateIndexConfig: (sessionId, req) =>
      jsonFetch<IndexConfig>(`${v1}/sessions/${sessionId}/index/config`, {
        method: "PUT",
        body: JSON.stringify(req),
      }),

    spawnTerminal: (cmd, opts = {}) =>
      jsonFetch<TerminalSession>(
        `${v1}/terminal`,
        post({
          cmd,
          args: opts.args ?? [],
          cwd: opts.cwd ?? null,
          cols: opts.cols ?? 120,
          rows: opts.rows ?? 32,
        }),
      ),
    stopTerminal: (id) => jsonFetch<TerminalSession>(`${v1}/terminal/${id}/stop`, post()),
    writeTerminal: (id, data) => jsonFetch<void>(`${v1}/terminal/${id}/input`, post({ data })),
    resizeTerminal: (id, cols, rows) =>
      jsonFetch<void>(`${v1}/terminal/${id}/resize`, post({ cols, rows })),
  };
}

let cached: WorkspaceServicesClient | null = null;
let cachedEndpoint: ResolvedWorkspaceServices | null = null;
let inFlight: Promise<WorkspaceServicesClient> | null = null;

/**
 * The shared client, resolving the endpoint on first use.
 *
 * The in-flight promise is shared as well as the result: a panel mount fires
 * several of these at once, and resolving once per caller would mean several
 * 30-second readiness polls racing each other on a cold start.
 */
export async function getWorkspaceServicesClient(
  signal?: AbortSignal,
): Promise<WorkspaceServicesClient> {
  if (cached !== null) return cached;
  inFlight ??= (async () => {
    const endpoint = await resolveWorkspaceServicesEndpoint(signal);
    cachedEndpoint = endpoint;
    cached = makeWorkspaceServicesClient(endpoint.port);
    return cached;
  })().finally(() => {
    inFlight = null;
  });
  return inFlight;
}

/** Reset the cached client — tests, and a sidecar restart that moved the port. */
export function resetWorkspaceServicesClient(): void {
  cached = null;
  cachedEndpoint = null;
  inFlight = null;
}

/** The endpoint the cached client was built on, or `null` before first use. */
export function workspaceServicesEndpoint(): ResolvedWorkspaceServices | null {
  return cachedEndpoint;
}

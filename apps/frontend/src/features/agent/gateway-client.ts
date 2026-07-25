/**
 * gateway-client.ts — the single agent transport for the preserved frontend.
 *
 * This module is the ONLY control-channel client the Agent_Panel uses to talk
 * to the ecosystem Gateway sidecar. It owns run decisions and model benchmark
 * requests; telemetry remains on the single SSE transport.
 *
 *   - `postAgentRun({ input, mode })`  → `POST /v1/agent/run`  → `{ runId }`
 *   - `postAgentDecision({ runId, decision })` → `POST /v1/agent/decision`
 *
 * Telemetry (the single ordered SSE feed) is consumed separately by
 * `useAgentStream.ts`. There is deliberately NO second event-stream
 * implementation here (Requirement 6.3): this file owns control only.
 *
 * The canonical Gateway routes live under `/v1/agent/*` (design.md
 * "Communication channels"). The base URL is resolved against the loopback
 * port the Tauri supervisor publishes, reusing the existing port resolver in
 * `@/lib/tauri-bridge` (`agentPort()` / `agentStatus()`), so the same
 * readiness handshake the rest of the app relies on is honored here too.
 *
 * Requirements: 2.1 (route runs to the Gateway), 2.6 (canonical endpoint
 * paths), 5.2 / 5.3 (post approve/reject decisions), 6.3 (single transport).
 */

import { resolveAgentPort } from "@/lib/agent-port";
import { getTrustConfig } from "@/lib/trust";
import type {
  ModelBenchmarkHistory,
  ModelBenchmarkRun,
  RunModelBenchmarkRequest,
} from "@zoc-studio/shared-types";

/** The two execution modes the Composer's Ask/Agent toggle selects. */
/**
 * Conversation modes (§12.2).
 *
 * `plan` runs the same stages as `agent` but stops for approval after the plan
 * is produced, so nothing is written until the user says so.
 */
export type AgentMode = "ask" | "plan" | "agent";

/**
 * A run request issued from the Composer. `input` is the (already trimmed,
 * non-empty) prompt text; `mode` mirrors the Ask/Agent toggle.
 */
export interface AgentRunRequest {
  input: string;
  mode: AgentMode;
  runId?: string | null;
  contextFiles?: ContextFileRef[];
  model?: string | null;
  provider?: string | null;
  apiKey?: string | null;
  baseUrl?: string | null;
  workspaceRoot?: string | null;
  reviewChanges?: boolean;
  temperature?: number | null;
  topP?: number | null;
  topK?: number | null;
  repeatPenalty?: number | null;
  maxTokens?: number | null;
  /** Editor context consumed by context-aware Ask Mode (§12.1). */
  context?: EditorRunContext | null;
}

/** Mirrors the gateway's `RequestContext` (§12.1). */
export interface EditorRunContext {
  activeFile?: string | null;
  selection?: string | null;
  cursorLine?: number | null;
  language?: string | null;
}

export interface ContextFileRef {
  token: string;
  path: string;
}

/** Verdicts the panel can post for a pending decision. */
export type AgentDecision = "approve" | "reject" | "continue" | "stop" | "apply" | "discard";

/**
 * A decision for an in-flight run: approve/reject for approval gates,
 * continue/stop for budget-continuation prompts.
 */
export interface AgentDecisionRequest {
  runId: string;
  decision: AgentDecision;
  acceptedPaths?: string[];
}

/** The accepted-run handle returned by `POST /v1/agent/run`. */
export interface AgentRunHandle {
  runId: string;
}

/** Resolve the loopback base URL the canonical `/v1/agent/*` paths hang off. */
async function resolveBaseUrl(): Promise<string> {
  const port = await resolveAgentPort();
  return `http://127.0.0.1:${port}`;
}

// ── JSON transport ────────────────────────────────────────────────────────

/**
 * An `Error` that carries the gateway's structured envelope alongside a
 * human-readable `message`, so `lib/errors.ts` can recover the `code` without
 * parsing prose. Throwing a real `Error` keeps every existing `catch` working.
 */
export class GatewayRequestError extends Error {
  readonly code: string;
  readonly details?: string;
  readonly retryable?: boolean;
  readonly status: number;

  constructor(
    message: string,
    init: { code: string; status: number; details?: string; retryable?: boolean },
  ) {
    super(message);
    this.name = "GatewayRequestError";
    this.code = init.code;
    this.status = init.status;
    this.details = init.details;
    this.retryable = init.retryable;
  }
}

/**
 * Read an error response into a `GatewayRequestError`.
 *
 * The gateway sends `{"detail": {code, message, details, retryable}}` (see
 * `zocai_gateway/errors.py`). Older/other handlers still send a plain string
 * `detail`, so both shapes are accepted and neither is ever allowed to reach the
 * UI as raw JSON.
 */
async function requestError(res: Response, path: string, method: string): Promise<GatewayRequestError> {
  const text = await res.text().catch(() => "");
  let message = text;
  let code = `http_${res.status}`;
  let details: string | undefined;
  let retryable: boolean | undefined;
  try {
    const parsed = JSON.parse(text) as { detail?: unknown };
    const detail = parsed.detail;
    if (typeof detail === "string") {
      message = detail;
    } else if (detail && typeof detail === "object") {
      const envelope = detail as {
        code?: unknown;
        message?: unknown;
        details?: unknown;
        retryable?: unknown;
      };
      if (typeof envelope.message === "string") message = envelope.message;
      if (typeof envelope.code === "string") code = envelope.code;
      if (typeof envelope.details === "string") details = envelope.details;
      if (typeof envelope.retryable === "boolean") retryable = envelope.retryable;
    }
  } catch {
    /* keep raw text */
  }
  return new GatewayRequestError(message || `${method} ${path} -> http ${res.status}`, {
    code,
    status: res.status,
    details,
    retryable,
  });
}

async function postJson<T>(path: string, body: unknown): Promise<T> {
  const baseUrl = await resolveBaseUrl();
  const res = await fetch(`${baseUrl}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    throw await requestError(res, path, "POST");
  }
  if (res.status === 204) return undefined as T;
  const ct = res.headers.get("content-type") ?? "";
  if (!ct.includes("application/json")) return undefined as T;
  return (await res.json()) as T;
}

async function getJson<T>(path: string): Promise<T> {
  const baseUrl = await resolveBaseUrl();
  const res = await fetch(`${baseUrl}${path}`);
  if (!res.ok) {
    throw await requestError(res, path, "GET");
  }
  return (await res.json()) as T;
}

/**
 * Derive the Gateway decision `kind` from the verdict: approval gates use
 * approve/reject, budget-continuation prompts use continue/stop. The same
 * ApprovalRow/`/decision` path carries both (R5.4), so the kind is inferred
 * from the chosen verdict rather than tracked separately.
 */
function decisionKind(decision: AgentDecision): "approval" | "budget-continuation" | "review" {
  if (decision === "apply" || decision === "discard") return "review";
  return decision === "continue" || decision === "stop" ? "budget-continuation" : "approval";
}

// ── Control-channel operations ─────────────────────────────────────────────

/**
 * Start a run on the Gateway (control channel, R2.1 / R2.6).
 *
 * The Composer's trimmed `input` is sent as the Gateway's `prompt` field and
 * the Ask/Agent toggle as `mode`; the run is identified on the telemetry
 * channel by the returned `runId`, which `useAgentStream.ts` passes back to
 * `GET /v1/agent/events`.
 */
export async function postAgentRun(req: AgentRunRequest): Promise<AgentRunHandle> {
  const accepted = await postJson<{ runId?: string; run_id?: string }>("/v1/agent/run", {
    prompt: req.input,
    mode: req.mode,
    // Part 7.1: send the live workspace trust PermissionConfig so the gateway
    // gates tools with the exact policy the UI configured (read as `req.permission`).
    permission: getTrustConfig(req.workspaceRoot),
    runId: req.runId ?? null,
    context_files: req.contextFiles ?? [],
    context: req.context ?? null,
    model: req.model ?? null,
    provider: req.provider ?? null,
    api_key: req.apiKey ?? null,
    base_url: req.baseUrl ?? null,
    workspace_root: req.workspaceRoot ?? null,
    review_changes: req.reviewChanges ?? false,
    temperature: req.temperature ?? null,
    top_p: req.topP ?? null,
    top_k: req.topK ?? null,
    repeat_penalty: req.repeatPenalty ?? null,
    max_tokens: req.maxTokens ?? null,
  });
  const runId = accepted.runId ?? accepted.run_id;
  if (!runId) {
    throw new Error("Gateway accepted the run without returning a runId.");
  }
  return { runId };
}

/**
 * Record an approval or budget-continuation decision for an in-flight run
 * (control channel, R5.2 / R5.3). The single decision client — the legacy
 * approval transport is removed.
 */
export async function postAgentDecision(req: AgentDecisionRequest): Promise<void> {
  await postJson<void>("/v1/agent/decision", {
    runId: req.runId,
    kind: decisionKind(req.decision),
    decision: req.decision,
    acceptedPaths: req.acceptedPaths ?? [],
  });
}

/**
 * The gateway's reply to a cancel request. `state` mirrors its `RunState`, and
 * `alreadyFinished` is true when there was nothing left to stop — the ordinary
 * outcome when Stop races completion or is pressed twice.
 */
export interface AgentCancelResult {
  runId: string;
  cancelled: boolean;
  state: string;
  alreadyFinished: boolean;
}

/**
 * Cooperatively stop one Gateway run without disturbing concurrent peers.
 *
 * Idempotent by contract: the endpoint reports the run's lifecycle state rather
 * than failing for a run it no longer tracks, so a Stop that arrives after the
 * run finished resolves normally instead of throwing "unknown run".
 */
export async function postAgentCancel(runId: string): Promise<AgentCancelResult> {
  const body = await postJson<Partial<AgentCancelResult> | undefined>(
    `/v1/agent/runs/${encodeURIComponent(runId)}/cancel`,
    {},
  );
  return {
    runId: body?.runId ?? runId,
    cancelled: body?.cancelled ?? false,
    state: body?.state ?? "unknown",
    alreadyFinished: body?.alreadyFinished ?? true,
  };
}

/** Run the gateway-owned fixed suite against the active local model. */
export async function postModelBenchmark(
  req: RunModelBenchmarkRequest,
): Promise<ModelBenchmarkRun> {
  return postJson<ModelBenchmarkRun>("/v1/model-benchmarks", req);
}

/** Read newest-first history for one local model. */
export async function getModelBenchmarkHistory(
  modelId: string,
): Promise<ModelBenchmarkHistory> {
  const query = new URLSearchParams({ modelId });
  return getJson<ModelBenchmarkHistory>(`/v1/model-benchmarks?${query.toString()}`);
}

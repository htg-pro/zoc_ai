/**
 * gateway-client.ts — the single agent transport for the preserved frontend.
 *
 * This module is the ONLY control-channel client the Agent_Panel uses to talk
 * to the ecosystem Gateway sidecar. It exposes exactly two control operations:
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

import { agentPort, agentStatus, isTauri } from "@/lib/tauri-bridge";

/** The two execution modes the Composer's Ask/Agent toggle selects. */
export type AgentMode = "ask" | "agent";

/**
 * A run request issued from the Composer. `input` is the (already trimmed,
 * non-empty) prompt text; `mode` mirrors the Ask/Agent toggle.
 */
export interface AgentRunRequest {
  input: string;
  mode: AgentMode;
}

/** Verdicts the ApprovalRow can post for a pending decision. */
export type AgentDecision = "approve" | "reject" | "continue" | "stop";

/**
 * A decision for an in-flight run: approve/reject for approval gates,
 * continue/stop for budget-continuation prompts.
 */
export interface AgentDecisionRequest {
  runId: string;
  decision: AgentDecision;
}

/** The accepted-run handle returned by `POST /v1/agent/run`. */
export interface AgentRunHandle {
  runId: string;
}

// ── Port / base-URL resolution ────────────────────────────────────────────
// The loopback port is published by the Tauri supervisor and surfaced through
// the existing tauri-bridge resolver. We wait for it (and /health) exactly the
// way the rest of the app does, so a run is never posted before the sidecar is
// ready (R2 / R10.3). Outside the desktop shell (browser preview / tests) we
// fall back to the dev port.

const PORT_WAIT_MS = 30_000;
const PORT_POLL_MS = 250;
const HEALTH_WAIT_MS = 30_000;
const DEFAULT_DEV_PORT = 8765;

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => globalThis.setTimeout(resolve, ms));
}

async function waitForHealth(port: number): Promise<void> {
  const deadline = Date.now() + HEALTH_WAIT_MS;
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
    await delay(PORT_POLL_MS);
  }
  throw new Error(`Gateway port ${port} did not pass /health: ${lastError ?? "timed out"}`);
}

async function waitForDesktopPort(): Promise<number> {
  const deadline = Date.now() + PORT_WAIT_MS;
  let lastError: string | null = null;
  while (Date.now() < deadline) {
    const status = await agentStatus();
    if (typeof status?.port === "number" && status.port > 0) {
      await waitForHealth(status.port);
      return status.port;
    }
    if (status?.last_error) lastError = status.last_error;

    const port = await agentPort();
    if (typeof port === "number" && port > 0) {
      await waitForHealth(port);
      return port;
    }
    await delay(PORT_POLL_MS);
  }
  throw new Error(
    lastError
      ? `Gateway sidecar did not become ready: ${lastError}`
      : "Gateway sidecar did not become ready before the startup timeout.",
  );
}

async function resolvePort(): Promise<number> {
  const port = await agentPort();
  if (typeof port === "number" && port > 0) {
    if (isTauri()) await waitForHealth(port);
    return port;
  }
  if (isTauri()) return waitForDesktopPort();
  const env = (import.meta as { env?: Record<string, string | undefined> }).env;
  const fallback = env?.VITE_AGENT_PORT;
  return fallback ? Number.parseInt(fallback, 10) : DEFAULT_DEV_PORT;
}

/** Resolve the loopback base URL the canonical `/v1/agent/*` paths hang off. */
async function resolveBaseUrl(): Promise<string> {
  const port = await resolvePort();
  return `http://127.0.0.1:${port}`;
}

// ── JSON transport ────────────────────────────────────────────────────────

async function postJson<T>(path: string, body: unknown): Promise<T> {
  const baseUrl = await resolveBaseUrl();
  const res = await fetch(`${baseUrl}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
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
    throw new Error(detail || `POST ${path} -> http ${res.status}`);
  }
  if (res.status === 204) return undefined as T;
  const ct = res.headers.get("content-type") ?? "";
  if (!ct.includes("application/json")) return undefined as T;
  return (await res.json()) as T;
}

/**
 * Derive the Gateway decision `kind` from the verdict: approval gates use
 * approve/reject, budget-continuation prompts use continue/stop. The same
 * ApprovalRow/`/decision` path carries both (R5.4), so the kind is inferred
 * from the chosen verdict rather than tracked separately.
 */
function decisionKind(decision: AgentDecision): "approval" | "budget-continuation" {
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
  const accepted = await postJson<{ runId: string }>("/v1/agent/run", {
    prompt: req.input,
    mode: req.mode,
  });
  return { runId: accepted.runId };
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
  });
}

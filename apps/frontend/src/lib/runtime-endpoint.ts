/**
 * Agent_Runtime endpoint resolver — zoc-agent-chat-rebuild R2.1, R3.3, R3.4.
 *
 * Replaces the runtime half of `lib/agent-port.ts`. The split is the point:
 * there are now two loopback services with two independent lifecycles, and one
 * resolver that returns "the port" cannot say which one it means. This module
 * owns the Agent_Runtime; `workspace-services-endpoint.ts` owns the retained
 * Python surface.
 *
 * The budget constants are carried over unchanged from `agent-port.ts`
 * deliberately — they were tuned against a real cold start on a slow disk, and
 * re-deriving them would be a regression risk dressed as a cleanup.
 *
 * Readiness is **a 200 from `/health` presented with the token**, not a port
 * number. A port with no token behind it is a runtime the surface cannot use,
 * and treating it as ready just moves the failure to the first real request.
 */

import {
  agentRuntimeEndpoint,
  agentRuntimeStatus,
  isTauri,
  type RuntimeEndpoint,
} from "./tauri-bridge";

export const PORT_WAIT_MS = 30_000;
export const HEALTH_WAIT_MS = 30_000;
export const PORT_POLL_MS = 250;

/**
 * Dev fallback for a browser-only preview, where no supervisor exists.
 *
 * Distinct from the Python sidecar's `DEFAULT_DEV_PORT` so the two cannot be
 * confused when both are running.
 */
export const DEFAULT_DEV_RUNTIME_PORT = 3011;

/** The runtime could not be reached within its readiness budget (R3.3). */
export class RuntimeUnavailableError extends Error {
  readonly code = "runtime_unavailable";

  constructor(reason: string) {
    super(`The agent runtime did not become ready: ${reason}`);
    this.name = "RuntimeUnavailableError";
  }
}

export interface ResolvedRuntime {
  readonly port: number;
  /** Empty string only in a browser preview, where admission is not enforced. */
  readonly token: string;
  readonly baseUrl: string;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => globalThis.setTimeout(resolve, ms));
}

/**
 * Poll `/health` until it answers 200 with the token presented.
 *
 * The token is sent even though `/health` does not require it. That is not
 * redundant: it is what makes this a check of the credential path rather than of
 * the socket. A runtime whose token the supervisor rotated mid-handshake answers
 * the unauthenticated probe and refuses everything the surface will actually
 * send, and the point of a readiness gate is to catch that here.
 */
export async function waitForRuntimeHealth(
  port: number,
  token: string,
  signal?: AbortSignal,
): Promise<void> {
  const deadline = Date.now() + HEALTH_WAIT_MS;
  let lastError = "timed out";
  const url = `http://127.0.0.1:${port}/health`;
  const headers: Record<string, string> =
    token.length > 0 ? { authorization: `Bearer ${token}` } : {};

  while (Date.now() < deadline) {
    signal?.throwIfAborted();
    try {
      const response = await fetch(url, { headers, signal });
      if (response.ok) return;
      lastError = `http ${response.status}`;
    } catch (cause) {
      // An aborted probe is a cancellation, not a failed poll: rethrowing here
      // stops the loop from spending another poll interval on a caller that has
      // already walked away.
      signal?.throwIfAborted();
      lastError = cause instanceof Error ? cause.message : String(cause);
    }
    await delay(PORT_POLL_MS);
  }

  throw new RuntimeUnavailableError(`port ${port} did not pass /health (${lastError})`);
}

/**
 * Ask the supervisor why the handshake never completed — once, on the failure
 * path only.
 *
 * The endpoint payload deliberately carries no error text: it carries a
 * credential, and the fewer fields riding alongside a credential the better. The
 * diagnostic therefore comes from `agent_runtime_status`, which is already in the
 * renderer's capability set. Reading it per poll would double the IPC for 30 s to
 * collect a string nobody looks at unless the resolve throws.
 */
async function supervisorFailureReason(fallback: string): Promise<string> {
  const status = await agentRuntimeStatus();
  if (status?.last_error) return status.last_error;
  if (status?.status === "crashed") return "the runtime crashed during startup";
  return fallback;
}

function isUsable(endpoint: RuntimeEndpoint | null): endpoint is RuntimeEndpoint & {
  port: number;
  token: string;
} {
  return (
    endpoint !== null &&
    typeof endpoint.port === "number" &&
    endpoint.port > 0 &&
    typeof endpoint.token === "string" &&
    endpoint.token.length > 0
  );
}

/**
 * Resolve the Agent_Runtime's loopback endpoint and launch token.
 *
 * Throws `RuntimeUnavailableError` on budget exhaustion rather than returning a
 * sentinel: every caller needs the token, so there is no useful degraded value
 * to hand back, and a thrown error is what the transport's re-attach path and
 * the crash banner both already key off.
 */
export async function resolveRuntimeEndpoint(signal?: AbortSignal): Promise<ResolvedRuntime> {
  signal?.throwIfAborted();

  if (!isTauri()) {
    const env = (import.meta as { env?: Record<string, string | undefined> }).env;
    const configured = env?.VITE_RUNTIME_PORT;
    const port = configured ? Number.parseInt(configured, 10) : DEFAULT_DEV_RUNTIME_PORT;
    const token = env?.VITE_RUNTIME_TOKEN ?? "";
    return { port, token, baseUrl: `http://127.0.0.1:${port}` };
  }

  const deadline = Date.now() + PORT_WAIT_MS;
  let lastError = "the supervisor reported no endpoint";

  while (Date.now() < deadline) {
    signal?.throwIfAborted();
    const endpoint = await agentRuntimeEndpoint();
    if (endpoint?.status === "crashed") {
      lastError = "the runtime crashed during startup";
    }
    if (isUsable(endpoint)) {
      await waitForRuntimeHealth(endpoint.port, endpoint.token, signal);
      return {
        port: endpoint.port,
        token: endpoint.token,
        baseUrl: `http://127.0.0.1:${endpoint.port}`,
      };
    }
    await delay(PORT_POLL_MS);
  }

  throw new RuntimeUnavailableError(await supervisorFailureReason(lastError));
}

/** Authorization headers for a resolved runtime, or none in a browser preview. */
export function runtimeAuthHeaders(runtime: ResolvedRuntime): Record<string, string> {
  return runtime.token.length > 0 ? { authorization: `Bearer ${runtime.token}` } : {};
}

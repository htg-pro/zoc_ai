/**
 * Workspace_Services endpoint resolver — zoc-agent-chat-rebuild R2.1, R3.3, R6.1.
 *
 * The other half of the `lib/agent-port.ts` split. This one owns the retained
 * Python sidecar: filesystem reads, the context index, hunk application,
 * checkpoints, tests, and session persistence.
 *
 * It carries **no token**, which is the one structural difference from
 * `runtime-endpoint.ts` and worth stating rather than leaving as an omission a
 * reader might take for an oversight: the Python surface predates the runtime's
 * admission scheme and is reached only from Desktop_Core and the Agent_Runtime,
 * both of which are already inside the trust boundary. Adding a credential here
 * would be a change to that boundary, not a tightening of it, and it is out of
 * scope for this rebuild.
 */

import { agentPort, agentStatus, isTauri } from "./tauri-bridge";

/** Carried over unchanged from `agent-port.ts`. */
export const PORT_WAIT_MS = 30_000;
export const HEALTH_WAIT_MS = 30_000;
export const PORT_POLL_MS = 250;
export const DEFAULT_DEV_PORT = 3001;

export class WorkspaceServicesUnavailableError extends Error {
  readonly code = "workspace_unavailable";

  constructor(reason: string) {
    super(`Workspace services did not become ready: ${reason}`);
    this.name = "WorkspaceServicesUnavailableError";
  }
}

export interface ResolvedWorkspaceServices {
  readonly port: number;
  readonly baseUrl: string;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => globalThis.setTimeout(resolve, ms));
}

export async function waitForWorkspaceHealth(port: number, signal?: AbortSignal): Promise<void> {
  const deadline = Date.now() + HEALTH_WAIT_MS;
  let lastError = "timed out";
  const url = `http://127.0.0.1:${port}/health`;

  while (Date.now() < deadline) {
    signal?.throwIfAborted();
    try {
      // No credential, by design — see the module header. The header's absence
      // here is the whole difference from `runtime-endpoint.ts`.
      const response = await fetch(url, { signal });
      if (response.ok) return;
      lastError = `http ${response.status}`;
    } catch (cause) {
      signal?.throwIfAborted();
      lastError = cause instanceof Error ? cause.message : String(cause);
    }
    await delay(PORT_POLL_MS);
  }

  throw new WorkspaceServicesUnavailableError(`port ${port} did not pass /health (${lastError})`);
}

export async function resolveWorkspaceServicesEndpoint(
  signal?: AbortSignal,
): Promise<ResolvedWorkspaceServices> {
  signal?.throwIfAborted();

  if (!isTauri()) {
    const port = (await agentPort()) ?? readDevPort();
    return { port, baseUrl: `http://127.0.0.1:${port}` };
  }

  const deadline = Date.now() + PORT_WAIT_MS;
  let lastError = "the supervisor reported no port";

  while (Date.now() < deadline) {
    signal?.throwIfAborted();
    const status = await agentStatus();
    if (status?.last_error) lastError = status.last_error;
    if (status?.running && typeof status.port === "number" && status.port > 0) {
      await waitForWorkspaceHealth(status.port, signal);
      return { port: status.port, baseUrl: `http://127.0.0.1:${status.port}` };
    }
    await delay(PORT_POLL_MS);
  }

  throw new WorkspaceServicesUnavailableError(lastError);
}

function readDevPort(): number {
  const env = (import.meta as { env?: Record<string, string | undefined> }).env;
  const configured = env?.VITE_AGENT_PORT;
  return configured ? Number.parseInt(configured, 10) : DEFAULT_DEV_PORT;
}

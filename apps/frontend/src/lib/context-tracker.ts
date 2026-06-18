/**
 * Context status polling and management utilities.
 * Periodically fetches context status during active sessions to keep
 * the UI updated on token usage and model recommendations.
 */

import type { AgentClient } from "./agent-client";
import type { ContextStatus } from "@zoc-studio/shared-types";

const POLL_INTERVAL_MS = 10_000; // Poll every 10 seconds

/**
 * Start polling context status for a session.
 * Returns a cleanup function to stop polling.
 */
export function startContextPolling(
  client: AgentClient,
  sessionId: string,
  onUpdate: (status: ContextStatus) => void,
  onError?: (error: Error) => void,
): () => void {
  let active = true;
  let timeoutId: ReturnType<typeof setTimeout> | null = null;

  const poll = async () => {
    if (!active) return;

    try {
      const status = await client.contextStatus(sessionId);
      if (active) {
        onUpdate(status);
      }
    } catch (error) {
      if (onError && active) {
        onError(error instanceof Error ? error : new Error(String(error)));
      }
    } finally {
      if (active) {
        timeoutId = setTimeout(poll, POLL_INTERVAL_MS);
      }
    }
  };

  // Start polling immediately
  poll();

  // Return cleanup function
  return () => {
    active = false;
    if (timeoutId !== null) {
      clearTimeout(timeoutId);
    }
  };
}

// Feature: zoc-ai-agent-chat-overhaul, Task 14: SSE reconnects are bounded and exhaustion yields `interrupted`
import { describe, expect, it } from "vitest";
import { renderHook, waitFor } from "@testing-library/react";
import useAgentStream, {
  DEFAULT_MAX_RECONNECT_ATTEMPTS,
  type AgentEventStream,
} from "../useAgentStream";

function makeFailingStreamFactory(onCreate: () => void) {
  return (): AgentEventStream => {
    onCreate();
    const stream: AgentEventStream = {
      onopen: null,
      onmessage: null,
      onerror: null,
      addEventListener() {},
      removeEventListener() {},
      close() {},
    };
    // After the hook wires its handlers, fail the transport (never opens), so
    // the reconnect budget actually accrues (a successful open would reset it).
    queueMicrotask(() => stream.onerror?.({}));
    return stream;
  };
}

describe("useAgentStream bounded reconnects (R8.4)", () => {
  it("stops retrying after the budget and reports `interrupted`", async () => {
    let created = 0;
    const { result } = renderHook(() =>
      useAgentStream({
        runId: "run-1",
        createStream: makeFailingStreamFactory(() => {
          created += 1;
        }),
        resolveBaseUrl: async () => "",
        recoverFromDiary: async () => [],
        reconnectDelayMs: 1,
        maxReconnectAttempts: 2,
      }),
    );

    await waitFor(() => expect(result.current.status).toBe("interrupted"), { timeout: 3000 });
    // Initial subscribe + 2 bounded reconnects = 3 connection attempts; the
    // third failure exhausts the budget and stops the retry loop.
    expect(created).toBe(3);
  });

  it("defaults the reconnect budget to a finite value", () => {
    expect(Number.isFinite(DEFAULT_MAX_RECONNECT_ATTEMPTS)).toBe(true);
    expect(DEFAULT_MAX_RECONNECT_ATTEMPTS).toBeGreaterThan(0);
  });
});

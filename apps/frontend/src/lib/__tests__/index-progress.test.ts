import { beforeEach, describe, expect, it, vi } from "vitest";

const resolveAgentPort = vi.hoisted(() => vi.fn());

vi.mock("@/lib/agent-port", () => ({ resolveAgentPort }));

import {
  parseIndexProgress,
  subscribeWorkspaceIndexProgress,
  type IndexProgressSocket,
} from "@/lib/index-progress";

class FakeSocket implements IndexProgressSocket {
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  close = vi.fn();
}

beforeEach(() => {
  resolveAgentPort.mockReset();
  resolveAgentPort.mockResolvedValue(9999);
});

describe("workspace index progress websocket", () => {
  it("connects to the canonical route, validates frames, and closes cleanly", async () => {
    const socket = new FakeSocket();
    const factory = vi.fn(() => socket);
    const onProgress = vi.fn();
    const unsubscribe = await subscribeWorkspaceIndexProgress(onProgress, factory);

    expect(factory).toHaveBeenCalledWith(
      "ws://127.0.0.1:9999/v1/workspace/index-progress",
    );
    socket.onmessage?.({
      data: JSON.stringify({
        type: "index.progress",
        sessionId: "s1",
        processedFiles: 4,
        totalFiles: 10,
        indexedFiles: 4,
        tokenCount: 200,
      }),
    });
    socket.onmessage?.({ data: "not json" });

    expect(onProgress).toHaveBeenCalledTimes(1);
    expect(onProgress).toHaveBeenCalledWith(
      expect.objectContaining({ processedFiles: 4, totalFiles: 10 }),
    );

    unsubscribe();
    expect(socket.close).toHaveBeenCalledTimes(1);
  });

  it("rejects incomplete or unknown frames", () => {
    expect(parseIndexProgress('{"type":"other"}')).toBeNull();
    expect(
      parseIndexProgress(
        JSON.stringify({
          type: "index.progress",
          sessionId: "s1",
          processedFiles: -1,
          totalFiles: 10,
          indexedFiles: 0,
          tokenCount: 0,
        }),
      ),
    ).toBeNull();
  });
});

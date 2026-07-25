import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  resolveAgentPort: vi.fn(async () => 43123),
  getTrustConfig: vi.fn(() => ({ mode: "ask" })),
}));

vi.mock("@/lib/agent-port", () => ({
  resolveAgentPort: mocks.resolveAgentPort,
}));
vi.mock("@/lib/trust", () => ({
  getTrustConfig: mocks.getTrustConfig,
}));

import { postAgentCancel, postAgentRun } from "../gateway-client";

function jsonResponse(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

describe("gateway control transport", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    mocks.resolveAgentPort.mockResolvedValue(43123);
    mocks.getTrustConfig.mockReturnValue({ mode: "ask" } as never);
  });

  it("serializes live editor context into POST /v1/agent/run", async () => {
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(jsonResponse({ runId: "run-context" }));

    await postAgentRun({
      input: "Explain this selection",
      mode: "ask",
      workspaceRoot: "/workspace",
      context: {
        activeFile: "/workspace/src/app.ts",
        selection: "const answer = 42;",
        cursorLine: 17,
        language: "typescript",
      },
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("http://127.0.0.1:43123/v1/agent/run");
    expect(init?.method).toBe("POST");
    expect(JSON.parse(String(init?.body))).toMatchObject({
      prompt: "Explain this selection",
      mode: "ask",
      context: {
        activeFile: "/workspace/src/app.ts",
        selection: "const answer = 42;",
        cursorLine: 17,
        language: "typescript",
      },
    });
  });

  it("cancels only the requested run id", async () => {
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(jsonResponse(undefined, 204));

    await postAgentCancel("run:a/b");

    expect(fetchMock).toHaveBeenCalledWith(
      "http://127.0.0.1:43123/v1/agent/runs/run%3Aa%2Fb/cancel",
      expect.objectContaining({ method: "POST" }),
    );
  });
});

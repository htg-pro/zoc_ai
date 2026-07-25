import { beforeEach, expect, test, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";

const mocks = vi.hoisted(() => ({
  useAgentStream: vi.fn(),
}));

vi.mock("../useAgentStream", () => ({
  default: mocks.useAgentStream,
}));

import { AgentStreamProvider } from "../AgentStreamContext";
import { useAgentStreamContext } from "../agent-stream-context";
import { useApp } from "@/lib/store";
import { clearAuditLog, getAuditLog } from "@/lib/trust";
import {
  registerAgentEditTarget,
  resetAgentEditBridgeForTests,
  stageAgentEditBatch,
} from "@/features/editor/agent-edit-bridge";

function Consumer({ label }: { label: string }) {
  const stream = useAgentStreamContext();
  return <span>{label}:{stream?.status ?? "missing"}:{stream?.events.length ?? 0}</span>;
}

beforeEach(() => {
  clearAuditLog();
  resetAgentEditBridgeForTests();
  mocks.useAgentStream.mockReset();
  mocks.useAgentStream.mockReturnValue({ events: [], status: "open" });
  window.history.replaceState({}, "", "/");
  useApp.setState({
    runId: "shared-run",
    focusedRunId: "shared-run",
    trackedRuns: [{
      runId: "shared-run",
      mode: "agent",
      phase: "running",
      title: "Shared run",
      startedAt: 1,
    }],
    agentMode: "agent",
    activeRunMode: "agent",
  });
});

test("one provider subscription serves multiple consumers", async () => {
  render(
    <AgentStreamProvider>
      <Consumer label="feed" />
      <Consumer label="terminal" />
    </AgentStreamProvider>,
  );

  await waitFor(() => expect(screen.getByText("feed:open:0")).toBeTruthy());
  expect(screen.getByText("terminal:open:0")).toBeTruthy();
  expect(mocks.useAgentStream).toHaveBeenCalledWith({
    runId: "shared-run",
    enabled: true,
  });
});

test("finalizes a run even when the Agent feed is not mounted", async () => {
  useApp.setState({
    runId: "hidden-panel-run",
    trackedRuns: [{
      runId: "hidden-panel-run",
      mode: "agent",
      phase: "running",
      title: "Hidden panel run",
      startedAt: 1,
    }],
  });
  mocks.useAgentStream.mockReturnValue({
    events: [
      {
        type: "done",
        seq: 1,
        runId: "hidden-panel-run",
        ts: "2026-01-01T00:00:00.000Z",
        summary: "Completed",
      },
    ],
    status: "closed",
  });

  render(
    <AgentStreamProvider>
      <Consumer label="terminal" />
    </AgentStreamProvider>,
  );

  await waitFor(() => expect(useApp.getState().runId).toBeNull());
  expect(useApp.getState().trackedRuns[0]?.phase).toBe("done");
});

test("records run-scoped permission events once in the security audit", () => {
  mocks.useAgentStream.mockReturnValue({
    events: [
      {
        type: "permission",
        seq: 7,
        runId: "shared-run",
        ts: "2026-01-01T00:00:00.000Z",
        kind: "fs",
        name: "write_file",
        target: "src/app.ts",
        effect: "prompt",
        reason: "Ask-every-time mode.",
      },
    ],
    status: "open",
  });

  const view = render(
    <AgentStreamProvider>
      <Consumer label="feed" />
    </AgentStreamProvider>,
  );
  view.rerender(
    <AgentStreamProvider>
      <Consumer label="feed" />
    </AgentStreamProvider>,
  );

  expect(getAuditLog()).toEqual([
    expect.objectContaining({
      runId: "shared-run",
      kind: "fs",
      name: "write_file",
      target: "src/app.ts",
      effect: "prompt",
      reason: "Ask-every-time mode.",
    }),
  ]);
});


test("dispatches staged approved edits when post-commit summary arrives", async () => {
  const apply = vi.fn(async () => undefined);
  const unregister = registerAgentEditTarget("/workspace/src/app.ts", apply);
  stageAgentEditBatch("shared-run", [
    {
      path: "src/app.ts",
      diff: "@@ -1 +1 @@\n-old\n+new\n",
      adds: 1,
      dels: 1,
    },
  ]);
  mocks.useAgentStream.mockReturnValue({
    events: [
      {
        type: "summary",
        seq: 9,
        runId: "shared-run",
        ts: "2026-01-01T00:00:00.000Z",
        text: "Applied 1 reviewed file to your workspace.",
      },
    ],
    status: "open",
  });

  render(
    <AgentStreamProvider>
      <Consumer label="feed" />
    </AgentStreamProvider>,
  );

  await waitFor(() => expect(apply).toHaveBeenCalledTimes(1));
  expect(apply).toHaveBeenCalledWith(
    expect.objectContaining({
      runId: "shared-run",
      path: "src/app.ts",
      edits: [{ search: "old\n", replace: "new\n" }],
    }),
  );
  unregister();
});


test("opens one stream per concurrent run and aggregates their events", async () => {
  useApp.setState({
    runId: "run-b",
    trackedRuns: [
      { runId: "run-a", mode: "agent", phase: "running", title: "A", startedAt: 1 },
      { runId: "run-b", mode: "ask", phase: "running", title: "B", startedAt: 2 },
    ],
  });
  mocks.useAgentStream.mockImplementation(({ runId }: { runId?: string | null }) => ({
    events: runId
      ? [{ type: "token", seq: 1, runId, ts: "2026-01-01T00:00:00.000Z", text: runId }]
      : [],
    status: "open",
  }));

  render(
    <AgentStreamProvider>
      <Consumer label="feed" />
    </AgentStreamProvider>,
  );

  await waitFor(() => expect(screen.getByText("feed:open:2")).toBeTruthy());
  const subscribedRunIds = new Set(
    mocks.useAgentStream.mock.calls.map(([options]) => options.runId),
  );
  expect(subscribedRunIds).toEqual(new Set(["run-a", "run-b"]));
});

test("shared viewers use the host origin and token on live and replay routes", async () => {
  window.history.replaceState({}, "", "/?token=secret%20token&runId=shared-run");
  useApp.setState({ runId: null, trackedRuns: [], focusedRunId: null });

  render(
    <AgentStreamProvider>
      <Consumer label="viewer" />
    </AgentStreamProvider>,
  );

  const options = mocks.useAgentStream.mock.calls.find(
    ([candidate]) => candidate.runId === "shared-run",
  )?.[0];
  expect(options).toBeDefined();
  expect(options!).toMatchObject({
    runId: "shared-run",
    enabled: true,
    eventsUrl: "/v1/agent/events?token=secret%20token",
    diaryUrl: "/v1/agent/runs/shared-run/events/replay?token=secret%20token",
  });
  await expect(options!.resolveBaseUrl?.()).resolves.toBe(window.location.origin);
});

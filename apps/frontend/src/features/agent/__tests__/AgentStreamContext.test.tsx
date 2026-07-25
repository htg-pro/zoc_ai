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
  return <span>{label}:{stream?.status ?? "missing"}</span>;
}

beforeEach(() => {
  clearAuditLog();
  resetAgentEditBridgeForTests();
  mocks.useAgentStream.mockReset();
  mocks.useAgentStream.mockReturnValue({ events: [], status: "open" });
  useApp.setState({
    runId: "shared-run",
    agentMode: "agent",
    activeRunMode: "agent",
  });
});

test("one provider subscription serves multiple consumers", () => {
  render(
    <AgentStreamProvider>
      <Consumer label="feed" />
      <Consumer label="terminal" />
    </AgentStreamProvider>,
  );

  expect(screen.getByText("feed:open")).toBeTruthy();
  expect(screen.getByText("terminal:open")).toBeTruthy();
  expect(mocks.useAgentStream).toHaveBeenCalledTimes(1);
  expect(mocks.useAgentStream).toHaveBeenCalledWith({
    runId: "shared-run",
    enabled: true,
  });
});

test("finalizes a run even when the Agent feed is not mounted", () => {
  useApp.setState({ runId: "hidden-panel-run" });
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

  expect(screen.getByText("terminal:closed")).toBeTruthy();
  expect(useApp.getState().runId).toBeNull();
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

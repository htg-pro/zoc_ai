/**
 * run-card-readonly.test.tsx — a shared-session viewer reads decision rows but
 * cannot answer them for the host (R15.7). The live path renders decisions
 * through `RunCardView → renderRow`, which provides `readOnly` via the
 * RowActions context; this pins that approval, plan, and diff controls are
 * withheld from a viewer and offered to the run's owner. (Replaces the read-only
 * coverage that lived on the retired `RunTraceCard`.)
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";

vi.mock("../gateway-client", () => ({
  postAgentDecision: vi.fn(async () => undefined),
}));

import { postAgentDecision } from "../gateway-client";
import { RunCardView } from "../RunCardView";
import { normalizeEvents, type NormalizeContext } from "../normalize";
import type { RunCard } from "../run-cards";

const TS = "2024-01-01T00:00:00.000Z";
const ctx: NormalizeContext = { activeRunId: "run-1", boundMessageId: null, highestSeq: -1 };

function card(events: readonly unknown[]): RunCard {
  return { runId: "run-1", rows: normalizeEvents(events, ctx).rows };
}

const APPROVAL = [
  { type: "approval", seq: 1, runId: "run-1", ts: TS, prompt: "Run `rm -rf build`?", operation: "rm -rf build" },
];
const PLAN = [
  {
    type: "plan-ready",
    seq: 1,
    runId: "run-1",
    ts: TS,
    steps: [{ file: "src/App.tsx", action: "modify", rationale: "wire it", diff: "@@ -1 +1 @@\n-a\n+b" }],
    verificationCommand: "pnpm test",
  },
];
const DIFF = [
  { type: "edit-file", seq: 1, runId: "run-1", ts: TS, path: "src/a.ts", adds: 1, dels: 1, diff: "@@ -1 +1 @@\n-a\n+b", status: "pending" },
];

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("RunCardView read-only decision gating (R15.7)", () => {
  it("withholds approve/reject from a read-only viewer", () => {
    render(<RunCardView card={card(APPROVAL)} focused collapsed={false} readOnly />);
    expect(screen.getByText("Approval required")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Approve" })).toBeNull();
    expect(screen.getByText(/waiting for the host/i)).toBeInTheDocument();
    expect(postAgentDecision).not.toHaveBeenCalled();
  });

  it("lets the run owner approve, posting exactly one decision", () => {
    render(<RunCardView card={card(APPROVAL)} focused collapsed={false} readOnly={false} />);
    fireEvent.click(screen.getByRole("button", { name: "Approve" }));
    expect(postAgentDecision).toHaveBeenCalledWith({ runId: "run-1", decision: "approve" });
  });

  it("withholds the plan Apply/Cancel controls from a read-only viewer", () => {
    render(<RunCardView card={card(PLAN)} focused collapsed={false} readOnly />);
    expect(screen.getByText("Plan ready")).toBeInTheDocument();
    expect(screen.getByText("src/App.tsx")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /apply plan/i })).toBeNull();
    expect(screen.getByText(/waiting for the host/i)).toBeInTheDocument();
  });

  it("withholds diff accept/reject from a read-only viewer", () => {
    render(<RunCardView card={card(DIFF)} focused collapsed={false} readOnly />);
    expect(screen.queryByRole("button", { name: "Accept" })).toBeNull();
    expect(screen.getByText(/waiting for the host to review/i)).toBeInTheDocument();
  });
});

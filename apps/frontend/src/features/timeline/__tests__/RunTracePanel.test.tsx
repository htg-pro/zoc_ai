import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";

vi.mock("@/lib/store", () => ({ useApp: vi.fn(() => undefined) }));

import { RunTracePanel } from "../RunTracePanel";
import type { RunTrace } from "../run-trace";

const T0 = Date.parse("2026-07-25T05:00:00.000Z");
const at = (ms: number) => new Date(T0 + ms).toISOString();

const EVENTS = [
  { seq: 1, type: "intent", runId: "r1", ts: at(0), text: "Add a guard" },
  { seq: 2, type: "thinking", runId: "r1", ts: at(50), text: "Reading files" },
  { seq: 3, type: "edit-file", runId: "r1", ts: at(4000), path: "src/app.ts" },
  { seq: 4, type: "done", runId: "r1", ts: at(4100), ok: true },
];

describe("RunTracePanel", () => {
  it("renders the stage band, event list and totals", () => {
    render(<RunTracePanel runId="r1" events={EVENTS} />);

    expect(screen.getByTestId("run-trace-panel")).toBeInTheDocument();
    expect(screen.getByTestId("stage-band")).toBeInTheDocument();
    expect(screen.getByText("4 events")).toBeInTheDocument();
    // One row per event.
    expect(screen.getByTestId("trace-events").children).toHaveLength(4);
    expect(screen.getByText("src/app.ts")).toBeInTheDocument();
  });

  it("shows an empty state when there is no trace", () => {
    render(<RunTracePanel runId="r1" events={[]} />);
    expect(screen.getByTestId("run-trace-empty")).toBeInTheDocument();
  });

  it("expands an event to its full JSON payload", () => {
    render(<RunTracePanel runId="r1" events={EVENTS} />);
    const row = screen.getByText("Add a guard");

    fireEvent.click(row);

    expect(screen.getByText(/"type": "intent"/)).toBeInTheDocument();
  });

  it("highlights the critical path only when toggled", () => {
    const { container } = render(<RunTracePanel runId="r1" events={EVENTS} />);
    expect(container.querySelectorAll("[data-critical]")).toHaveLength(0);

    fireEvent.click(screen.getByRole("button", { name: /critical path/i }));

    // The 3.95s gap after `thinking` dominates the run, so exactly that event
    // should be highlighted.
    const highlighted = container.querySelectorAll("[data-critical]");
    expect(highlighted).toHaveLength(1);
    expect(highlighted[0].textContent).toContain("thinking");
  });

  it("exports the whole trace as JSON", () => {
    const onExport = vi.fn((_trace: RunTrace) => undefined);
    render(<RunTracePanel runId="r1" events={EVENTS} onExport={onExport} />);

    fireEvent.click(screen.getByRole("button", { name: /export json/i }));

    expect(onExport).toHaveBeenCalledTimes(1);
    const trace = onExport.mock.calls[0][0];
    expect(trace.runId).toBe("r1");
    expect(trace.events).toHaveLength(4);
    expect(trace.durationMs).toBe(4100);
  });
});

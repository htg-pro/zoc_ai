// Feature: zoc-ai-agent-chat-overhaul, Task 14: terminal occupancy names the holding run and clears on terminal phases
import { describe, expect, it } from "vitest";
import { terminalHeader } from "../terminal-header";
import { startRun, type RunPhase } from "../run-lifecycle";

function holder(phase: RunPhase) {
  return { ...startRun({ runId: "run-7", mode: "agent", startedAt: 0 }), phase };
}

describe("terminalHeader occupancy (R13.3/R13.4)", () => {
  it("names the actual holding run's mode while it is live", () => {
    const header = terminalHeader({ resolvedRoot: "/ws", holder: holder("running"), exitCode: null });
    expect(header.occupancy).not.toBeNull();
    expect(header.occupancy?.runId).toBe("run-7");
    // Named, not a generic "Agent".
    expect(header.occupancy?.label).toContain("agent");
    expect(header.occupancy?.label).not.toBe("Agent is using this terminal");
  });

  it("clears occupancy on EVERY terminal phase (cancel/fail/interrupt/done)", () => {
    for (const phase of ["cancelled", "failed", "interrupted", "done"] as const) {
      const header = terminalHeader({ resolvedRoot: "/ws", holder: holder(phase), exitCode: null });
      expect(header.occupancy).toBeNull();
    }
  });

  it("has no occupancy when no run holds the terminal", () => {
    const header = terminalHeader({ resolvedRoot: "/ws", holder: null, exitCode: null });
    expect(header.occupancy).toBeNull();
    expect(header.cwd).toBe("/ws");
  });
});

// Feature: zoc-ai-agent-chat-overhaul, Property 40: Keyboard actions obey the same gate as the controls
import { describe, expect, it } from "vitest";
import fc from "fast-check";
import { announcementCount, cancelAction, submitAction } from "../keyboard-actions";
import type { RunGate } from "../model-availability";

describe("keyboard actions (Property 40)", () => {
  it("submit starts a run iff the gate is open", () => {
    fc.assert(
      fc.property(fc.boolean(), (canStart) => {
        const gate: RunGate = canStart
          ? { canStart: true }
          : { canStart: false, code: "no_model_ready", message: "not ready" };
        expect(submitAction(gate)).toBe(canStart ? "start" : "blocked");
      }),
      { numRuns: 100 },
    );
  });

  it("cancel issues exactly one request iff a run is active", () => {
    fc.assert(
      fc.property(fc.nat({ max: 4 }), (activeRunCount) => {
        expect(cancelAction(activeRunCount)).toBe(activeRunCount > 0 ? "cancel" : "noop");
      }),
      { numRuns: 100 },
    );
  });

  it("bounds live-region announcements independent of token count", () => {
    fc.assert(
      fc.property(fc.nat({ max: 500 }), (tokenCount) => {
        // A stream of only token frames — no phase/stage change — announces nothing.
        const events = Array.from({ length: tokenCount }, (_, i) => ({
          type: "token" as const,
          seq: i,
          runId: "run-1",
          ts: "t",
          text: "x",
        }));
        expect(announcementCount(events)).toBe(0);
      }),
      { numRuns: 100 },
    );
    // One stage change + one terminal frame → bounded small constant.
    const mixed = [
      { type: "stage", seq: 1, runId: "run-1", stage: "analyze", state: "active" },
      { type: "token", seq: 2, runId: "run-1", ts: "t", text: "a" },
      { type: "token", seq: 3, runId: "run-1", ts: "t", text: "b" },
      { type: "done", seq: 4, runId: "run-1", ok: true },
    ] as never[];
    expect(announcementCount(mixed)).toBe(2);
  });
});

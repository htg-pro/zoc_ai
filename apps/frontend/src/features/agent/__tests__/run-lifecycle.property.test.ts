// Feature: zoc-ai-agent-chat-overhaul, Property 19: Every run settles and stays settled
import { describe, expect, it } from "vitest";
import fc from "fast-check";
import {
  type LifecycleInput,
  STALL_THRESHOLD_MS,
  elapsedMs,
  isTerminalPhase,
  reduceRun,
  startRun,
} from "../run-lifecycle";
import type { AgentMode } from "../gateway-client";

function makeInput(kind: string, atMs: number, extra: { runId: string }): LifecycleInput {
  switch (kind) {
    case "done-ok":
      return { kind: "event", atMs, event: { type: "done", seq: atMs, runId: extra.runId, ok: true, files_changed: 2 } as never };
    case "done-fail":
      return { kind: "event", atMs, event: { type: "done", seq: atMs, runId: extra.runId, ok: false, reason: "boom" } as never };
    case "error":
      return { kind: "event", atMs, event: { type: "error", seq: atMs, runId: extra.runId, message: "err" } as never };
    case "stage":
      return { kind: "event", atMs, event: { type: "stage", seq: atMs, runId: extra.runId, stage: "plan", state: "active" } as never };
    case "token":
      return { kind: "event", atMs, event: { type: "token", seq: atMs, runId: extra.runId, ts: "t", text: "x" } as never };
    case "tick":
      return { kind: "tick", atMs };
    case "disconnected":
      return { kind: "disconnected", atMs };
    case "reconnect-failed":
      return { kind: "reconnect-failed", atMs };
    case "cancel-requested":
      return { kind: "cancel-requested", atMs };
    case "cancel-acknowledged":
      return { kind: "cancel-acknowledged", atMs };
    default:
      return { kind: "tick", atMs };
  }
}

describe("reduceRun (Property 19)", () => {
  it("preserves identity, settles, and never leaves a terminal phase", () => {
    fc.assert(
      fc.property(
        fc.record({ runId: fc.string({ minLength: 1 }), mode: fc.constantFrom<AgentMode>("ask", "plan", "agent") }),
        fc.array(
          fc.constantFrom(
            "done-ok",
            "done-fail",
            "error",
            "stage",
            "token",
            "tick",
            "disconnected",
            "reconnect-failed",
            "cancel-requested",
            "cancel-acknowledged",
          ),
          { maxLength: 30 },
        ),
        (init, kinds) => {
          const startedAt = 1_000;
          let record = startRun({ runId: init.runId, mode: init.mode, startedAt });
          let firstTerminalPhase: string | null = null;
          let frozenEnded: number | null = null;
          let t = startedAt;

          for (const kind of kinds) {
            t += 1; // monotonic clock
            const before = record;
            record = reduceRun(record, makeInput(kind, t, { runId: init.runId }));

            // Identity is invariant.
            expect(record.runId).toBe(init.runId);
            expect(record.mode).toBe(init.mode);
            expect(record.startedAt).toBe(startedAt);

            if (isTerminalPhase(before.phase)) {
              // Absorbing: a terminal record is returned unchanged.
              expect(record).toBe(before);
            }
            if (firstTerminalPhase === null && isTerminalPhase(record.phase)) {
              firstTerminalPhase = record.phase;
              frozenEnded = record.endedAt;
            }
          }

          // Once terminal, always terminal, with a frozen elapsed duration.
          if (firstTerminalPhase !== null) {
            expect(isTerminalPhase(record.phase)).toBe(true);
            expect(record.phase).toBe(firstTerminalPhase);
            expect(record.endedAt).toBe(frozenEnded);
            const laterElapsed = elapsedMs(record, t + 100_000);
            expect(laterElapsed).toBe((frozenEnded ?? 0) - startedAt);
          }
        },
      ),
      { numRuns: 200 },
    );
  });

  it("a terminal frame freezes elapsed; stall retains the last stage; reconnect-exhaustion interrupts", () => {
    const startedAt = 0;
    // Terminal done freezes elapsed at endedAt.
    let r = startRun({ runId: "r", mode: "agent", startedAt });
    r = reduceRun(r, { kind: "event", atMs: 500, event: { type: "stage", seq: 1, runId: "r", stage: "edit", state: "active" } as never });
    r = reduceRun(r, { kind: "event", atMs: 800, event: { type: "done", seq: 2, runId: "r", ok: true, files_changed: 3 } as never });
    expect(r.phase).toBe("done");
    expect(r.filesChanged).toBe(3);
    expect(elapsedMs(r, 999_999)).toBe(800);

    // Stall retains the last known stage.
    let s = startRun({ runId: "s", mode: "agent", startedAt });
    s = reduceRun(s, { kind: "event", atMs: 10, event: { type: "stage", seq: 1, runId: "s", stage: "check", state: "active" } as never });
    s = reduceRun(s, { kind: "tick", atMs: 10 + STALL_THRESHOLD_MS });
    expect(s.phase).toBe("stalled");
    expect(s.stage).toBe("check");

    // Reconnect exhaustion interrupts (not running).
    let d = startRun({ runId: "d", mode: "ask", startedAt });
    d = reduceRun(d, { kind: "disconnected", atMs: 5 });
    expect(d.phase).toBe("reconnecting");
    d = reduceRun(d, { kind: "reconnect-failed", atMs: 6 });
    expect(d.phase).toBe("interrupted");

    // Cancel acknowledgement settles as cancelled.
    let c = startRun({ runId: "c", mode: "agent", startedAt });
    c = reduceRun(c, { kind: "cancel-requested", atMs: 3 });
    expect(c.phase).toBe("stopping");
    c = reduceRun(c, { kind: "cancel-acknowledged", atMs: 4 });
    expect(c.phase).toBe("cancelled");
  });
});

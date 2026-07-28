// Feature: zoc-ai-agent-chat-overhaul, Property 28: The terminal surface reports the workspace, occupancy, and exit status
import { describe, expect, it } from "vitest";
import fc from "fast-check";
import { terminalHeader } from "../terminal-header";
import { type RunPhase, type RunRecord, isTerminalPhase, startRun } from "../run-lifecycle";

const PHASES: RunPhase[] = [
  "starting",
  "running",
  "paused",
  "stalled",
  "reconnecting",
  "interrupted",
  "stopping",
  "cancelled",
  "done",
  "failed",
];

describe("terminalHeader (Property 28)", () => {
  it("reports cwd, occupancy iff a non-terminal run holds it, and exit iff non-zero", () => {
    fc.assert(
      fc.property(
        fc.option(fc.constant("/ws/project"), { nil: null }),
        fc.option(fc.constantFrom(...PHASES), { nil: null }),
        fc.option(fc.integer({ min: -5, max: 5 }), { nil: null }),
        (resolvedRoot, holderPhase, exitCode) => {
          const holder: RunRecord | null =
            holderPhase === null
              ? null
              : { ...startRun({ runId: "r1", mode: "agent", startedAt: 0 }), phase: holderPhase };
          const header = terminalHeader({ resolvedRoot, holder, exitCode });

          expect(header.cwd).toBe(resolvedRoot);

          if (holder && !isTerminalPhase(holder.phase)) {
            expect(header.occupancy).not.toBeNull();
            expect(header.occupancy?.runId).toBe("r1");
          } else {
            expect(header.occupancy).toBeNull();
          }

          if (exitCode !== null && exitCode !== 0) {
            expect(header.exit).toEqual({ code: exitCode });
          } else {
            expect(header.exit).toBeNull();
          }
        },
      ),
      { numRuns: 200 },
    );
  });
});

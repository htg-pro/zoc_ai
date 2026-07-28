// Feature: zoc-ai-agent-chat-overhaul, Task 14: tracked runs represent stalled/reconnecting/interrupted
import { describe, expect, it } from "vitest";
import {
  canRetryRun,
  canStopRun,
  isTerminal,
  isTroubled,
  runStatusLabel,
} from "../agent-runs";

describe("tracked-run phases: stalled / reconnecting / interrupted", () => {
  it("interrupted is terminal; stalled/reconnecting are live", () => {
    expect(isTerminal({ phase: "interrupted" })).toBe(true);
    expect(isTerminal({ phase: "stalled" })).toBe(false);
    expect(isTerminal({ phase: "reconnecting" })).toBe(false);
    expect(isTroubled({ phase: "stalled" })).toBe(true);
    expect(isTroubled({ phase: "reconnecting" })).toBe(true);
    expect(isTroubled({ phase: "running" })).toBe(false);
  });

  it("a stalled/reconnecting run can still be cancelled; troubled/terminal can be retried", () => {
    expect(canStopRun({ phase: "stalled" })).toBe(true);
    expect(canStopRun({ phase: "reconnecting" })).toBe(true);
    expect(canStopRun({ phase: "interrupted" })).toBe(false);
    expect(canRetryRun({ phase: "stalled" })).toBe(true);
    expect(canRetryRun({ phase: "interrupted" })).toBe(true);
    expect(canRetryRun({ phase: "failed" })).toBe(true);
    expect(canRetryRun({ phase: "running" })).toBe(false);
  });

  it("labels the new phases", () => {
    expect(runStatusLabel({ phase: "stalled" })).toBe("Stalled");
    expect(runStatusLabel({ phase: "reconnecting" })).toBe("Reconnecting…");
    expect(runStatusLabel({ phase: "interrupted" })).toBe("Interrupted");
  });
});

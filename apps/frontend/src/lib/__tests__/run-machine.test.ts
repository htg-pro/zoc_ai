// Unit tests for the run lifecycle reducer (run-machine.ts).
import { describe, expect, it } from "vitest";
import { INITIAL_RUN_STATE, runReducer } from "../run-machine";

describe("runReducer start guard (R1.8)", () => {
  it("a start with no available user message leaves the binding unset and produces no active run", () => {
    const next = runReducer(INITIAL_RUN_STATE, {
      type: "start",
      runId: "run-1",
      boundMessageId: "",
      at: 123,
    });

    // R1.8: without a bound user message the reducer stays put — no active run.
    expect(next.lifecycle).toBe("idle");
    expect(next.runId).toBeNull();
    expect(next.boundMessageId).toBeNull();
    // The reducer must not invent a binding; state is returned unchanged.
    expect(next).toEqual(INITIAL_RUN_STATE);
  });
});

/** Property 36 / R27.7: telemetry excludes prompt, file content, and credentials. */
import { describe, expect, it } from "vitest";
import fc from "fast-check";
import { isTelemetrySafePayload } from "../telemetry";

describe("Property 36: telemetry carries no prompt, file content, or credential", () => {
  it("rejects every forbidden field at every nesting depth", () => {
    fc.assert(
      fc.property(
        fc.constantFrom("prompt", "file", "content", "credential", "api_key", "secret"),
        fc.string(),
        (key, value) => {
          expect(isTelemetrySafePayload({ outer: { [key]: value } })).toBe(false);
        },
      ),
      { numRuns: 100 },
    );
  });

  it("accepts the closed run-completed numeric record", () => {
    expect(
      isTelemetrySafePayload({
        mode: "agent",
        stage_reached: "completed",
        token_count: 20,
        input_tokens: 10,
        output_tokens: 10,
        estimated_cost_cents: 1.2,
        context_window_proportion: 0.3,
        duration_ms: 100,
        succeeded: true,
        recovery_count: 0,
      }),
    ).toBe(true);
  });
});

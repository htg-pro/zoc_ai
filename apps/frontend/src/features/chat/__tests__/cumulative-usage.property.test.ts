/** Property 66: cumulative usage equals the sum of its Runs (R27.1–R27.3). */
/** Feature: zoc-agent-chat-rebuild, Property 66 (R27.1, R27.2, R27.3). */
import { describe, expect, it } from "vitest";
import fc from "fast-check";
import type { UsagePart } from "@zoc-studio/shared-types";
import { cumulativeUsageOf } from "../session-usage";
import type { ZocUIMessage } from "../wire/ui-message";

const usageArb = fc.record({
  input: fc.nat({ max: 1_000_000 }),
  output: fc.nat({ max: 1_000_000 }),
  cost: fc.double({ min: 0, max: 10_000, noNaN: true }),
  limit: fc.integer({ min: 1, max: 2_000_000 }),
});

function messageOf(
  rows: readonly { input: number; output: number; cost: number; limit: number }[],
): ZocUIMessage[] {
  return rows.map((row, index) => {
    const usage: UsagePart = {
      type: "usage",
      seq: index + 1,
      runId: `run-${String(index)}`,
      messageId: `message-${String(index)}`,
      ts: new Date(index).toISOString(),
      agentName: null,
      inputTokens: row.input,
      outputTokens: row.output,
      reasoningTokens: 0,
      cachedInputTokens: 0,
      contextLimit: row.limit,
      estimatedCostCents: row.cost,
      tokensPerSecond: null,
      messagesInContext: 1,
      sessionMessageCount: 1,
      messagesOutOfWindow: 0,
      summaryActive: false,
    };
    return {
      id: usage.messageId,
      role: "assistant",
      parts: [{ type: "data-zoc-usage", data: usage }],
    };
  });
}

describe("Property 66: cumulative usage equals the sum of its Runs", () => {
  it("sums every Run and clamps the newest context ratio", () => {
    fc.assert(
      fc.property(fc.array(usageArb, { maxLength: 30 }), (rows) => {
        const total = cumulativeUsageOf(messageOf(rows));
        expect(total.inputTokens).toBe(rows.reduce((sum, row) => sum + row.input, 0));
        expect(total.outputTokens).toBe(rows.reduce((sum, row) => sum + row.output, 0));
        expect(total.estimatedCostCents).toBeCloseTo(
          rows.reduce((sum, row) => sum + row.cost, 0),
          8,
        );
        const newest = rows.at(-1);
        const expected =
          newest === undefined ? 0 : Math.min(1, (newest.input + newest.output) / newest.limit);
        expect(total.contextProportion).toBeCloseTo(expected, 12);
      }),
      { numRuns: 200 },
    );
  });
});

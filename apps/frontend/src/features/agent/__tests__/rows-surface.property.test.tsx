// Feature: zoc-ai-agent-chat-overhaul, Property 25: Internal frames appear on no rendered surface
// Feature: zoc-ai-agent-chat-overhaul, Property 34: Exactly one streaming indicator is rendered
// Feature: zoc-ai-agent-chat-overhaul, Property 39: Every control is keyboard reachable, focus-visible, and state-exposing
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, fireEvent, render } from "@testing-library/react";
import fc from "fast-check";
import { type FeedRow, normalizeEvents } from "../normalize";
import { StreamingIndicator, renderRow } from "../rows";
import { SYNTHETIC_STAGE_PREFIX } from "../stage-markers";

afterEach(cleanup);

describe("internal frames (Property 25)", () => {
  it("renders no <stage:> marker text anywhere in the feed", () => {
    fc.assert(
      fc.property(fc.array(fc.string(), { maxLength: 6 }), (stageNames) => {
        const events: unknown[] = [
          { type: "intent", seq: 0, runId: "run-1", ts: "t", text: "prompt", modelTier: "cloud", contextWindowTokens: 1000 },
          ...stageNames.map((name, i) => ({
            type: "command",
            seq: i + 1,
            runId: "run-1",
            ts: "t",
            command: `${SYNTHETIC_STAGE_PREFIX}${name}>`,
          })),
          { type: "token", seq: 100, runId: "run-1", ts: "t", text: "the answer" },
          { type: "done", seq: 101, runId: "run-1", ok: true },
        ];
        const { rows } = normalizeEvents(events, {
          activeRunId: "run-1",
          boundMessageId: null,
          highestSeq: -1,
        });
        const { container } = render(<div>{rows.map((r) => <div key={r.id}>{renderRow(r)}</div>)}</div>);
        expect(container.textContent ?? "").not.toContain(SYNTHETIC_STAGE_PREFIX);
      }),
      { numRuns: 100 },
    );
  });
});

describe("streaming indicator (Property 34)", () => {
  it("renders exactly one indicator iff a row is streaming, zero otherwise", () => {
    fc.assert(
      fc.property(fc.array(fc.boolean(), { maxLength: 8 }), (streamingFlags) => {
        const rows: FeedRow[] = streamingFlags.map((streaming, i) => ({
          id: `m${i}`,
          seq: i,
          runId: "run-1",
          kind: "assistant-message",
          messageId: `m${i}`,
          text: `t${i}`,
          streaming,
        }));
        const { container } = render(<StreamingIndicator rows={rows} />);
        const indicators = container.querySelectorAll('[data-testid="streaming-indicator"]');
        const anyStreaming = streamingFlags.some(Boolean);
        expect(indicators.length).toBe(anyStreaming ? 1 : 0);
      }),
      { numRuns: 150 },
    );
  });
});

describe("keyboard reachability (Property 39)", () => {
  it("keeps every control tabbable and exposes expanded state on expandable rows", () => {
    const rows: FeedRow[] = [
      { id: "r1", seq: 1, runId: "run-1", kind: "reasoning", text: "thinking hard", collapsed: true, truncated: false },
      { id: "t1", seq: 2, runId: "run-1", kind: "tool-call", tool: "shell", target: "ls", status: "succeeded", result: "ok", failure: null, key: "k1" },
      { id: "a1", seq: 3, runId: "run-1", kind: "approval", prompt: "ok?", operation: "run_command", tool: "run_command", target: null, decision: null },
    ];
    const { container } = render(<div>{rows.map((r) => <div key={r.id}>{renderRow(r)}</div>)}</div>);

    // No interactive control is removed from the tab order.
    const buttons = Array.from(container.querySelectorAll("button"));
    expect(buttons.length).toBeGreaterThan(0);
    for (const button of buttons) {
      expect(button.getAttribute("tabindex")).not.toBe("-1");
    }

    // The reasoning toggle exposes and toggles its expanded state.
    const toggle = buttons.find((b) => b.getAttribute("aria-expanded") !== null);
    expect(toggle).toBeTruthy();
    if (toggle) {
      const controls = toggle.getAttribute("aria-controls");
      expect(controls).toBeTruthy();
      const before = toggle.getAttribute("aria-expanded");
      fireEvent.click(toggle);
      const after = toggle.getAttribute("aria-expanded");
      expect(after).not.toBe(before);
      // Controlled region visibility agrees with aria-expanded.
      const region = controls ? container.querySelector(`#${CSS.escape(controls)}`) : null;
      if (after === "true") expect(region).not.toBeNull();
    }
  });
});

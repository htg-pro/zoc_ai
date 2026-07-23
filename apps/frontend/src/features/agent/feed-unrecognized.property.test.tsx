/**
 * Feature: advanced-context-engine, Property 20: Frontend registry totality,
 * injectivity, and unknown-event discard.
 *
 * The discard facet proves that every payload outside the independently pinned
 * rendered EventType domain—including the valid-but-non-rendered
 * `context-compressed` event—leaves previously rendered rows byte-identical.
 *
 * Validates: Requirements 11.6, 14.3, 14.4, 17.4, 17.5
 */
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render } from "@testing-library/react";
import fc from "fast-check";
import type { AgentEvents } from "@zoc-studio/shared-types";

import { AgentRunFeedView } from "./AgentRunFeed";
import { isRecognizedEvent } from "./rows";

afterEach(() => {
  cleanup();
});

const RECOGNIZED_TYPES: readonly AgentEvents.EventType[] = [
  "intent",
  "thinking",
  "plan",
  "plan-update",
  "map-files",
  "read-files",
  "edit-file",
  "command",
  "review",
  "summary",
  "approval",
  "done",
];

const frozenNow = () => 0;

const recognizedVariantArb = fc.oneof(
  fc.record({
    type: fc.constant("intent" as const),
    text: fc.string(),
    modelTier: fc.constantFrom<AgentEvents.ModelTier>("local-slm", "edge", "cloud"),
    contextWindowTokens: fc.nat(),
  }),
  fc.record({
    type: fc.constant("thinking" as const),
    text: fc.string(),
    collapsible: fc.constant(true as const),
    truncated: fc.boolean(),
  }),
  fc.record({
    type: fc.constant("plan" as const),
    items: fc.array(
      fc.record({
        id: fc.string({ minLength: 1, maxLength: 12 }),
        label: fc.string({ maxLength: 40 }),
        status: fc.constantFrom<AgentEvents.PlanItemStatus>("pending", "active", "done"),
      }),
      { maxLength: 4 },
    ),
  }),
  fc.record({
    type: fc.constant("plan-update" as const),
    id: fc.string({ minLength: 1, maxLength: 12 }),
    status: fc.constantFrom<AgentEvents.PlanItemStatus>("pending", "active", "done"),
  }),
  fc.record({
    type: fc.constant("map-files" as const),
    readList: fc.array(fc.string({ minLength: 1, maxLength: 40 }), { maxLength: 8 }),
    writeList: fc.array(fc.string({ minLength: 1, maxLength: 40 }), { maxLength: 8 }),
    rationale: fc.string({ maxLength: 80 }),
  }),
  fc.record({
    type: fc.constant("read-files" as const),
    files: fc.array(fc.record({ path: fc.string({ minLength: 1, maxLength: 40 }) }), { maxLength: 4 }),
  }),
  fc.record({
    type: fc.constant("edit-file" as const),
    path: fc.string({ minLength: 1, maxLength: 40 }),
    diff: fc.string({ maxLength: 100 }),
    adds: fc.nat({ max: 20 }),
    dels: fc.nat({ max: 20 }),
    status: fc.constant("done" as const),
  }),
  fc.record({
    type: fc.constant("command" as const),
    command: fc.string({ minLength: 1, maxLength: 40 }),
  }),
  fc.record({
    type: fc.constant("review" as const),
    files: fc.array(
      fc.record({
        path: fc.string({ minLength: 1, maxLength: 40 }),
        diff: fc.string({ maxLength: 100 }),
        adds: fc.nat({ max: 20 }),
        dels: fc.nat({ max: 20 }),
      }),
      { maxLength: 4 },
    ),
    validation: fc.constant({
      typecheck: { status: "skipped" as const },
      build: { status: "skipped" as const },
      tests: { status: "skipped" as const },
    }),
  }),
  fc.record({ type: fc.constant("summary" as const), text: fc.string() }),
  fc.record({ type: fc.constant("approval" as const), prompt: fc.string() }),
  fc.record({ type: fc.constant("done" as const), ok: fc.boolean() }),
);

const unknownTypeArb = fc.oneof(
  fc.constant("context-compressed"),
  fc.string().filter((value) => !RECOGNIZED_TYPES.includes(value as AgentEvents.EventType)),
);

function eventFeed(variants: readonly object[]): AgentEvents.AgentEvent[] {
  return variants.map((variant, index) => ({
    ...variant,
    seq: index,
    runId: `run-${index}`,
    ts: new Date(0).toISOString(),
  })) as AgentEvents.AgentEvent[];
}

describe("Feature: advanced-context-engine, Property 20: unknown event discard", () => {
  it("preserves mounted rows when an unregistered event arrives", () => {
    fc.assert(
      fc.property(
        fc.array(recognizedVariantArb, { maxLength: 8 }),
        unknownTypeArb,
        fc.nat(),
        (variants, unknownType, insertRaw) => {
          const recognized = eventFeed(variants);
          const unknown = {
            type: unknownType,
            seq: recognized.length + 1000,
            runId: "run-unknown",
            ts: new Date(0).toISOString(),
          };
          expect(isRecognizedEvent(unknown)).toBe(false);

          const insertAt = insertRaw % (recognized.length + 1);
          const withUnknown = [
            ...recognized.slice(0, insertAt),
            unknown,
            ...recognized.slice(insertAt),
          ] as AgentEvents.AgentEvent[];

          const view = render(<AgentRunFeedView events={recognized} now={frozenNow} />);
          const beforeHtml = view.container.innerHTML;
          view.rerender(<AgentRunFeedView events={withUnknown} now={frozenNow} />);
          expect(view.container.innerHTML).toBe(beforeHtml);
          view.unmount();
        },
      ),
      { numRuns: 200 },
    );
  });

  it("treats context-compressed as validated telemetry without a row", () => {
    const event: AgentEvents.ContextCompressedEvent = {
      type: "context-compressed",
      seq: 1,
      runId: "run",
      ts: new Date(0).toISOString(),
      originalTokens: 100,
      compressedTokens: 40,
      compressionRatio: 0.4,
    };
    expect(isRecognizedEvent(event)).toBe(false);
    const view = render(<AgentRunFeedView events={[]} now={frozenNow} />);
    const beforeHtml = view.container.innerHTML;
    view.rerender(<AgentRunFeedView events={[event]} now={frozenNow} />);
    expect(view.container.innerHTML).toBe(beforeHtml);
  });
});

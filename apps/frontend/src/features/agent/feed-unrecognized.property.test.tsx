/**
 * Property test — Feature: zoc-agent-ecosystem-merge,
 * Property 3: Unrecognized event types leave the feed unaltered.
 *
 * **Validates: Requirements 3.5**
 *
 * For any payload whose `type` is not one of the eight recognized Event_Contract
 * kinds, two facts must hold:
 *   1. `isRecognizedEvent` (from `rows.tsx`) reports it as unrecognized (false).
 *   2. The rendered feed is identical to the feed before the payload arrived —
 *      i.e. the unrecognized payload is discarded without altering the feed.
 *
 * The property is validated at the dispatch/guard + render level: the pure
 * presentational `AgentRunFeedView` (exported from `AgentRunFeed.tsx`) is
 * rendered with a recognized-only feed, then re-rendered with the same feed
 * plus an unrecognized payload spliced in at an arbitrary position. The two
 * rendered DOM snapshots must be byte-for-byte identical.
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

/** The eight recognized Event_Contract discriminators. */
const RECOGNIZED_TYPES: readonly string[] = [
  "intent",
  "thinking",
  "read-files",
  "edit-file",
  "command",
  "summary",
  "approval",
  "done",
];

/** A frozen clock so the render-budget fallback never fires during the test. */
const frozenNow = () => 0;

/**
 * Generates the type-specific payload for each recognized row kind (without the
 * shared `seq`/`runId`/`ts` fields, which are assigned deterministically so
 * seqs stay unique and ordering is controlled).
 */
const recognizedVariantArb = fc.oneof(
  fc.record({
    type: fc.constant("intent" as const),
    text: fc.string(),
    modelTier: fc.constantFrom("local-slm", "edge", "cloud") as fc.Arbitrary<AgentEvents.ModelTier>,
    contextWindowTokens: fc.nat(),
  }),
  fc.record({
    type: fc.constant("thinking" as const),
    text: fc.string(),
    collapsible: fc.constant(true as const),
  }),
  fc.record({
    type: fc.constant("read-files" as const),
    files: fc.array(fc.record({ path: fc.string() }), { maxLength: 4 }),
  }),
  fc.record({
    type: fc.constant("edit-file" as const),
    path: fc.string(),
    diff: fc.string(),
  }),
  fc.record({
    type: fc.constant("command" as const),
    command: fc.string(),
  }),
  fc.record({
    type: fc.constant("summary" as const),
    text: fc.string(),
  }),
  fc.record({
    type: fc.constant("approval" as const),
    prompt: fc.string(),
  }),
  fc.record({
    type: fc.constant("done" as const),
    ok: fc.boolean(),
  }),
);

/** A `type` string that is NOT one of the eight recognized kinds. */
const unrecognizedTypeArb = fc
  .string()
  .filter((t) => !RECOGNIZED_TYPES.includes(t));

describe("Property 3: Unrecognized event types leave the feed unaltered", () => {
  it("discards unrecognized payloads and renders an identical feed (Requirements 3.5)", () => {
    fc.assert(
      fc.property(
        fc.array(recognizedVariantArb, { maxLength: 8 }),
        unrecognizedTypeArb,
        fc.nat(),
        (variants, unrecognizedType, insertRaw) => {
          // Recognized feed: assign unique, ascending seqs + the shared fields.
          const recognized = variants.map((variant, index) => ({
            ...variant,
            seq: index,
            runId: `run-${index}`,
            ts: new Date(0).toISOString(),
          })) as unknown as AgentEvents.AgentEvent[];

          // The unrecognized payload — well-formed except for its `type`.
          const unrecognized = {
            type: unrecognizedType,
            seq: recognized.length + 1000,
            runId: "run-unrecognized",
            ts: new Date(0).toISOString(),
          };

          // Fact 1: the guard rejects it.
          expect(isRecognizedEvent(unrecognized)).toBe(false);

          // Splice the unrecognized payload into an arbitrary position.
          const insertAt = insertRaw % (recognized.length + 1);
          const withUnrecognized = [
            ...recognized.slice(0, insertAt),
            unrecognized,
            ...recognized.slice(insertAt),
          ] as unknown as AgentEvents.AgentEvent[];

          // Feed BEFORE the unrecognized payload arrives.
          const before = render(
            <AgentRunFeedView events={recognized} now={frozenNow} />,
          );
          const beforeHtml = before.container.innerHTML;
          before.unmount();

          // Feed AFTER the unrecognized payload arrives.
          const after = render(
            <AgentRunFeedView events={withUnrecognized} now={frozenNow} />,
          );
          const afterHtml = after.container.innerHTML;
          after.unmount();

          // Fact 2: the rendered feed is identical — the payload was discarded.
          expect(afterHtml).toBe(beforeHtml);
        },
      ),
      { numRuns: 100 },
    );
  });
});

/**
 * Feature: advanced-context-engine, Property 20: Frontend registry totality,
 * injectivity, and unknown-event discard.
 *
 * For every rendered Agent trace Event_Contract type:
 *   (a) `ROW_COMPONENTS` selects exactly one distinct component for that type,
 *   (b) the registry is total over `EventType`, and
 *   (c) rendering a recognized event uses the component mapped to its
 *       event-type discriminator.
 *
 * Each row component tags its root element with `data-event-type="<type>"`, so
 * rendering the registry-selected component for an event and finding exactly
 * one element carrying that event's discriminator proves the component mapped
 * to the discriminator is the one that rendered (R3.2, R3.3).
 *
 * Validates: Requirements 3.2, 3.3
 */
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render } from "@testing-library/react";
import fc from "fast-check";
import type { AgentEvents } from "@zoc-studio/shared-types";

import { ROW_COMPONENTS, isRecognizedEvent } from "./rows";

afterEach(() => {
  cleanup();
});

/** The Agent trace Event_Contract discriminators, declared independently of the
 *  registry so the test pins the expected domain rather than reading it back
 *  from the implementation under test. */
const EVENT_TYPES: AgentEvents.EventType[] = [
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

/** ISO-8601 timestamp arbitrary shared by every event's `BaseEvent` fields. */
const tsArb: fc.Arbitrary<string> = fc
  .date({ min: new Date("2000-01-01T00:00:00.000Z"), max: new Date("2100-01-01T00:00:00.000Z") })
  .map((d) => d.toISOString());

/** Fields common to every event (`BaseEvent`), minus the discriminator. */
const baseArb = fc.record({
  seq: fc.nat(),
  runId: fc.string({ minLength: 1, maxLength: 24 }),
  ts: tsArb,
});

/**
 * Produces a valid, fully-typed `AgentEvent` for the given discriminator. A
 * generator per kind keeps each event structurally faithful to its contract
 * interface so the row component renders without throwing.
 */
function arbEventOfType(type: AgentEvents.EventType): fc.Arbitrary<AgentEvents.AgentEvent> {
  switch (type) {
    case "intent":
      return fc
        .tuple(
          baseArb,
          fc.record({
            text: fc.string({ maxLength: 80 }),
            modelTier: fc.constantFrom<AgentEvents.ModelTier>("local-slm", "edge", "cloud"),
            contextWindowTokens: fc.nat(),
            fallbackReason: fc.option(fc.string({ maxLength: 40 }), { nil: undefined }),
          }),
        )
        .map(([b, r]): AgentEvents.AgentEvent => ({ ...b, type, ...r }));
    case "thinking":
      return fc
        .tuple(baseArb, fc.record({ text: fc.string({ maxLength: 80 }) }))
        .map(([b, r]): AgentEvents.AgentEvent => ({
          ...b,
          type,
          text: r.text,
          collapsible: true,
          truncated: false,
        }));
    case "plan":
      return fc
        .tuple(
          baseArb,
          fc.array(
            fc.record({
              id: fc.string({ minLength: 1, maxLength: 16 }),
              label: fc.string({ minLength: 1, maxLength: 60 }),
              status: fc.constantFrom<AgentEvents.PlanItemStatus>("pending", "active", "done"),
            }),
            { minLength: 1, maxLength: 5 },
          ),
        )
        .map(([b, items]): AgentEvents.AgentEvent => ({ ...b, type, items }));
    case "plan-update":
      return fc
        .tuple(
          baseArb,
          fc.record({
            id: fc.string({ minLength: 1, maxLength: 16 }),
            status: fc.constantFrom<AgentEvents.PlanItemStatus>("pending", "active", "done"),
          }),
        )
        .map(([b, r]): AgentEvents.AgentEvent => ({ ...b, type, ...r }));
    case "map-files":
      return fc
        .tuple(
          baseArb,
          fc.record({
            readList: fc.array(fc.string({ minLength: 1, maxLength: 40 }), { maxLength: 8 }),
            writeList: fc.array(fc.string({ minLength: 1, maxLength: 40 }), { maxLength: 8 }),
            rationale: fc.string({ maxLength: 120 }),
          }),
        )
        .map(([b, r]): AgentEvents.AgentEvent => ({ ...b, type, ...r }));
    case "read-files":
      return fc
        .tuple(
          baseArb,
          fc.array(
            fc.record({
              path: fc.string({ minLength: 1, maxLength: 40 }),
              span: fc.option(fc.tuple(fc.nat(), fc.nat()), { nil: undefined }),
            }),
            { maxLength: 5 },
          ),
        )
        .map(([b, files]): AgentEvents.AgentEvent => ({ ...b, type, files }));
    case "edit-file":
      return fc
        .tuple(
          baseArb,
          fc.record({ path: fc.string({ minLength: 1, maxLength: 40 }), diff: fc.string({ maxLength: 120 }) }),
        )
        .map(([b, r]): AgentEvents.AgentEvent => ({
          ...b,
          type,
          ...r,
          adds: 0,
          dels: 0,
          status: "done",
        }));
    case "command":
      return fc
        .tuple(
          baseArb,
          fc.record({
            command: fc.string({ minLength: 1, maxLength: 40 }),
            exitCode: fc.option(fc.integer({ min: -1, max: 255 }), { nil: undefined }),
            errorTag: fc.option(fc.string({ maxLength: 24 }), { nil: undefined }),
          }),
        )
        .map(([b, r]): AgentEvents.AgentEvent => ({ ...b, type, ...r }));
    case "review":
      return fc
        .tuple(
          baseArb,
          fc.array(
            fc.record({
              path: fc.string({ minLength: 1, maxLength: 40 }),
              diff: fc.string({ maxLength: 120 }),
              adds: fc.nat({ max: 50 }),
              dels: fc.nat({ max: 50 }),
              summary: fc.option(fc.string({ maxLength: 60 }), { nil: undefined }),
            }),
            { maxLength: 4 },
          ),
        )
        .map(
          ([b, files]): AgentEvents.AgentEvent => ({
            ...b,
            type,
            files,
            validation: {
              typecheck: { status: "skipped" },
              build: { status: "skipped" },
              tests: { status: "skipped" },
            },
          }),
        );
    case "summary":
      return fc
        .tuple(baseArb, fc.record({ text: fc.string({ maxLength: 120 }) }))
        .map(([b, r]): AgentEvents.AgentEvent => ({ ...b, type, text: r.text }));
    case "approval":
      return fc
        .tuple(baseArb, fc.record({ prompt: fc.string({ maxLength: 80 }) }))
        .map(([b, r]): AgentEvents.AgentEvent => ({ ...b, type, prompt: r.prompt }));
    case "done":
      return fc
        .tuple(
          baseArb,
          fc.record({ ok: fc.boolean(), reason: fc.option(fc.string({ maxLength: 40 }), { nil: undefined }) }),
        )
        .map(([b, r]): AgentEvents.AgentEvent => ({ ...b, type, ...r }));
  }
}

describe("Feature: advanced-context-engine, Property 20: frontend registry totality and injectivity", () => {
  it("registry is total over EventType with one distinct entry per discriminator", () => {
    // (b) totality: the registry's key set equals the Event_Contract
    // discriminators, no more and no fewer.
    const keys = Object.keys(ROW_COMPONENTS).sort();
    expect(keys).toEqual([...EVENT_TYPES].sort());
    expect(keys).toHaveLength(EVENT_TYPES.length);

    // (a) each type maps to a distinct component: the selected components
    // are pairwise distinct, so no two discriminators share a component.
    const components = EVENT_TYPES.map((t) => ROW_COMPONENTS[t]);
    expect(new Set(components).size).toBe(EVENT_TYPES.length);
  });

  it("selects exactly one distinct component per type and renders the discriminator-tagged row", () => {
    fc.assert(
      fc.property(
        fc.constantFrom(...EVENT_TYPES).chain((type) =>
          arbEventOfType(type).map((event) => ({ type, event })),
        ),
        ({ type, event }) => {
          // The dispatched event is recognized by the feed gate (R3.5 boundary).
          expect(isRecognizedEvent(event)).toBe(true);
          if (!isRecognizedEvent(event)) {
            throw new Error(`unrecognized generated row: ${event.type}`);
          }

          // (a) ROW_COMPONENTS selects exactly one component for this type, and
          // that component is unique to it across the whole registry.
          const selected = ROW_COMPONENTS[type];
          expect(typeof selected).toBe("function");
          const matchingKeys = EVENT_TYPES.filter((t) => ROW_COMPONENTS[t] === selected);
          expect(matchingKeys).toEqual([type]);

          // (c) Rendering a recognized event through the registry-selected
          // component yields exactly one element tagged with that event's
          // discriminator — i.e. the component mapped to the discriminator
          // rendered the row.
          const Selected = ROW_COMPONENTS[event.type];
          const { container, unmount } = render(<Selected event={event} />);
          try {
            const tagged = container.querySelectorAll("[data-event-type]");
            expect(tagged).toHaveLength(1);
            expect(tagged[0].getAttribute("data-event-type")).toBe(event.type);
          } finally {
            unmount();
          }
        },
      ),
      { numRuns: 200 },
    );
  });
});

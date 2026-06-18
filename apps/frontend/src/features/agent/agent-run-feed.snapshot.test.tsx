/**
 * Snapshot test — Feature: zoc-agent-ecosystem-merge (task 2.7).
 *
 * **Validates: Requirements 3.7**
 *
 * Pins the concrete DOM contract that the wiring task (4.2) relies on: the new
 * typed Event_Rows produced by `AgentRunFeedView` mount INSIDE the run region
 * — the single `.agent-run-feed` log container (grid row 3 of the preserved
 * `AgentPanel`) — and rendering rows introduces NO Panel_Shell wrapper, header,
 * or composer chrome around them.
 *
 * Rather than snapshot the full (large, brittle) row markup, this test captures
 * a compact STRUCTURAL snapshot of the run region — the container's tag, class,
 * role and the ordered `data-event-type` of its direct feed items — via
 * `toMatchInlineSnapshot`, then asserts the absence of any Panel_Shell chrome.
 */
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render } from "@testing-library/react";
import type { AgentEvents } from "@zoc-studio/shared-types";

import { AgentRunFeedView } from "./AgentRunFeed";

afterEach(() => {
  cleanup();
});

/** A frozen clock so the 100 ms render-budget fallback never fires here. */
const frozenNow = () => 0;

/**
 * A small fixed list of recognized events — one per row kind, with unique
 * ascending seqs and the shared `runId`/`ts` fields — so every typed row in the
 * `ROW_COMPONENTS` registry mounts in the region.
 */
const events: AgentEvents.AgentEvent[] = [
  {
    type: "intent",
    seq: 0,
    runId: "run-1",
    ts: new Date(0).toISOString(),
    text: "build the feature",
    modelTier: "local-slm",
    contextWindowTokens: 4096,
  },
  {
    type: "read-files",
    seq: 1,
    runId: "run-1",
    ts: new Date(0).toISOString(),
    files: [{ path: "src/index.ts" }],
  },
  {
    type: "command",
    seq: 2,
    runId: "run-1",
    ts: new Date(0).toISOString(),
    command: "pnpm test",
    exitCode: 0,
  },
  {
    type: "done",
    seq: 3,
    runId: "run-1",
    ts: new Date(0).toISOString(),
    ok: true,
  },
];

describe("AgentRunFeed snapshot (task 2.7, Requirements 3.7)", () => {
  it("mounts feed rows inside the run region with no Panel_Shell wrapper", () => {
    const { container } = render(
      <AgentRunFeedView events={events} now={frozenNow} />,
    );

    // The feed renders exactly one top-level element: the run region itself.
    expect(container.children.length).toBe(1);
    const region = container.firstElementChild as HTMLElement;

    // Compact structural snapshot of the run region: its tag/class/role and the
    // ordered discriminators of the feed items mounted directly inside it. Each
    // feed item is a direct `.feed-item` child whose row carries data-event-type.
    const structure = {
      tag: region.tagName.toLowerCase(),
      class: region.getAttribute("class"),
      role: region.getAttribute("role"),
      feedItems: Array.from(region.children).map((item) => ({
        class: item.getAttribute("class"),
        eventType: item
          .querySelector("[data-event-type]")
          ?.getAttribute("data-event-type"),
      })),
    };

    expect(structure).toMatchInlineSnapshot(`
      {
        "class": "agent-run-feed flex h-full min-h-0 flex-col gap-1.5 overflow-y-auto px-3 py-2",
        "feedItems": [
          {
            "class": "feed-item",
            "eventType": "intent",
          },
          {
            "class": "feed-item",
            "eventType": "read-files",
          },
          {
            "class": "feed-item",
            "eventType": "command",
          },
          {
            "class": "feed-item",
            "eventType": "done",
          },
        ],
        "role": "log",
        "tag": "div",
      }
    `);

    // The run region is the only top-level element — nothing wraps it.
    expect(region.classList.contains("agent-run-feed")).toBe(true);

    // No Panel_Shell / header / composer chrome is emitted by the feed.
    const shellSelectors = [
      ".agent-panel",
      ".agent-panel-shell",
      ".panel-shell",
      "[data-panel-shell]",
      ".agent-panel-header",
      ".agent-panel-control-bar",
      ".context-bar",
      "form",
      "textarea",
    ];
    for (const selector of shellSelectors) {
      expect(container.querySelector(selector)).toBeNull();
    }

    // Exactly one feed item per event, all descendants of the run region.
    const rows = region.querySelectorAll("[data-event-type]");
    expect(rows.length).toBe(events.length);
    for (const row of Array.from(rows)) {
      expect(region.contains(row)).toBe(true);
    }
  });
});

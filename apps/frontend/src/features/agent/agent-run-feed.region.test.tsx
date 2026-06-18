/**
 * Snapshot / region test — Feature: zoc-agent-ecosystem-merge (task 2.7).
 *
 * **Validates: Requirements 3.7**
 *
 * Asserts that the new typed Event_Rows produced by `AgentRunFeedView`
 * (from `AgentRunFeed.tsx`) mount INSIDE the run region — the `agent-run-feed`
 * container (`.agent-run-feed`, `role="log"`) that lives in grid row 3 of the
 * preserved `AgentPanel` — and that rendering rows introduces NO Panel_Shell
 * wrapper around them. The feed component renders only the inline feed region:
 * one element per recognized event carrying a `data-event-type`, every row a
 * descendant of the single `.agent-run-feed` log container, and nothing else.
 *
 * This is the example/region complement to the property tests: it pins the
 * concrete DOM contract that the wiring task (4.2) relies on when it drops
 * `<AgentRunFeed />` into the existing run region without touching the
 * surrounding Panel_Shell chrome.
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
 * A small set of recognized events — one per row kind — with unique, ascending
 * seqs and the shared `runId`/`ts` fields. The eight kinds cover the full
 * `ROW_COMPONENTS` registry so every typed row mounts in the region.
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
    type: "thinking",
    seq: 1,
    runId: "run-1",
    ts: new Date(0).toISOString(),
    text: "considering the approach",
    collapsible: true,
  },
  {
    type: "read-files",
    seq: 2,
    runId: "run-1",
    ts: new Date(0).toISOString(),
    files: [{ path: "src/index.ts" }, { path: "src/app.ts", span: [1, 10] }],
  },
  {
    type: "edit-file",
    seq: 3,
    runId: "run-1",
    ts: new Date(0).toISOString(),
    path: "src/app.ts",
    diff: "@@ -1 +1 @@\n-old\n+new",
  },
  {
    type: "command",
    seq: 4,
    runId: "run-1",
    ts: new Date(0).toISOString(),
    command: "pnpm test",
    exitCode: 0,
  },
  {
    type: "summary",
    seq: 5,
    runId: "run-1",
    ts: new Date(0).toISOString(),
    text: "all green",
  },
  {
    type: "approval",
    seq: 6,
    runId: "run-1",
    ts: new Date(0).toISOString(),
    prompt: "apply the edit?",
  },
  {
    type: "done",
    seq: 7,
    runId: "run-1",
    ts: new Date(0).toISOString(),
    ok: true,
  },
];

describe("AgentRunFeed region (task 2.7, Requirements 3.7)", () => {
  it("mounts the feed rows inside the run region container", () => {
    const { container } = render(
      <AgentRunFeedView events={events} now={frozenNow} />,
    );

    // The run region: a single `.agent-run-feed` log container.
    const region = container.querySelector(".agent-run-feed");
    expect(region).not.toBeNull();
    expect(region).toBeInstanceOf(HTMLElement);
    expect(region!.getAttribute("role")).toBe("log");

    // The feed component renders ONLY the region — no wrapper around it. The
    // region is the first (and only) element child of the render root.
    expect(container.children.length).toBe(1);
    expect(container.firstElementChild).toBe(region);
  });

  it("renders exactly one row element per event, each carrying data-event-type", () => {
    const { container } = render(
      <AgentRunFeedView events={events} now={frozenNow} />,
    );
    const region = container.querySelector(".agent-run-feed") as HTMLElement;

    const rows = region.querySelectorAll("[data-event-type]");
    // One element per event carrying its discriminator.
    expect(rows.length).toBe(events.length);

    const renderedTypes = Array.from(rows).map((row) =>
      row.getAttribute("data-event-type"),
    );
    expect(renderedTypes).toEqual(events.map((event) => event.type));

    // Every row mounts INSIDE the run region (not a sibling/escapee).
    for (const row of Array.from(rows)) {
      expect(region.contains(row)).toBe(true);
    }
  });

  it("introduces no Panel_Shell wrapper when rendering rows", () => {
    const { container } = render(
      <AgentRunFeedView events={events} now={frozenNow} />,
    );

    // The feed must not enclose or emit any Panel_Shell chrome — the preserved
    // panel structure (panel shell, header, control bar, context bar) is owned
    // by AgentPanel and is never produced here.
    const shellSelectors = [
      ".agent-panel",
      ".agent-panel-shell",
      ".panel-shell",
      "[data-panel-shell]",
      ".agent-panel-header",
      ".agent-panel-control-bar",
      ".context-bar",
    ];
    for (const selector of shellSelectors) {
      expect(container.querySelector(selector)).toBeNull();
    }

    // The render root contains the single feed region and nothing wrapping it.
    expect(container.firstElementChild?.classList.contains("agent-run-feed")).toBe(
      true,
    );
  });
});

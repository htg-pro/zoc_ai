/**
 * Tool-call timeline rendering — zoc-agent-chat-rebuild R22.1, R9.2, R9.3, R9.5, task 22.13.
 *
 * The "tool-call timeline rendering" area of R22.1's unit suite, and the three things 22.13 names for it:
 * states, clustering, and expansion.
 *
 * ## Why this exists beside Properties 44 to 46
 *
 * Those three already walk the timeline over generated entries, and they are the stronger tests. They are
 * also *optional* — the plan makes every property test optional, and 22.13 is the task that is not — so an
 * area covered only by a property is an area a fast-MVP run ships with no coverage at all. This file
 * therefore states the same claims as a small number of fixed, readable cases: what a reviewer would check
 * by hand, and what fails legibly when the timeline changes shape.
 *
 * The cluster threshold is the one place the two overlap deliberately. R9.5 puts it at "longer than 3",
 * which means a run of exactly 3 must *not* cluster and a run of 4 must — an off-by-one that a generated
 * test reports as a shrunken counterexample and this file reports as a named case.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render } from "@testing-library/react";
import type { ToolKind } from "@zoc-studio/shared-types";

import { ToolTimeline } from "@/features/chat/timeline/ToolTimeline";
import type { ToolEntryModel, ToolEntryState } from "@/features/chat/timeline/tool-entry-model";

afterEach(cleanup);

function entry(overrides: Partial<ToolEntryModel> = {}): ToolEntryModel {
  return {
    toolCallId: "call_1",
    toolName: "workspace_read",
    kind: "read" as ToolKind,
    state: "succeeded" as ToolEntryState,
    durationMs: 120,
    ...overrides,
  };
}

/** `count` consecutive calls of one tool, which is what the clustering rule is about. */
function run(toolName: string, count: number, from = 0): ToolEntryModel[] {
  return Array.from({ length: count }, (_, index) =>
    entry({ toolCallId: `call_${String(from + index)}`, toolName }),
  );
}

const all = (selector: string): HTMLElement[] => [
  ...document.querySelectorAll<HTMLElement>(selector),
];

const el = (selector: string): HTMLElement | null => document.querySelector<HTMLElement>(selector);

describe("Feature: zoc-agent-chat-rebuild, task 22.13: the tool-call timeline (R22.1)", () => {
  it("renders one entry per call, carrying its state and its duration (R9.2)", () => {
    render(
      <ToolTimeline
        entries={[
          entry({ toolCallId: "call_a", state: "running" }),
          entry({ toolCallId: "call_b", state: "succeeded", durationMs: 1_500 }),
          entry({ toolCallId: "call_c", toolName: "workspace_run_command", state: "failed" }),
          entry({ toolCallId: "call_d", toolName: "workspace_apply_hunks", state: "denied" }),
        ]}
      />,
    );

    expect(all("[data-zoc-tool-entry]")).toHaveLength(4);
    // The state is on the node rather than only in a colour, which is what keeps it readable without
    // colour (R21.7) and assertable without reading styles.
    expect(
      all("[data-zoc-tool-state]").map((node) => node.getAttribute("data-zoc-tool-state")),
    ).toEqual(["running", "succeeded", "failed", "denied"]);
    expect(all("[data-zoc-tool-duration]").length).toBeGreaterThan(0);
  });

  it("exposes the timeline as a list, and each entry as its item (R21.4)", () => {
    render(<ToolTimeline entries={run("workspace_read", 2)} />);
    expect(el("[data-zoc-tool-timeline]")?.getAttribute("role")).toBe("list");
    expect(all('[data-zoc-tool-entry][role="listitem"]')).toHaveLength(2);
  });

  it("leaves a run of three as three entries, and clusters a run of four (R9.5)", () => {
    // The threshold, from both sides. R9.5 says "longer than 3", so three is the boundary that must not
    // collapse — a cluster of three would hide detail the user never asked to hide.
    const three = render(<ToolTimeline entries={run("workspace_read", 3)} />);
    expect(all("[data-zoc-tool-cluster]")).toHaveLength(0);
    expect(all("[data-zoc-tool-entry]")).toHaveLength(3);
    three.unmount();

    render(<ToolTimeline entries={run("workspace_read", 4)} />);
    expect(all("[data-zoc-tool-cluster]")).toHaveLength(1);
    expect(el("[data-zoc-cluster-count]")?.textContent).toContain("4");
  });

  it("breaks a cluster where the tool changes", () => {
    render(
      <ToolTimeline
        entries={[
          ...run("workspace_read", 4, 0),
          ...run("workspace_run_command", 1, 10),
          ...run("workspace_read", 4, 20),
        ]}
      />,
    );
    // Two clusters and one lone entry: consecutive is per tool name, not per timeline.
    expect(all("[data-zoc-tool-cluster]")).toHaveLength(2);
    expect(all("[data-zoc-tool-entry]")).toHaveLength(1);
  });

  it("yields the call's input and output when an entry is expanded (R9.3)", () => {
    render(
      <ToolTimeline
        entries={[
          entry({
            input: '{"path":"src/a.ts","encoding":"utf-8"}',
            output: '{"bytes":240}',
            readPaths: ["src/a.ts"],
            writtenPaths: [],
          }),
        ]}
      />,
    );

    // Collapsed by default — a timeline that opened every call would bury the answer. Collapsed
    // means *present and `hidden`*, not absent: the region stays mounted so the trigger's
    // `aria-controls` keeps pointing at a real node and a screen reader is told there is something
    // folded up here rather than finding a dangling reference (R21.4). `reasoning-retention`
    // pins the same contract for the reasoning row; asserting absence here would assert the
    // opposite of the behaviour the disclosure is built on.
    const trigger = el("[data-zoc-tool-trigger]");
    expect(trigger).not.toBeNull();
    expect(el("[data-zoc-tool-detail]")?.hasAttribute("hidden")).toBe(true);
    expect(trigger?.getAttribute("aria-expanded")).toBe("false");
    expect(trigger?.getAttribute("aria-controls")).toBe(
      el("[data-zoc-tool-detail]")?.getAttribute("id"),
    );

    fireEvent.click(trigger as HTMLElement);

    expect(el("[data-zoc-tool-detail]")?.hasAttribute("hidden")).toBe(false);
    expect(trigger?.getAttribute("aria-expanded")).toBe("true");
    // Each claim lands on its own node rather than on the region's whole `textContent`: R9.3 names
    // the input *and* the output, and a detail rendering one of the two would still contain
    // `src/a.ts` by way of the read-path list.
    expect(el('[data-zoc-detail-body="input"]')?.textContent).toContain("utf-8");
    expect(el('[data-zoc-detail-body="output"]')?.textContent).toContain("240");
    expect(el('[data-zoc-path="src/a.ts"]')).not.toBeNull();
  });

  it("opens a cluster to its members without opening their details", () => {
    // Members that each *have* something to disclose, which is what makes the claim in the title
    // non-vacuous: over detail-free entries no member renders a disclosure at all, and "their
    // details stayed shut" would hold for the wrong reason.
    render(
      <ToolTimeline
        entries={Array.from({ length: 5 }, (_, index) =>
          entry({
            toolCallId: `call_${String(index)}`,
            input: `{"path":"src/${String(index)}.ts"}`,
          }),
        )}
      />,
    );

    const clusterTrigger = el("[data-zoc-cluster-trigger]");
    expect(el("[data-zoc-cluster-members]")?.hasAttribute("hidden")).toBe(true);
    expect(clusterTrigger?.getAttribute("aria-expanded")).toBe("false");

    fireEvent.click(clusterTrigger as HTMLElement);
    const members = el("[data-zoc-cluster-members]");
    expect(members?.hasAttribute("hidden")).toBe(false);
    expect(members?.querySelectorAll("[data-zoc-tool-entry]")).toHaveLength(5);

    // Two levels of disclosure, independently: the cluster says which calls, an entry says what it
    // did. Opening the cluster opens no member…
    expect(all("[data-zoc-tool-detail]")).toHaveLength(5);
    expect(
      all("[data-zoc-tool-detail]").filter((node) => !node.hasAttribute("hidden")),
    ).toHaveLength(0);

    // …and opening one member opens only that one.
    fireEvent.click(all("[data-zoc-tool-trigger]")[0] as HTMLElement);
    expect(
      all("[data-zoc-tool-detail]").filter((node) => !node.hasAttribute("hidden")),
    ).toHaveLength(1);
  });

  it("offers a retry on a retryable failure and on nothing else (R9.6)", () => {
    const onRetry = vi.fn();
    render(
      <ToolTimeline
        entries={[
          entry({ toolCallId: "call_ok", state: "succeeded" }),
          entry({
            toolCallId: "call_bad",
            toolName: "workspace_run_command",
            state: "failed",
            error: { code: "tool_failed", message: "read timed out", retryable: true },
          }),
          entry({
            toolCallId: "call_fatal",
            toolName: "workspace_apply_hunks",
            state: "failed",
            error: { code: "path_outside_workspace", message: "refused", retryable: false },
          }),
          entry({
            toolCallId: "call_denied",
            toolName: "workspace_write_file",
            state: "denied",
            error: { code: "permission_denied", message: "not permitted", retryable: false },
          }),
        ]}
        onRetry={onRetry}
      />,
    );

    // Three failures reported, one control. The non-retryable failure and the denial each state
    // what happened and offer nothing — absent rather than disabled (R9.6), because a disabled
    // button asks the reader to work out why it is disabled.
    expect(all("[data-zoc-tool-error]")).toHaveLength(3);
    const retries = all("[data-zoc-tool-retry]");
    expect(retries).toHaveLength(1);

    fireEvent.click(retries[0] as HTMLElement);
    expect(onRetry).toHaveBeenCalledWith("call_bad");
  });

  it("offers no retry at all when the caller passed no handler", () => {
    // The affordance is the caller's to offer: a control that fires nothing would be worse than
    // no control, and this is the branch a `showRetry` that forgot `onRetry` would break.
    render(
      <ToolTimeline
        entries={[
          entry({
            toolCallId: "call_bad",
            state: "failed",
            error: { code: "tool_failed", message: "read timed out", retryable: true },
          }),
        ]}
      />,
    );

    expect(el("[data-zoc-tool-error]")).not.toBeNull();
    expect(all("[data-zoc-tool-retry]")).toHaveLength(0);
  });

  it("renders nothing at all for a Run that called no tool", () => {
    // Not an empty list with a heading: an empty `role="list"` is announced as "list, 0 items", which
    // tells a screen-reader user something is missing here.
    render(<ToolTimeline entries={[]} />);
    expect(el("[data-zoc-tool-timeline]")).toBeNull();
  });
});

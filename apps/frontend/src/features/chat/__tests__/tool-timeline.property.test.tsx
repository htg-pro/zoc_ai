/**
 * Property 44: Tool entries expose their full detail and every affected path. R9.2, R9.3, R9.4.
 * Property 45: Tool clustering matches the threshold exactly. R9.5.
 * Property 46: Timeline entries are self-describing. R9.7, R21.4.
 *
 * Property 45 is asserted against `groupTimeline` rather than against a render, and that is the
 * point of the model/component split: "runs longer than 3 cluster, runs of 3 or fewer do not" is
 * arithmetic over a sequence, and the off-by-one R9.5 invites is a fact about a function. The
 * other two need the DOM, because "reachable in the entry" and "the accessible name contains"
 * are claims about what a user and a screen reader can get to.
 */

import { afterEach, describe, expect, it } from "vitest";
import { cleanup, fireEvent, render } from "@testing-library/react";
import fc from "fast-check";
import type { ToolKind } from "@zoc-studio/shared-types";

import { ChatMotionProvider } from "@/lib/reduced-motion-provider";
import { ToolTimeline } from "@/features/chat/timeline/ToolTimeline";
import {
  CLUSTER_THRESHOLD,
  accessibleNameOf,
  formatDuration,
  groupTimeline,
  nodeShapeOf,
  stateLabelOf,
  truncatePath,
  type ToolEntryModel,
  type ToolEntryState,
} from "@/features/chat/timeline/tool-entry-model";

const RUNS = { numRuns: 100 } as const;

afterEach(cleanup);

const TOOL_KINDS: readonly ToolKind[] = ["read", "write", "execute", "search", "network", "mcp"];
const STATES: readonly ToolEntryState[] = ["running", "succeeded", "failed", "denied"];

/** A workspace-relative path, sometimes long enough to need truncating. */
const path = fc
  .array(fc.stringMatching(/^[a-z][a-z0-9-]{0,11}$/), { minLength: 1, maxLength: 7 })
  .map((segments) => `${segments.join("/")}.ts`);

const entry = (overrides: Partial<ToolEntryModel> = {}): ToolEntryModel => ({
  toolCallId: "call_1",
  toolName: "workspace_read",
  kind: "read",
  state: "succeeded",
  durationMs: 120,
  ...overrides,
});

const arbitraryEntry: fc.Arbitrary<ToolEntryModel> = fc
  .record({
    toolCallId: fc.stringMatching(/^call_[a-z0-9]{4,8}$/),
    toolName: fc.constantFrom("workspace_read", "workspace_apply_hunks", "workspace_run_command"),
    kind: fc.constantFrom(...TOOL_KINDS),
    state: fc.constantFrom(...STATES),
    durationMs: fc.integer({ min: 0, max: 600_000 }),
    summary: fc.string({ maxLength: 60 }),
    input: fc.string({ maxLength: 200 }),
    output: fc.string({ maxLength: 200 }),
    readPaths: fc.array(path, { maxLength: 6 }),
    writtenPaths: fc.array(path, { maxLength: 6 }),
    metric: fc.constantFrom("142L", "+24 −11", "exit 0", "12 hits", ""),
  })
  .map((record) => record as ToolEntryModel);

function mount(entries: readonly ToolEntryModel[]) {
  return render(
    <ChatMotionProvider budget={null}>
      <ToolTimeline entries={entries} onRetry={() => undefined} />
    </ChatMotionProvider>,
  );
}

describe("Feature: zoc-agent-chat-rebuild, Property 45: tool clustering matches the threshold exactly", () => {
  /** A tool-name sequence, drawn from a small alphabet so runs actually occur. */
  const names = fc.array(fc.constantFrom("read", "write", "exec"), { maxLength: 40 });

  /** The consecutive-run lengths in a name sequence — the model the property is stated against. */
  function runsOf(sequence: readonly string[]): number[] {
    const out: number[] = [];
    let index = 0;
    while (index < sequence.length) {
      let end = index + 1;
      while (end < sequence.length && sequence[end] === sequence[index]) end += 1;
      out.push(end - index);
      index = end;
    }
    return out;
  }

  it("clusters a run longer than 3 and leaves a run of 3 or fewer as individual entries", () => {
    fc.assert(
      fc.property(names, (sequence) => {
        const entries = sequence.map((name, index) =>
          entry({ toolCallId: `call_${String(index)}`, toolName: name }),
        );
        const items = groupTimeline(entries);
        const expectedRuns = runsOf(sequence);

        // One item per run when the run clusters; `n` items when it does not.
        const produced: number[] = [];
        for (const item of items) {
          produced.push(item.kind === "cluster" ? item.count : 1);
        }

        const expected = expectedRuns.flatMap((length) =>
          length > CLUSTER_THRESHOLD ? [length] : Array.from({ length }, () => 1),
        );
        expect(produced).toEqual(expected);
      }),
      RUNS,
    );
  });

  it("gives a cluster a displayed count equal to the run length", () => {
    fc.assert(
      fc.property(fc.integer({ min: CLUSTER_THRESHOLD + 1, max: 30 }), (length) => {
        const entries = Array.from({ length }, (_unused, index) =>
          entry({ toolCallId: `call_${String(index)}`, toolName: "workspace_read" }),
        );
        const items = groupTimeline(entries);

        expect(items).toHaveLength(1);
        const cluster = items[0];
        expect(cluster?.kind).toBe("cluster");
        if (cluster?.kind === "cluster") {
          // The number the row shows is exactly how many calls it stands for, so a reader can
          // add the visible counts and get the run's real tool total.
          expect(cluster.count).toBe(length);
          expect(cluster.members).toHaveLength(length);
        }
      }),
      RUNS,
    );
  });

  it("does not cluster at exactly the threshold", () => {
    // The off-by-one R9.5 invites, pinned in both directions: three stay legible, four collapse.
    for (const length of [1, 2, CLUSTER_THRESHOLD]) {
      const entries = Array.from({ length }, (_unused, index) =>
        entry({ toolCallId: `call_${String(index)}`, toolName: "workspace_read" }),
      );
      const items = groupTimeline(entries);
      expect(items, `length ${String(length)}`).toHaveLength(length);
      expect(items.every((item) => item.kind === "entry")).toBe(true);
    }

    const four = Array.from({ length: CLUSTER_THRESHOLD + 1 }, (_unused, index) =>
      entry({ toolCallId: `call_${String(index)}`, toolName: "workspace_read" }),
    );
    expect(groupTimeline(four)).toHaveLength(1);
  });

  it("clusters only consecutive calls, never merely repeated ones", () => {
    // `read read write read read` is four reads and no run longer than two. A grouping by name
    // over the whole sequence would collapse them into one row and destroy the ordering the
    // timeline exists to show.
    const sequence = ["read", "read", "write", "read", "read"];
    const items = groupTimeline(
      sequence.map((name, index) => entry({ toolCallId: `call_${String(index)}`, toolName: name })),
    );
    expect(items).toHaveLength(5);
    expect(items.every((item) => item.kind === "entry")).toBe(true);
  });

  it("reports a cluster as failed when any member failed", () => {
    // A cluster reported as succeeded because most of it did would hide the one entry the user
    // needs to open.
    fc.assert(
      fc.property(fc.integer({ min: 0, max: 4 }), (failedIndex) => {
        const entries = Array.from({ length: 5 }, (_unused, index) =>
          entry({
            toolCallId: `call_${String(index)}`,
            toolName: "workspace_read",
            state: index === failedIndex ? "failed" : "succeeded",
          }),
        );
        const cluster = groupTimeline(entries)[0];
        expect(cluster?.kind === "cluster" && cluster.state).toBe("failed");
      }),
      RUNS,
    );
  });

  it("sums member durations, so a cluster carries one duration like an entry", () => {
    fc.assert(
      fc.property(
        fc.array(fc.integer({ min: 0, max: 5_000 }), { minLength: 4, maxLength: 12 }),
        (durations) => {
          const entries = durations.map((durationMs, index) =>
            entry({ toolCallId: `call_${String(index)}`, toolName: "workspace_read", durationMs }),
          );
          const cluster = groupTimeline(entries)[0];
          if (cluster?.kind === "cluster") {
            expect(cluster.durationMs).toBe(durations.reduce((a, b) => a + b, 0));
          }
        },
      ),
      RUNS,
    );
  });
});

describe("Feature: zoc-agent-chat-rebuild, Property 44: tool entries expose their full detail and every affected path", () => {
  it("displays the state and the duration on the collapsed entry (R9.2)", () => {
    fc.assert(
      fc.property(arbitraryEntry, (model) => {
        cleanup();
        const { container } = mount([model]);
        const row = container.querySelector(`[data-zoc-tool-entry="${model.toolCallId}"]`);
        expect(row).not.toBeNull();

        // Both, without expanding anything: R9.2's "always present" is about the collapsed row.
        expect(row?.querySelector("[data-zoc-tool-state]")?.textContent).toBe(
          stateLabelOf(model.state),
        );
        expect(row?.querySelector("[data-zoc-tool-duration]")?.textContent).toBe(
          formatDuration(model.durationMs),
        );
      }),
      RUNS,
    );
  });

  it("yields input and output equal to the source values when expanded (R9.3)", () => {
    fc.assert(
      fc.property(arbitraryEntry, (model) => {
        cleanup();
        const { container } = mount([model]);
        const trigger = container.querySelector("[data-zoc-tool-trigger]");
        if (trigger !== null) fireEvent.click(trigger);

        // Byte for byte. A trim or a re-serialise would make "equal to the source values" false
        // in a way no rendering test would notice.
        for (const [label, source] of [
          ["input", model.input],
          ["output", model.output],
        ] as const) {
          if (source === undefined || source.length === 0) continue;
          expect(
            container.querySelector(`[data-zoc-detail-body="${label}"]`)?.textContent,
            label,
          ).toBe(source);
        }
      }),
      RUNS,
    );
  });

  it("makes every read and written path reachable in the entry (R9.4)", () => {
    fc.assert(
      fc.property(arbitraryEntry, (model) => {
        cleanup();
        const { container } = mount([model]);
        const trigger = container.querySelector("[data-zoc-tool-trigger]");
        if (trigger !== null) fireEvent.click(trigger);

        // "Reachable" is the property's word, and the collapsed display truncates — so the full
        // path is carried on the element. A path only present in its truncated form would be
        // unreachable in exactly the case truncation exists for.
        const reachable = new Set(
          [...container.querySelectorAll("[data-zoc-path]")].map((node) =>
            node.getAttribute("data-zoc-path"),
          ),
        );

        for (const [label, group] of [
          ["read", model.readPaths ?? []],
          ["wrote", model.writtenPaths ?? []],
        ] as const) {
          // The property calls these path *sets*, and the runtime can report one path twice — a
          // tool that read a file, wrote it, and read it back. So the claim is about distinct
          // paths, which is also what the row counts.
          const distinct = [...new Set(group)];
          if (distinct.length === 0) continue;

          const list = container.querySelector(`[data-zoc-path-list="${label}"]`);
          const overflow = Number(
            list
              ?.querySelector("[data-zoc-path-overflow]")
              ?.getAttribute("data-zoc-path-overflow") ?? "0",
          );
          const shown = distinct.filter((candidate) => reachable.has(candidate)).length;
          expect(shown + overflow, `${label}: ${JSON.stringify(distinct)}`).toBe(distinct.length);
        }
      }),
      RUNS,
    );
  });

  it("shows a retry control for a retryable failure and none otherwise (R9.6)", () => {
    fc.assert(
      fc.property(fc.boolean(), fc.constantFrom(...STATES), (retryable, state) => {
        cleanup();
        const { container } = mount([
          entry({ state, error: { code: "workspace_failed", message: "refused", retryable } }),
        ]);
        const retry = container.querySelector("[data-zoc-tool-retry]");

        // Absent, not disabled: a disabled button invites a user to work out why.
        if (state === "failed" && retryable) expect(retry).not.toBeNull();
        else expect(retry).toBeNull();
      }),
      RUNS,
    );
  });

  it("truncates a long path from the middle, keeping the filename (R9.4)", () => {
    // The invariant a renderer cannot state: a reader identifies an entry by its file, so the
    // filename is what has to survive.
    fc.assert(
      fc.property(path, (candidate) => {
        const truncated = truncatePath(candidate, 24);
        const filename = candidate.slice(candidate.lastIndexOf("/") + 1);
        expect(truncated.endsWith(filename), `${candidate} → ${truncated}`).toBe(true);
      }),
      RUNS,
    );
  });

  it("offers no disclosure for an entry with nothing to disclose", () => {
    // A trigger that expands to an empty region teaches a user the control is broken.
    const { container } = mount([entry()]);
    expect(container.querySelector("[data-zoc-tool-trigger]")).toBeNull();
    expect(container.querySelector("[data-zoc-tool-entry]")).not.toBeNull();
  });
});

describe("Feature: zoc-agent-chat-rebuild, Property 46: timeline entries are self-describing", () => {
  it("names the tool, a state, and a duration in every entry's accessible name", () => {
    fc.assert(
      fc.property(arbitraryEntry, (model) => {
        cleanup();
        const { container } = mount([model]);
        const name = container
          .querySelector(`[data-zoc-tool-entry="${model.toolCallId}"]`)
          ?.getAttribute("aria-label");

        expect(name).not.toBeNull();
        // All three facts, and asserted as *containment* rather than against the exact string,
        // because the property's claim is about what a screen reader hears rather than about
        // punctuation.
        expect(name, "tool name").toContain(model.toolName);
        expect(name, "state").toContain(stateLabelOf(model.state));
        expect(name, "duration").toContain(formatDuration(model.durationMs));
      }),
      RUNS,
    );
  });

  it("names a cluster as a group, with its count", () => {
    // A cluster naming itself "4, succeeded, 1.2s" would give a screen-reader user no clue the
    // row stands for more than one call — which is precisely the information clustering removes
    // from the visual channel.
    fc.assert(
      fc.property(fc.integer({ min: CLUSTER_THRESHOLD + 1, max: 12 }), (length) => {
        cleanup();
        const entries = Array.from({ length }, (_unused, index) =>
          entry({ toolCallId: `call_${String(index)}`, toolName: "workspace_read" }),
        );
        const { container } = mount(entries);
        const name = container.querySelector("[data-zoc-tool-cluster]")?.getAttribute("aria-label");

        expect(name).toContain(String(length));
        expect(name).toContain("workspace_read");
        expect(name).toContain("succeeded");
      }),
      RUNS,
    );
  });

  it("exposes the timeline as a semantic list (R21.4)", () => {
    fc.assert(
      fc.property(fc.array(arbitraryEntry, { minLength: 1, maxLength: 8 }), (entries) => {
        cleanup();
        // Ids have to be distinct or React drops rows, which would make the count assertion
        // below measure the generator rather than the component.
        const unique = entries.map((model, index) => ({
          ...model,
          toolCallId: `call_${String(index)}`,
        }));
        const { container } = mount(unique);

        const list = container.querySelector("ol[data-zoc-tool-timeline]");
        expect(list).not.toBeNull();
        // Every top-level row is an `<li>` of that `<ol>` — not a `div` with a `role`, which is
        // what an implicit list semantics claim usually degrades into.
        const items = [...(list?.children ?? [])];
        expect(items.length).toBeGreaterThan(0);
        for (const item of items) expect(item.tagName).toBe("LI");
      }),
      RUNS,
    );
  });

  it("carries the node's shape as data, so state is not colour-only (R21.7)", () => {
    fc.assert(
      fc.property(fc.constantFrom(...TOOL_KINDS), fc.constantFrom(...STATES), (kind, state) => {
        cleanup();
        const { container } = mount([entry({ kind, state })]);
        const node = container.querySelector("[data-zoc-tool-node]");

        expect(node?.getAttribute("data-shape")).toBe(nodeShapeOf(kind, state));
        expect(node?.getAttribute("data-state")).toBe(state);
        // And the state is text on the row as well as a shape on the node: two non-colour
        // carriers rather than one.
        expect(container.querySelector("[data-zoc-tool-state]")?.textContent).toBe(
          stateLabelOf(state),
        );
      }),
      RUNS,
    );
  });

  it("hides the node from assistive technology, because the row already names it", () => {
    // Otherwise every entry is announced twice: once as its label, once as a decorative glyph.
    const { container } = mount([entry()]);
    expect(container.querySelector("[data-zoc-tool-node]")?.getAttribute("aria-hidden")).toBe(
      "true",
    );
  });

  it("keeps the model's accessible name and the rendered one in agreement", () => {
    // `accessibleNameOf` is what Property 46 is stated against; the render is what a user gets.
    // A component that assembled its own string would satisfy one and not the other.
    fc.assert(
      fc.property(arbitraryEntry, (model) => {
        cleanup();
        const { container } = mount([model]);
        expect(
          container
            .querySelector(`[data-zoc-tool-entry="${model.toolCallId}"]`)
            ?.getAttribute("aria-label"),
        ).toBe(accessibleNameOf(model));
      }),
      RUNS,
    );
  });
});

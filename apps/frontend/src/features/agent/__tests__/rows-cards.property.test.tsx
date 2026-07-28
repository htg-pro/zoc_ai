// Feature: zoc-ai-agent-chat-overhaul, Property 18: Pending approvals are presented, identified, and focused
// Feature: zoc-ai-agent-chat-overhaul, Property 26: Tool calls are presented as auditable, grouped steps
// Feature: zoc-ai-agent-chat-overhaul, Property 27: Diffs report change facts consistently and reviewably
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import fc from "fast-check";
import { type FeedRow, normalizeEvents } from "../normalize";
import { renderRow, RowActionsProvider } from "../rows";

afterEach(cleanup);

describe("pending approvals (Property 18)", () => {
  it("states the operation, offers approve and reject, and focuses the control group", () => {
    fc.assert(
      fc.property(fc.string({ minLength: 1 }), fc.string({ minLength: 1 }), (prompt, operation) => {
        const row: FeedRow = {
          id: "a:1",
          seq: 1,
          runId: "run-1",
          kind: "approval",
          prompt,
          operation,
          tool: operation,
          target: null,
          decision: null,
        };
        const { container, getByText, unmount } = render(<div>{renderRow(row)}</div>);
        // Operation identified.
        expect(container.textContent ?? "").toContain(operation);
        // Both controls present.
        expect(getByText("Approve")).toBeTruthy();
        expect(getByText("Reject")).toBeTruthy();
        // Focus moved into the control group.
        const active = document.activeElement;
        expect(active).not.toBeNull();
        expect(container.contains(active)).toBe(true);
        expect(active?.tagName).toBe("BUTTON");
        unmount();
      }),
      { numRuns: 100 },
    );
  });
});

describe("tool calls (Property 26)", () => {
  it("shows name, target, and status; truncates long results with a reveal control", () => {
    const result = Array.from({ length: 30 }, (_, i) => `line-${i}`).join("\n");
    const row: FeedRow = {
      id: "t:1",
      seq: 1,
      runId: "run-1",
      kind: "tool-call",
      tool: "shell",
      target: "npm test",
      status: "succeeded",
      result,
      failure: null,
      key: "k1",
    };
    const { container, getByText } = render(<div>{renderRow(row)}</div>);
    expect(container.textContent ?? "").toContain("shell");
    expect(container.textContent ?? "").toContain("npm test");
    expect(container.textContent ?? "").toContain("succeeded");
    // Expand to reveal the (truncated) result.
    fireEvent.click(container.querySelector("button")!);
    expect(getByText("Show all 30 lines")).toBeTruthy();
    // Preview stops before line 25.
    const pre = container.querySelector("pre");
    expect(pre?.textContent ?? "").not.toContain("line-25");
  });

  it("groups consecutive same-tool calls with a member count preserving order", () => {
    fc.assert(
      fc.property(fc.integer({ min: 2, max: 6 }), (n) => {
        const events = Array.from({ length: n }, (_, i) => ({
          type: "command",
          seq: i,
          runId: "run-1",
          ts: "t",
          command: `cmd-${i}`,
          commandId: `c-${i}`,
          status: "pass",
          exitCode: 0,
        }));
        const { rows } = normalizeEvents(events, {
          activeRunId: "run-1",
          boundMessageId: null,
          highestSeq: -1,
        });
        const groups = rows.filter((r) => r.kind === "tool-group");
        expect(groups.length).toBe(1);
        const group = groups[0];
        if (group.kind === "tool-group") {
          expect(group.count).toBe(n);
          expect(group.members.length).toBe(n);
          // Order preserved.
          expect(group.members.map((m) => m.target)).toEqual(
            events.map((e) => e.command),
          );
        }
      }),
      { numRuns: 60 },
    );
  });
});

describe("diffs (Property 27)", () => {
  it("shows path + counts, labels changed lines by text, lists files separately, offers controls", () => {
    const row: FeedRow = {
      id: "d:1",
      seq: 1,
      runId: "run-1",
      kind: "diff",
      files: [
        { path: "a.ts", adds: 2, dels: 1, diff: "@@ -1,2 +1,3 @@\n ctx\n+added one\n+added two\n-removed one", baseHash: null },
        { path: "b.ts", adds: 1, dels: 0, diff: "@@ -0,0 +1 @@\n+only add", baseHash: null },
      ],
      decision: "pending",
    };
    const { container, getByText } = render(<div>{renderRow(row)}</div>);
    // Two separately expandable entries.
    const files = container.querySelectorAll("[data-diff-file]");
    expect(files.length).toBe(2);
    // Counts present.
    expect(container.textContent ?? "").toContain("+2");
    expect(container.textContent ?? "").toContain("−1");
    // Accept + reject while pending.
    expect(getByText("Accept")).toBeTruthy();
    expect(getByText("Reject")).toBeTruthy();
    // Expand the first file and check text labels accompany colour.
    fireEvent.click(files[0].querySelector("button")!);
    const text = files[0].textContent ?? "";
    expect(text).toContain("added");
    expect(text).toContain("removed");
  });

  it("marks a stale change (live SHA-256 vs baseHash) and offers a regenerate control", async () => {
    const row: FeedRow = {
      id: "d:2",
      seq: 1,
      runId: "run-1",
      kind: "diff",
      files: [{ path: "a.ts", adds: 1, dels: 0, diff: "@@\n+x", baseHash: "old" }],
      decision: "pending",
    };
    // Staleness is decided live by comparing the file's current SHA-256 to the
    // recorded baseHash (R12.7) — never from a failed status. The probe reports
    // a diverged hash, so the row is stale and offers Regenerate.
    const { findByText } = render(
      <RowActionsProvider
        actions={{ probeFile: async () => ({ exists: true, sha256: "different" }) }}
      >
        {renderRow(row)}
      </RowActionsProvider>,
    );
    expect(await findByText("Regenerate")).toBeTruthy();
  });

  it("does NOT mark stale when the current SHA-256 matches the baseHash", async () => {
    const row: FeedRow = {
      id: "d:3",
      seq: 1,
      runId: "run-1",
      kind: "diff",
      files: [{ path: "a.ts", adds: 1, dels: 0, diff: "@@\n+x", baseHash: "same" }],
      decision: "pending",
    };
    const { queryByText } = render(
      <RowActionsProvider
        actions={{ probeFile: async () => ({ exists: true, sha256: "same" }) }}
      >
        {renderRow(row)}
      </RowActionsProvider>,
    );
    await waitFor(() => expect(queryByText("Accept")).toBeTruthy());
    expect(queryByText("Regenerate")).toBeNull();
  });
});

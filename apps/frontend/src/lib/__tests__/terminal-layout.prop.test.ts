import { test, expect } from "vitest";
import fc from "fast-check";
import {
  closePane,
  focusAdjacent,
  leaves,
  paneCount,
  splitPane,
  type LayoutState,
  type PaneNode,
  type TerminalPane,
} from "../terminal-layout";

function pane(i: number): TerminalPane {
  return { kind: "pane", id: `p${i}`, sessionId: `s${i}` };
}

/** Left-leaning tree with leaves p0..p(n-1) in in-order. */
function buildTree(n: number): PaneNode {
  let node: PaneNode = pane(0);
  for (let i = 1; i < n; i += 1) {
    node = {
      kind: "split",
      id: `sp${i}`,
      direction: i % 2 ? "row" : "column",
      a: node,
      b: pane(i),
    };
  }
  return node;
}

// Feature: advanced-terminal, Property 1: Split grows by one leaf, bounded
test("splitPane adds one leaf under MAX_PANES and is a no-op at the cap", () => {
  fc.assert(
    fc.property(fc.integer({ min: 1, max: 3 }), fc.nat(), (n, kRaw) => {
      const layout = buildTree(n);
      const state = { layout, focusedPaneId: `p${kRaw % n}` };
      const result = splitPane(state, "row", pane(99));
      expect(paneCount(result.layout)).toBe(n + 1);
      const sessions = new Set(leaves(result.layout).map((l) => l.sessionId));
      for (let i = 0; i < n; i += 1) expect(sessions.has(`s${i}`)).toBe(true);
      expect(sessions.has("s99")).toBe(true);
      expect(result.focusedPaneId).toBe("p99");
    }),
    { numRuns: 200 },
  );
});

test("splitPane at MAX_PANES is a no-op", () => {
  const state = { layout: buildTree(4), focusedPaneId: "p0" };
  expect(splitPane(state, "row", pane(99))).toBe(state);
});

// Feature: advanced-terminal, Property 2: Close removes the pane and lifts the sibling
test("closePane removes exactly the pane; closing the sole leaf empties the layout", () => {
  fc.assert(
    fc.property(fc.integer({ min: 2, max: 4 }), fc.nat(), (n, kRaw) => {
      const k = kRaw % n;
      const result = closePane({ layout: buildTree(n), focusedPaneId: `p${k}` }, `p${k}`);
      const ids = leaves(result.layout).map((l) => l.id);
      const expected = Array.from({ length: n }, (_, i) => `p${i}`).filter((id) => id !== `p${k}`);
      expect(new Set(ids)).toEqual(new Set(expected));
      expect(ids).toHaveLength(n - 1);
    }),
    { numRuns: 200 },
  );
  expect(closePane({ layout: pane(0), focusedPaneId: "p0" }, "p0").layout).toBeNull();
});

// Feature: advanced-terminal, Property 3: Focus navigation is a stable wrap-around cycle
test("focusAdjacent cycles through every leaf and wraps", () => {
  fc.assert(
    fc.property(fc.integer({ min: 1, max: 4 }), (n) => {
      const layout = buildTree(n);
      let state: LayoutState = { layout, focusedPaneId: "p0" };
      const visited: Array<string | null> = [];
      for (let i = 0; i < n; i += 1) {
        state = focusAdjacent(state, 1);
        visited.push(state.focusedPaneId);
      }
      expect(state.focusedPaneId).toBe("p0"); // wrapped back after paneCount steps
      expect(new Set(visited)).toEqual(new Set(leaves(layout).map((l) => l.id)));
      // -1 is the inverse of +1.
      const back = focusAdjacent(focusAdjacent({ layout, focusedPaneId: "p0" }, -1), 1);
      expect(back.focusedPaneId).toBe("p0");
    }),
    { numRuns: 100 },
  );
});

// Feature: advanced-terminal, Property 4: Operations are pure
test("splitPane does not mutate the input layout", () => {
  fc.assert(
    fc.property(fc.integer({ min: 1, max: 3 }), fc.nat(), (n, kRaw) => {
      const layout = buildTree(n);
      const before = JSON.stringify(layout);
      const beforeCount = paneCount(layout);
      splitPane({ layout, focusedPaneId: `p${kRaw % n}` }, "row", pane(99));
      expect(JSON.stringify(layout)).toBe(before);
      expect(paneCount(layout)).toBe(beforeCount);
    }),
    { numRuns: 200 },
  );
});

/**
 * Terminal pane-tree layout algebra (Part 6.1, pure/dependency-free).
 *
 * The layout is a binary tree of `SplitNode`s and `TerminalPane` leaves (each
 * leaf bound to one PTY session). Every operation is a pure function of
 * `(layout, focusedPaneId)` returning a new layout — no in-place mutation — so
 * the store slice and the react-resizable-panels renderer sit on top of a
 * verified core.
 */
export interface TerminalPane {
  kind: "pane";
  id: string;
  sessionId: string;
}

export interface SplitNode {
  kind: "split";
  id: string;
  direction: "row" | "column";
  a: PaneNode;
  b: PaneNode;
}

export type PaneNode = SplitNode | TerminalPane;

export const MAX_PANES = 4;

export interface LayoutState {
  layout: PaneNode | null;
  focusedPaneId: string | null;
}

/** In-order (left-to-right) list of pane leaves. */
export function leaves(node: PaneNode | null): TerminalPane[] {
  if (node === null) return [];
  if (node.kind === "pane") return [node];
  return [...leaves(node.a), ...leaves(node.b)];
}

export function paneCount(node: PaneNode | null): number {
  return leaves(node).length;
}

/**
 * Split the focused leaf into `SplitNode{direction, a: focusedLeaf, b: newPane}`
 * and focus the new pane. No-op (returns the same state) at `MAX_PANES` or when
 * the focus is not found. Splitting an empty layout just adopts `newPane`.
 */
export function splitPane(
  state: LayoutState,
  direction: "row" | "column",
  newPane: TerminalPane,
  splitId?: string,
): LayoutState {
  const { layout, focusedPaneId } = state;
  if (layout === null || focusedPaneId === null) {
    return { layout: newPane, focusedPaneId: newPane.id };
  }
  if (paneCount(layout) >= MAX_PANES) return state; // bounded
  const id = splitId ?? `split-${focusedPaneId}-${newPane.id}`;
  let found = false;
  const replace = (node: PaneNode): PaneNode => {
    if (node.kind === "pane") {
      if (node.id === focusedPaneId) {
        found = true;
        return { kind: "split", id, direction, a: node, b: newPane };
      }
      return node;
    }
    return { ...node, a: replace(node.a), b: replace(node.b) };
  };
  const next = replace(layout);
  if (!found) return state;
  return { layout: next, focusedPaneId: newPane.id };
}

function removeLeaf(node: PaneNode, paneId: string): PaneNode | null {
  if (node.kind === "pane") return node.id === paneId ? null : node;
  const a = removeLeaf(node.a, paneId);
  const b = removeLeaf(node.b, paneId);
  if (a === node.a && b === node.b) return node; // not in this subtree
  if (a === null) return b; // sibling lifted into the parent's slot
  if (b === null) return a;
  return { ...node, a, b };
}

/**
 * Remove a pane; its sibling subtree is lifted into the parent split's slot.
 * Closing the sole leaf yields an empty layout. Focus moves to the first
 * remaining leaf when the closed pane was focused.
 */
export function closePane(state: LayoutState, paneId: string): LayoutState {
  const { layout, focusedPaneId } = state;
  if (layout === null) return state;
  const next = removeLeaf(layout, paneId);
  if (next === layout) return state; // not found
  const remaining = leaves(next);
  const focus =
    focusedPaneId !== null && remaining.some((l) => l.id === focusedPaneId)
      ? focusedPaneId
      : (remaining[0]?.id ?? null);
  return { layout: next, focusedPaneId: focus };
}

/** Move focus by `delta` across the in-order leaves, wrapping around. */
export function focusAdjacent(state: LayoutState, delta: number): LayoutState {
  const list = leaves(state.layout);
  if (list.length === 0) return state;
  const idx = list.findIndex((l) => l.id === state.focusedPaneId);
  const base = idx === -1 ? 0 : idx;
  const next = (((base + delta) % list.length) + list.length) % list.length;
  return { ...state, focusedPaneId: list[next].id };
}

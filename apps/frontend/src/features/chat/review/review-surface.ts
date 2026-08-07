/**
 * The review surface's context — zoc-agent-chat-rebuild R8.1, R10.x, task 18.2.
 *
 * Feature: zoc-agent-chat-rebuild, task 18.2 (R8.1).
 *
 * A plan card needs five things the transcript's row model does not carry: the on-disk digests for the
 * staleness check, the receipt for a plan that has already been applied, and the apply, discard,
 * regenerate, and rollback handlers. They reach the card through a context rather than through row
 * props, and the reason is R8.1 rather than convenience.
 *
 * ## Why not props
 *
 * Row slots are memoised so a text delta cannot re-render a settled row (Property 6). A prop bundle
 * threaded from the panel would be a new object on every render of the panel, so every mounted row's
 * props would compare unequal on every delta and the memo would do nothing. Passing the bundle through
 * context inverts that: the memo compares only `{ row }`, and a change to the bundle re-renders exactly
 * the components that *read* it — the plan and diff rows — which is the correct behaviour when a receipt
 * arrives or a digest changes.
 *
 * ## Why the default is inert rather than absent
 *
 * A plan rendered outside a provider — in a story, in a property test, in the row-level tests — should
 * draw its review and offer no apply. An empty object gives exactly that: `applicableHunks` still
 * computes, the footer still counts, and every control whose handler is absent is absent rather than
 * dead (the panel's rule for disabled controls).
 */

import { createContext, useContext } from "react";

import type { ApplyReceipt } from "./apply-receipt";
import type { ApplySelection } from "./hunk-selection";

export interface ReviewSurface {
  /**
   * path → the file's current digest on disk (R10.8).
   *
   * Supplied by the panel, which is the only thing that can watch the tree. Absent means "not
   * measured", which `isStale` treats as not stale — a surface that has not read digests must not
   * block every apply.
   */
  readonly onDisk?: ReadonlyMap<string, string>;
  /** The receipt for a plan that has been applied, or `null`/`undefined` while it is still a review. */
  readonly receiptOf?: (planId: string) => ApplyReceipt | null | undefined;
  /**
   * R1.4: the viewer decides nothing, so every decision control is **omitted**.
   *
   * Withholding the four handlers is not enough on its own. A hunk decision writes to the chat-local
   * store rather than through a handler, so accept and reject would still render and still toggle; and
   * apply renders `disabled` with a reason rather than absent, because for a host that state is
   * informative — "two hunks are stale" is the answer to why the button will not go. For a viewer it is
   * an invitation to press something that can never work, which is the thing R1.4 forbids. So read-only
   * travels with the surface and the controls read it, the same way `locked` already suppresses a
   * decided file's controls.
   */
  readonly readOnly?: boolean;
  onApply?: (selection: ApplySelection) => void;
  onDiscard?: (planId: string) => void;
  onRegenerate?: (planId: string, path: string) => void;
  onRollback?: (checkpointId: string) => void;
}

export const ReviewSurfaceContext = createContext<ReviewSurface>({});

/** The review surface in scope. Read only by the rows that need it, never by the row slot. */
export function useReviewSurface(): ReviewSurface {
  return useContext(ReviewSurfaceContext);
}

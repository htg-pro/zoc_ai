/**
 * The approval dock — zoc-agent-chat-rebuild R11.8, R21.3, task 19.1.
 *
 * The pending request, pinned above the composer and **outside** the transcript's scroll container.
 * That placement is the whole requirement: R11.8 says a pending approval must stay visible without
 * scroll-away, and the only way to guarantee it is for the request not to be in the scrolling region at
 * all. Property 18 asserts it by scrolling the transcript to every extreme and finding the dock still
 * there.
 *
 * ## One surface, and the transcript defers to it
 *
 * The legacy panel could show two approval cards for one call — a `needs_approval` tool card and a
 * separate `ApprovalRow` — so the thing blocking progress was indistinguishable from the thing
 * describing it. Here the transcript's `permission` row is a muted line that *links* here, and this is
 * the only place a decision can be made. Ember is used here and nowhere else (R17.2).
 *
 * ## Focus moves once per request, and the store is what makes "once" true
 *
 * R21.3 requires focus to move to the request when it appears. Re-focusing on every render would trap a
 * user who tabbed away to read the diff the request is about, so the dock records the id it has focused
 * in `pendingApprovalId` and moves focus only when the id changes. That is also why the flag lives in
 * the store rather than in a ref: a Session switch has to forget it, and `resetForSession` already does.
 *
 * Focus lands on the **row**, not on this wrapper. The row is the request — it carries the accessible
 * name R21.3 asks for — and a `keydown` bubbles up, so keys pressed with focus on an ancestor would
 * never reach the row's own `A`/`R` handling.
 *
 * ## Why the dock owns the decision call rather than the panel
 *
 * The decision is `POST /v1/runs/:id/approvals`, and the outcome the user needs to see — already
 * decided, or expired — is about *this* request. Handing the panel a callback and letting it report
 * elsewhere would put the answer to "did my click land" somewhere other than the thing clicked.
 */
import { useEffect, useRef, useState } from "react";
import { m } from "motion/react";

import { resolveMotionVariant, useMotionBudgetProps, useReducedMotion } from "@/lib/reduced-motion";
import { cn } from "@/lib/utils";
import { PERMISSION_DOCK_ID, focusRequest } from "./dock-handle";
import { PermissionRow } from "./PermissionRow";
import { pendingRequestOf, type ApprovalScope } from "./permission-model";
import { useChatSurface } from "../store";
import type { ZocUIMessage } from "../wire/ui-message";

/** The entrance the design gives the dock: 240 ms, opacity and an 8 px rise. */
const ENTRANCE_VARIANT = "dock-entrance" as const;

export interface PermissionDockProps {
  /** `useChat`'s messages. The pending request is derived from them, never copied. */
  messages: readonly ZocUIMessage[];
  /**
   * Send the decision. Resolves when the runtime has accepted it, rejects with a message the dock
   * renders — an already-decided or expired request is something the user has to be told about.
   */
  onDecide: (decision: {
    requestId: string;
    decision: "approve" | "reject";
    scope: ApprovalScope;
  }) => Promise<void>;
  /** Injected for the countdown's determinism in tests. */
  now?: () => number;
  className?: string;
}

export function PermissionDock({ messages, onDecide, now = Date.now, className }: PermissionDockProps) {
  const pendingApprovalId = useChatSurface((state) => state.pendingApprovalId);
  const setPendingApprovalId = useChatSurface((state) => state.setPendingApprovalId);
  const reducedMotion = useReducedMotion();
  const budgetProps = useMotionBudgetProps();

  const containerRef = useRef<HTMLElement | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  /** Ids the countdown has seen expire, so a request the runtime has not yet retracted stops asking. */
  const [expired, setExpired] = useState<ReadonlySet<string>>(() => new Set());

  // Derived on every render rather than memoised on `messages`: the array's identity changes on every
  // delta anyway, and the scan is over parts a Session already holds.
  const request = pendingRequestOf(messages, now());
  const visible = request !== null && !expired.has(request.requestId);

  useEffect(() => {
    if (!visible || request === null) return;
    // Once per request, not once per render: a user who tabbed into the transcript to read the diff the
    // request is about must not be yanked back on the next delta.
    if (pendingApprovalId === request.requestId) return;
    setPendingApprovalId(request.requestId);
    setFailure(null);
    focusRequest(containerRef.current);
  }, [visible, request, pendingApprovalId, setPendingApprovalId]);

  useEffect(() => {
    // The request is gone — decided, retracted, or timed out. Clearing the id is what lets a *later*
    // request with a different id take focus again.
    if (!visible && pendingApprovalId !== null) setPendingApprovalId(null);
  }, [visible, pendingApprovalId, setPendingApprovalId]);

  if (!visible || request === null) return null;

  const decide = (decision: "approve" | "reject", scope: ApprovalScope) => {
    setSending(true);
    setFailure(null);
    void onDecide({ requestId: request.requestId, decision, scope })
      .catch((error: unknown) => {
        setFailure(
          error instanceof Error
            ? error.message
            : "The decision could not be sent. The run may have already moved on.",
        );
      })
      .finally(() => {
        setSending(false);
      });
  };

  const entrance = resolveMotionVariant(ENTRANCE_VARIANT, reducedMotion);

  return (
    <m.section
      ref={containerRef}
      id={PERMISSION_DOCK_ID}
      data-zoc-permission-dock=""
      // Placement only: the semantics — the group role and the accessible name — belong to the row,
      // which is the request. A second labelled group here would announce the same subject twice.
      className={cn("flex flex-col px-4 pb-2", className)}
      style={{ gap: "var(--zoc-row-gap-tight)" }}
      {...entrance}
      {...budgetProps}
    >
      <PermissionRow
        request={request}
        now={now}
        onApprove={(scope) => {
          if (!sending) decide("approve", scope);
        }}
        onReject={() => {
          if (!sending) decide("reject", "call");
        }}
        onExpired={() => {
          setExpired((current) => new Set(current).add(request.requestId));
        }}
      />
      {failure === null ? null : (
        <span
          data-zoc-permission-failure=""
          // Assertive, unlike the countdown: this is the answer to "did my click land", and it arrives
          // exactly once.
          aria-live="assertive"
          style={{ color: "var(--zoc-error)", fontSize: "var(--zoc-text-label)" }}
        >
          {failure}
        </span>
      )}
    </m.section>
  );
}

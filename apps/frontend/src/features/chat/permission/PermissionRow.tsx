/**
 * One pending approval — zoc-agent-chat-rebuild R11.7, R11.8, R11.9, R21.3, task 19.1.
 *
 * The request, the scope chips, the countdown, and the two decisions. Rendered by `PermissionDock`,
 * which owns *where* it sits; this component owns what it says.
 *
 * ## The one place ember is allowed
 *
 * R17.2 narrows `--zoc-ember` to "blocked on you", and this is that. Nothing else in the panel may use
 * it — which is what makes it a signal rather than a decoration, and why the tool timeline's own
 * "waiting for approval" entry is muted and links here instead of repeating the colour.
 *
 * ## The row *is* the request, which is why focus lands here
 *
 * R21.3 says focus moves to the request. The row carries the accessible name and `tabIndex={-1}`, and
 * the dock focuses it — the dock owns *where* the request sits, not what it is. Putting focus on the
 * dock instead would also break the keyboard model below: a `keydown` bubbles *up*, so a handler on this
 * row never sees a key pressed while focus is on an ancestor.
 *
 * ## Keyboard-only, and by more than one route
 *
 * R11.8 asks for keyboard-only approve and reject. Both are real buttons in the tab order, *and* `A`
 * and `R` work anywhere inside the row — including on the row itself, where focus arrives — matching the
 * hunk rows a reviewer has already learned. The scope chips are a radio group, so the arrows move
 * between them and the choice travels with `A`.
 *
 * ## Why the visible paths and the accessible name disagree
 *
 * The row is one line: a long path is middle-truncated and more than three collapse to a count. The
 * accessible name from `approvalAccessibleName` carries every path in full, because "and 4 more" is
 * exactly the information a screen-reader user is being asked to approve (R21.3).
 */
import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import { ShieldAlert } from "lucide-react";

import { cn } from "@/lib/utils";
import type { PermissionRequestPart } from "@zoc-studio/shared-types";
import { MAX_LISTED_PATHS, truncatePath } from "../timeline/tool-entry-model";
import {
  DEFAULT_SCOPE,
  REASON_LABELS,
  SCOPE_DESCRIPTIONS,
  SCOPE_LABELS,
  approvalAccessibleName,
  formatCountdown,
  offeredScopesOf,
  remainingMs,
  type ApprovalScope,
} from "./permission-model";

/** How often the countdown re-renders. One second, because it displays seconds. */
const TICK_MS = 1000;

export interface PermissionRowProps {
  request: PermissionRequestPart;
  /** Injected so the countdown is testable without waiting ten minutes. */
  now?: () => number;
  onApprove: (scope: ApprovalScope) => void;
  onReject: () => void;
  /** Reported when the visible countdown reaches zero, so the dock can stop rendering the row. */
  onExpired?: () => void;
  className?: string;
}

export function PermissionRow({
  request,
  now = Date.now,
  onApprove,
  onReject,
  onExpired,
  className,
}: PermissionRowProps) {
  const scopes = offeredScopesOf(request);
  const [scope, setScope] = useState<ApprovalScope>(scopes[0] ?? DEFAULT_SCOPE);
  const [remaining, setRemaining] = useState(() => remainingMs(request, now()));
  const expiredRef = useRef(false);

  // The countdown is state rather than a derived render, because nothing else re-renders this row for
  // ten minutes: the part does not change while the request is pending.
  useEffect(() => {
    expiredRef.current = false;
    setRemaining(remainingMs(request, now()));
    const timer = setInterval(() => {
      const left = remainingMs(request, now());
      setRemaining(left);
      if (left === 0 && !expiredRef.current) {
        expiredRef.current = true;
        onExpired?.();
      }
    }, TICK_MS);
    return () => {
      clearInterval(timer);
    };
  }, [request, now, onExpired]);

  const listed = request.paths.slice(0, MAX_LISTED_PATHS);
  const overflow = request.paths.length - listed.length;

  const handleKeyDown = (event: KeyboardEvent<HTMLElement>) => {
    if (event.defaultPrevented || event.metaKey || event.ctrlKey || event.altKey) return;
    switch (event.key) {
      case "a":
      case "A":
        event.preventDefault();
        onApprove(scope);
        return;
      case "r":
      case "R":
        event.preventDefault();
        onReject();
        return;
      default:
        return;
    }
  };

  return (
    <div
      className={cn("flex flex-col rounded-[var(--zoc-radius-card)] border p-2", className)}
      data-zoc-permission-row={request.requestId}
      data-zoc-permission-reason={request.reason}
      // A group rather than a dialog: a dialog traps focus, and R8.7 keeps the composer usable while a
      // Run streams — including while it is blocked on this.
      role="group"
      aria-label={approvalAccessibleName(request)}
      // Focusable programmatically but not by tab: focus arrives once, on appearance, and the tab order
      // then continues into the controls inside.
      tabIndex={-1}
      onKeyDown={handleKeyDown}
      style={{
        backgroundColor: "var(--zoc-elev-2)",
        borderColor: "var(--zoc-ember)",
        gap: "var(--zoc-row-gap-tight)",
      }}
    >
      <div className="flex flex-wrap items-baseline gap-2">
        <ShieldAlert
          aria-hidden
          className="size-3.5 shrink-0 self-center"
          style={{ color: "var(--zoc-ember)" }}
        />
        <span
          data-zoc-permission-prompt=""
          style={{ color: "var(--zoc-text)", fontSize: "var(--zoc-text-body)" }}
        >
          {request.prompt}
        </span>
        <span
          className="font-mono"
          data-zoc-permission-tool={request.toolName}
          style={{ color: "var(--zoc-text-secondary)", fontSize: "var(--zoc-text-meta)" }}
        >
          {request.toolName}
        </span>
        <span
          data-zoc-permission-reason-label=""
          style={{ color: "var(--zoc-text-muted)", fontSize: "var(--zoc-text-label)" }}
        >
          {REASON_LABELS[request.reason]}
        </span>
      </div>

      {request.paths.length === 0 ? null : (
        <div className="flex flex-wrap items-baseline gap-1.5" data-zoc-permission-paths="">
          {listed.map((path) => (
            <span
              key={path}
              className="font-mono"
              data-zoc-permission-path={path}
              title={path}
              style={{ color: "var(--zoc-text-secondary)", fontSize: "var(--zoc-text-meta)" }}
            >
              {truncatePath(path)}
            </span>
          ))}
          {overflow > 0 ? (
            <span
              data-zoc-permission-path-overflow={String(overflow)}
              style={{ color: "var(--zoc-text-muted)", fontSize: "var(--zoc-text-label)" }}
            >
              +{overflow} more
            </span>
          ) : null}
        </div>
      )}

      <div className="flex flex-wrap items-center gap-2">
        {/*
          A radio group rather than three buttons: the three scopes are mutually exclusive, and the
          arrow-key model a radio group gives for free is the one R11.8 needs.
        */}
        <div
          role="radiogroup"
          aria-label="Grant scope"
          className="flex flex-wrap items-center gap-1"
          data-zoc-permission-scopes=""
        >
          {scopes.map((offered) => (
            <button
              key={offered}
              type="button"
              role="radio"
              aria-checked={scope === offered}
              aria-label={`${SCOPE_LABELS[offered]}. ${SCOPE_DESCRIPTIONS[offered]}`}
              data-zoc-permission-scope={offered}
              onClick={() => {
                setScope(offered);
              }}
              className={cn(
                "rounded-[var(--zoc-radius-chip)] border px-1.5 py-0.5",
                "focus-visible:outline-none focus-visible:ring-2",
                "focus-visible:ring-[color:var(--zoc-agent-strong)]",
              )}
              style={{
                borderColor: scope === offered ? "var(--zoc-ember)" : "var(--zoc-border)",
                color: scope === offered ? "var(--zoc-text)" : "var(--zoc-text-muted)",
                fontSize: "var(--zoc-text-label)",
              }}
            >
              {SCOPE_LABELS[offered]}
            </button>
          ))}
        </div>

        <span className="flex-1" />

        <span
          className="tabular-nums"
          data-zoc-permission-countdown=""
          // Polite rather than assertive: the number changes every second, and an assertive region
          // would interrupt a screen reader mid-sentence sixty times a minute.
          aria-live="polite"
          aria-atomic="true"
          style={{ color: "var(--zoc-text-muted)", fontSize: "var(--zoc-text-label)" }}
        >
          {formatCountdown(remaining)}
        </span>

        <button
          type="button"
          data-zoc-permission-reject=""
          onClick={onReject}
          className="rounded-[var(--zoc-radius-chip)] px-2 py-0.5 hover:bg-[var(--zoc-row-bg)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[color:var(--zoc-agent-strong)]"
          style={{ color: "var(--zoc-text-muted)", fontSize: "var(--zoc-text-label)" }}
        >
          Reject
        </button>
        <button
          type="button"
          data-zoc-permission-approve=""
          onClick={() => {
            onApprove(scope);
          }}
          className="rounded-[var(--zoc-radius-chip)] border px-2 py-0.5 hover:bg-[var(--zoc-elev-1)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[color:var(--zoc-agent-strong)]"
          style={{
            borderColor: "var(--zoc-ember)",
            color: "var(--zoc-text)",
            fontSize: "var(--zoc-text-label)",
          }}
        >
          Approve
        </button>
      </div>

    </div>
  );
}

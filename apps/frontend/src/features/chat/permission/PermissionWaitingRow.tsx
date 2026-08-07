/**
 * The transcript's line for an approval — zoc-agent-chat-rebuild R11.8, R11.9, task 19.1.
 *
 * Feature: zoc-agent-chat-rebuild, task 19.1 (R11.8, R11.9).
 *
 * One muted line at the position the request arrived in, and a control that moves focus to the dock.
 * While the request is pending it says so; once decided it says what was decided, so a transcript read
 * later records the decision rather than a question that appears never to have been answered.
 *
 * ## Why this fills the `permission` row rather than the tool timeline's entry
 *
 * The design puts the "waiting for approval" state on the *timeline entry* for the gated call. That
 * would need a sixth `ToolEntryState`, and the five are pinned by three properties — the node shape per
 * kind and state (45), the entry's accessible name (46), and the activity palette. The approval is
 * already its own part with its own position in the transcript, and 17.1 left the `permission` arm for
 * this task to fill by name, so the line lands there instead. What a user sees is the same: a muted line
 * in the activity area, at the right position, linking to the one place the decision can be made.
 *
 * The tool entry for the call stays `running`, which is true — a call awaiting approval has not
 * finished — and it is the reading that does not need a new state to mean "in flight for a reason".
 *
 * ## No ember here
 *
 * R17.2 reserves ember for the dock. A second ember treatment in the transcript is exactly the
 * duplicate-approval-surface problem the dock exists to end, so this line is muted even though it is
 * about the same blocking request.
 */
import { cn } from "@/lib/utils";
import type { PermissionRequestPart } from "@zoc-studio/shared-types";
import { PERMISSION_DOCK_ID, focusRequest } from "./dock-handle";
import { SCOPE_LABELS, isPending } from "./permission-model";

/** What the line says once a decision has landed. */
function outcomeOf(request: PermissionRequestPart): string {
  switch (request.decision) {
    case "approve": {
      const scope = request.decidedScope;
      return scope == null
        ? `approved ${request.toolName}`
        : `approved ${request.toolName} — ${SCOPE_LABELS[scope].toLowerCase()}`;
    }
    case "reject":
      return `rejected ${request.toolName}`;
    case "timeout":
      // R11.9: the runtime cancelled the call. Phrased as what happened to the *call*, because that is
      // the consequence the reader cares about.
      return `${request.toolName} was cancelled — no decision within ten minutes`;
    default:
      return `waiting for approval — ${request.toolName}`;
  }
}

export interface PermissionWaitingRowProps {
  request: PermissionRequestPart;
  className?: string;
}

export function PermissionWaitingRow({ request, className }: PermissionWaitingRowProps) {
  const pending = isPending(request);

  return (
    <div
      className={cn("flex flex-wrap items-baseline gap-2 pl-5", className)}
      data-zoc-row="permission"
      data-zoc-permission-state={pending ? "pending" : (request.decision ?? "pending")}
      style={{ fontSize: "var(--zoc-text-meta)", lineHeight: "var(--zoc-leading-meta)" }}
    >
      <span data-zoc-permission-line="" style={{ color: "var(--zoc-text-muted)" }}>
        {outcomeOf(request)}
      </span>
      {pending ? (
        <button
          type="button"
          data-zoc-permission-focus-dock=""
          aria-controls={PERMISSION_DOCK_ID}
          onClick={() => {
            // Focus rather than scroll: the dock is outside the transcript's scroll container by
            // construction (R11.8), so there is nothing to scroll it into view. The target is the
            // request itself, which is what carries the accessible name (R21.3).
            focusRequest(document.getElementById(PERMISSION_DOCK_ID));
          }}
          className="rounded-[var(--zoc-radius-chip)] px-1 py-0.5 underline decoration-dotted hover:bg-[var(--zoc-row-bg)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[color:var(--zoc-agent-strong)]"
          style={{ color: "var(--zoc-text-secondary)", fontSize: "var(--zoc-text-label)" }}
        >
          Review
        </button>
      ) : null}
    </div>
  );
}

/**
 * The runtime-unavailable banner — zoc-agent-chat-rebuild R3.8, task 22.8.
 *
 * Feature: zoc-agent-chat-rebuild, task 22.8 (R3.8).
 *
 * The Agent_Runtime did not come up, or came up and died. R3.8 asks for the reason and a retry, and this
 * sits **above a still-rendered transcript** rather than replacing it: the Session's history is on disk
 * and unaffected by a supervisor failure, so blanking it would hide readable content to report a problem
 * with something else.
 *
 * ## Why the reason is shown verbatim and is path-free by construction
 *
 * `RuntimeUnavailableError`'s message is assembled from the supervisor's `last_error` and never carries a
 * filesystem path or a credential — that is a property of `secret_backend_status` and
 * `agent_runtime_status`, both of which return a reason string chosen for display. So the string is
 * rendered rather than mapped through a table of friendlier equivalents, which would drop the one detail
 * ("the runtime crashed during startup" versus "did not pass /health") that says what to do next.
 */
import { RefreshCw, ServerCrash } from "lucide-react";

import { cn } from "@/lib/utils";

export interface RuntimeUnavailableBannerProps {
  /** The supervisor's reason, already path-free and secret-free. */
  reason: string;
  /** Re-runs the supervisor handshake. Absent for a read-only viewer, which cannot restart a host. */
  onRestart?: () => void;
  /** True while a restart is in flight, so the control cannot be pressed twice. */
  restarting?: boolean;
  className?: string;
}

export function RuntimeUnavailableBanner({
  reason,
  onRestart,
  restarting = false,
  className,
}: RuntimeUnavailableBannerProps) {
  return (
    <div
      role="alert"
      data-zoc-runtime-banner=""
      className={cn("flex shrink-0 items-start gap-2 border-b px-3 py-2", className)}
      style={{
        backgroundColor: "var(--zoc-elev-1)",
        borderColor: "var(--zoc-error)",
        borderBottomWidth: "1px",
      }}
    >
      <ServerCrash
        aria-hidden
        className="size-3.5 shrink-0 translate-y-[0.1em]"
        style={{ color: "var(--zoc-error)" }}
      />
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span
          data-zoc-runtime-banner-title=""
          style={{ color: "var(--zoc-text)", fontSize: "var(--zoc-text-label)" }}
        >
          The agent runtime is not running. The transcript below is what was saved.
        </span>
        <span
          data-zoc-runtime-banner-reason=""
          className="break-words"
          style={{ color: "var(--zoc-text-muted)", fontSize: "var(--zoc-text-meta)" }}
        >
          {reason}
        </span>
      </div>
      {onRestart === undefined ? null : (
        <button
          type="button"
          data-zoc-runtime-restart=""
          disabled={restarting}
          onClick={onRestart}
          className="inline-flex shrink-0 items-center gap-1 rounded-[var(--zoc-radius-chip)] border px-2 py-1 hover:bg-[var(--zoc-row-bg)] disabled:opacity-60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[color:var(--zoc-agent-strong)]"
          style={{
            borderColor: "var(--zoc-border)",
            color: "var(--zoc-text-secondary)",
            fontSize: "var(--zoc-text-label)",
          }}
        >
          <RefreshCw aria-hidden className={cn("size-3", restarting && "animate-spin")} />
          {restarting ? "Restarting" : "Restart"}
        </button>
      )}
    </div>
  );
}

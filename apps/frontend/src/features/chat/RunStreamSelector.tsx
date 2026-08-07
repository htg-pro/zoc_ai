/** Selectable concurrent Run strip — zoc-agent-chat-rebuild R25.2, R25.4. */
/** Feature: zoc-agent-chat-rebuild, task 29.2 (R25.2, R25.4). */
import { CircleDot, Loader2 } from "lucide-react";

import { cn } from "@/lib/utils";
import type { RunStream } from "./run-streams";

export interface RunStreamSelectorProps {
  readonly streams: readonly RunStream[];
  readonly focusedRunId: string | null;
  readonly onFocus: (runId: string) => void;
  readonly className?: string;
}

function statusOf(stream: RunStream): string {
  if (stream.state === "queued" && stream.queuePosition !== null) {
    return `Queued · position ${String(stream.queuePosition)}`;
  }
  switch (stream.state) {
    case "awaiting-approval":
      return "Waiting for you";
    case "completed":
      return "Done";
    case "cancelled":
      return "Cancelled";
    case "failed":
      return "Failed";
    case "interrupted":
      return "Interrupted";
    case "queued":
      return "Queued";
    case "running":
      return "Running";
  }
}

export function RunStreamSelector({
  streams,
  focusedRunId,
  onFocus,
  className,
}: RunStreamSelectorProps) {
  if (streams.length < 2) return null;

  return (
    <div
      role="tablist"
      aria-label="Concurrent runs"
      data-zoc-run-streams=""
      className={cn("flex shrink-0 gap-1 overflow-x-auto border-b px-4 py-2", className)}
      style={{ borderColor: "var(--zoc-border)", backgroundColor: "var(--zoc-elev-1)" }}
    >
      {streams.map((stream) => {
        const focused = stream.runId === focusedRunId;
        const Glyph = stream.active ? Loader2 : CircleDot;
        return (
          <button
            key={stream.runId}
            type="button"
            role="tab"
            aria-selected={focused}
            aria-controls={`zoc-run-stream-${stream.runId}`}
            data-zoc-run-stream={stream.runId}
            data-zoc-run-state={stream.state}
            data-zoc-composer-focus={String(focused)}
            onClick={() => onFocus(stream.runId)}
            className={cn(
              "flex min-w-40 max-w-64 shrink-0 items-center gap-2 rounded-[var(--zoc-radius-chip)] border px-2.5 py-1.5 text-left",
              "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[color:var(--zoc-agent-strong)]",
            )}
            style={{
              borderColor: focused ? "var(--zoc-agent-strong)" : "var(--zoc-border)",
              backgroundColor: focused ? "var(--zoc-agent-soft)" : "var(--zoc-elev-2)",
            }}
          >
            <Glyph
              aria-hidden
              className={cn("size-3 shrink-0", stream.active && "animate-spin")}
              style={{ color: stream.active ? "var(--zoc-agent)" : "var(--zoc-text-muted)" }}
            />
            <span className="min-w-0 flex-1">
              <span
                className="block truncate"
                style={{ color: "var(--zoc-text)", fontSize: "var(--zoc-text-meta)" }}
              >
                {stream.title}
              </span>
              <span
                className="block truncate"
                data-zoc-run-stream-status=""
                style={{ color: "var(--zoc-text-muted)", fontSize: "var(--zoc-text-label)" }}
              >
                {statusOf(stream)}
                {stream.agentNames.length > 0
                  ? ` · ${stream.agentNames.join(", ")}`
                  : focused
                    ? " · Composer focus"
                    : ""}
              </span>
            </span>
          </button>
        );
      })}
    </div>
  );
}

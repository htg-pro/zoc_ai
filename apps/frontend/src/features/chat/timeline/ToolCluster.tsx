/**
 * A cluster of consecutive same-tool calls — zoc-agent-chat-rebuild R9.5, R9.7, R21.4.
 *
 * Feature: zoc-agent-chat-rebuild, R9.5, R9.7, R21.4.
 *
 * One `<li>` reading `4 × workspace_read`, expanding to its members as ordinary entries. The
 * grouping itself is `groupTimeline`'s; this is the row.
 *
 * **The count is the run length, not a badge.** R9.5's threshold fires at the fourth
 * consecutive call, and the number the row shows is exactly how many calls it stands for — so a
 * reader can add the visible counts and get the run's real tool total. A rounded or capped count
 * would make the timeline lie about how much work happened.
 *
 * **A cluster whose members are still arriving increments live.** Nothing here does that: the
 * count is a prop, and the transcript re-renders the cluster as members arrive, which is the
 * same mechanism every other row uses. Worth stating because "count increments live" in the
 * design's table reads like it needs machinery.
 */
import { ChevronRight } from "lucide-react";

import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { cn } from "@/lib/utils";
import { ToolEntry } from "./ToolEntry";
import { ToolNode } from "./ToolNode";
import { formatDuration, stateLabelOf, type TimelineItem } from "./tool-entry-model";

export type ClusterItem = Extract<TimelineItem, { kind: "cluster" }>;

export interface ToolClusterProps {
  cluster: ClusterItem;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  /** Which member ids are expanded, so a member's own detail survives a cluster collapse. */
  expandedMembers?: ReadonlySet<string>;
  onMemberOpenChange?: (toolCallId: string, open: boolean) => void;
  onRetry?: (toolCallId: string) => void;
  className?: string;
}

export function ToolCluster({
  cluster,
  open = false,
  onOpenChange,
  expandedMembers,
  onMemberOpenChange,
  onRetry,
  className,
}: ToolClusterProps) {
  return (
    <li
      className={cn("flex flex-col", className)}
      role="listitem"
      style={{ gap: "var(--zoc-row-gap-tight)" }}
      data-zoc-tool-cluster={cluster.toolName}
      data-zoc-cluster-count={String(cluster.count)}
      // The same three facts an entry's name carries, phrased for a group. `N calls` rather than
      // a bare number, because "4, succeeded, 1.2s" gives a screen-reader user no clue that the
      // row stands for more than one call.
      aria-label={`${String(cluster.count)} calls to ${cluster.toolName}, ${stateLabelOf(
        cluster.state,
      )}, ${formatDuration(cluster.durationMs)}`}
    >
      <Collapsible open={open} onOpenChange={onOpenChange}>
        <CollapsibleTrigger
          className="flex w-full items-center gap-2 rounded-[var(--zoc-radius-chip)] px-1 py-0.5 text-left hover:bg-[var(--zoc-row-bg)]"
          data-zoc-cluster-trigger=""
        >
          <ChevronRight
            aria-hidden
            className={cn(
              "size-3 shrink-0 transition-transform zoc-transition-row-expand",
              open && "rotate-90",
            )}
            style={{ color: "var(--zoc-text-faint)" }}
          />
          <ToolNode kind={cluster.toolKind} state={cluster.state} />
          <span
            className="truncate font-mono"
            data-zoc-cluster-label=""
            style={{ color: "var(--zoc-text)", fontSize: "var(--zoc-text-meta)" }}
          >
            {cluster.count} × {cluster.toolName}
          </span>
          <span className="min-w-0 flex-1" />
          <span
            className="shrink-0 font-mono uppercase"
            data-zoc-cluster-state={cluster.state}
            style={{
              color: "var(--zoc-text-faint)",
              fontSize: "var(--zoc-text-label)",
              letterSpacing: "var(--zoc-tracking-label)",
            }}
          >
            {stateLabelOf(cluster.state)}
          </span>
          <span
            className="w-14 shrink-0 text-right font-mono tabular-nums"
            data-zoc-cluster-duration=""
            style={{ color: "var(--zoc-text-faint)", fontSize: "var(--zoc-text-label)" }}
          >
            {formatDuration(cluster.durationMs)}
          </span>
        </CollapsibleTrigger>

        <CollapsibleContent data-zoc-cluster-members="">
          {/* A nested `<ol>`, not a `<div>`: the members are a list inside a list item, which is
              what a screen reader needs to report "4 items" rather than a flat run of siblings
              (R21.4). `role="list"` is restated because the element is a flex container, which
              is enough to drop the implicit role in several browsers. */}
          <ol
            className="flex flex-col border-l pl-3 pt-1"
            role="list"
            style={{ borderColor: "var(--zoc-border)" }}
          >
            {cluster.members.map((member) => (
              <ToolEntry
                key={member.toolCallId}
                entry={member}
                open={expandedMembers?.has(member.toolCallId) ?? false}
                {...(onMemberOpenChange === undefined
                  ? {}
                  : {
                      onOpenChange: (next: boolean) => onMemberOpenChange(member.toolCallId, next),
                    })}
                {...(onRetry === undefined ? {} : { onRetry })}
              />
            ))}
          </ol>
        </CollapsibleContent>
      </Collapsible>
    </li>
  );
}

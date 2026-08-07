/**
 * The tool-call timeline — zoc-agent-chat-rebuild R9.5, R9.7, R21.4, 16.1.
 *
 * Feature: zoc-agent-chat-rebuild, task 16.1 (R9.5, R9.7, R21.4).
 *
 * A semantic `<ol>` on the rail, one item per call or per cluster. It owns exactly two things:
 * the list semantics R21.4 needs, and the expansion state of its rows.
 *
 * **The rail is a border on the list, not a decorative element.** One 1 px column at
 * `--zoc-rail-inset`, drawn as the `<ol>`'s left border — so it is exactly as tall as the
 * entries it threads and cannot fall out of sync with them. An absolutely-positioned rail would
 * need its height measured, and a measured height in a streaming transcript is the thrash R20.4
 * spends four mechanisms avoiding.
 *
 * **Grouping happens in `groupTimeline`, not here.** The component maps over the result. That is
 * what lets Property 45 assert the threshold against arbitrary tool sequences without rendering
 * anything, and it is why the off-by-one that R9.5 invites is checkable.
 */
import { useCallback, useMemo, useState } from "react";

import { cn } from "@/lib/utils";
import { ToolCluster } from "./ToolCluster";
import { ToolEntry } from "./ToolEntry";
import { groupTimeline, type ToolEntryModel } from "./tool-entry-model";

export interface ToolTimelineProps {
  entries: readonly ToolEntryModel[];
  onRetry?: (toolCallId: string) => void;
  className?: string;
}

export function ToolTimeline({ entries, onRetry, className }: ToolTimelineProps) {
  // One set for entries, clusters, and cluster members alike: `toolCallId` is unique across a
  // Run, and a cluster keys on its tool name, which cannot collide with an id.
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(() => new Set());

  const toggle = useCallback((key: string, open: boolean) => {
    setExpanded((current) => {
      if (current.has(key) === open) return current;
      const next = new Set(current);
      if (open) next.add(key);
      else next.delete(key);
      return next;
    });
  }, []);

  // Memoised on the entry list because grouping walks it, and a streaming Run re-renders this
  // component on every part — R20.3's 50 ms budget does not have room for a re-group per delta.
  const items = useMemo(() => groupTimeline(entries), [entries]);

  if (items.length === 0) return null;

  return (
    <ol
      className={cn("flex flex-col border-l", className)}
      // `role="list"` on an `<ol>` reads as redundant and is not: a list container styled
      // `display: flex` loses its implicit list role in several browsers, and this one is flex so
      // the rail can thread its items. Restating the role is what keeps R21.4's "the timeline is a
      // list" true of the accessibility tree rather than only of the markup — the same reason
      // `DiffReview`, `ContextMeter`, and `MentionChips` each restate it.
      role="list"
      style={{
        borderColor: "var(--zoc-border)",
        borderLeftWidth: "var(--zoc-rail-width)",
        marginLeft: "var(--zoc-rail-inset)",
        paddingLeft: "var(--zoc-row-gap)",
        gap: "var(--zoc-row-gap-tight)",
      }}
      data-zoc-tool-timeline=""
    >
      {items.map((item) =>
        item.kind === "cluster" ? (
          <ToolCluster
            key={`cluster:${item.toolName}:${item.members[0]?.toolCallId ?? ""}`}
            cluster={item}
            open={expanded.has(clusterKey(item.toolName, item.members[0]?.toolCallId))}
            onOpenChange={(open) =>
              toggle(clusterKey(item.toolName, item.members[0]?.toolCallId), open)
            }
            expandedMembers={expanded}
            onMemberOpenChange={toggle}
            {...(onRetry === undefined ? {} : { onRetry })}
          />
        ) : (
          <ToolEntry
            key={item.entry.toolCallId}
            entry={item.entry}
            open={expanded.has(item.entry.toolCallId)}
            onOpenChange={(open) => toggle(item.entry.toolCallId, open)}
            {...(onRetry === undefined ? {} : { onRetry })}
          />
        ),
      )}
    </ol>
  );
}

/**
 * A cluster's expansion key.
 *
 * Keyed on the tool name *and* its first member's id, not the name alone: a Run can call the
 * same tool in two separate runs of four, and a name-only key would expand both together.
 */
function clusterKey(toolName: string, firstMemberId: string | undefined): string {
  return `cluster:${toolName}:${firstMemberId ?? ""}`;
}

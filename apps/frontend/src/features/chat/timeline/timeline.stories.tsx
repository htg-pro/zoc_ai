/**
 * The tool-call timeline — zoc-agent-chat-rebuild task 27.1 (R17.5, R22.6).
 *
 * Feature: zoc-agent-chat-rebuild, task 27.1 (R17.5, R22.6).
 *
 * Two things here are look-only checks that the timeline's property tests cannot make. R21.7 requires
 * state to survive without colour perception, which is met structurally — six shapes, one per
 * `ToolKind`, and a failed call takes the failure shape whatever its kind. Property 45 asserts the
 * mapping; only `NodeShapes` shows whether the six are actually distinguishable at 8 px.
 *
 * And R9.5's clustering is a threshold nobody can eyeball from the code: `CLUSTER_THRESHOLD` is 3 and
 * the comparison is `>`, so a three-call run stays individually legible and the fourth call collapses
 * the row. `Timeline` renders a fixture that contains both sides of that edge.
 */
import { useState } from "react";
import type { Story } from "@ladle/react";

import type { ToolKind } from "@zoc-studio/shared-types";
import { StoryFrame, Variant } from "../story-frame";
import { TOOL_ENTRIES } from "../story-fixtures";
import { ToolCluster, type ClusterItem } from "./ToolCluster";
import { ToolEntry } from "./ToolEntry";
import { ToolNode } from "./ToolNode";
import { ToolTimeline } from "./ToolTimeline";
import { groupTimeline, type ToolEntryState } from "./tool-entry-model";

export default { title: "Chat / Timeline" };

const KINDS: readonly ToolKind[] = ["read", "write", "execute", "search", "network", "mcp"];
const STATES: readonly ToolEntryState[] = ["running", "succeeded", "failed", "denied"];

/** The fixture's four-call `workspace_grep` run, grouped by the function the timeline itself uses. */
const CLUSTER = groupTimeline(TOOL_ENTRIES).find(
  (item): item is ClusterItem => item.kind === "cluster",
);

/**
 * The whole timeline: four single entries, then a clustered run of four.
 *
 * One story rather than one per state, because the timeline is read as a column — whether a failure
 * stands out is a question about the eight rows together, not about the failed row alone.
 */
export const Timeline: Story = () => (
  <StoryFrame brief="Four states as individual entries, then a four-call run collapsed by R9.5. The failure should be findable without reading a word.">
    <Variant label="mixed states and one cluster">
      <ToolTimeline entries={TOOL_ENTRIES} onRetry={() => undefined} />
    </Variant>
    <Variant
      label="empty"
      note="No calls in this Run: the timeline draws nothing rather than a header."
    >
      <ToolTimeline entries={[]} />
    </Variant>
  </StoryFrame>
);

/**
 * One entry per state, as an accordion so the expanded detail (R9.3) is reachable.
 *
 * Interactive rather than a fixed `open`, because the thing worth checking is that opening one entry
 * does not move the seven rows above it — a static screenshot of an open row cannot show that.
 */
export const EntryStates: Story = () => {
  const [open, setOpen] = useState<string | null>("call-read-1");
  return (
    <StoryFrame brief="Each state's own row, expandable. Only the retryable failure offers Retry (R9.6) — the denied call is not a failure.">
      {TOOL_ENTRIES.slice(0, 4).map((entry) => (
        <Variant key={entry.toolCallId} label={entry.state}>
          <ToolEntry
            entry={entry}
            open={open === entry.toolCallId}
            onOpenChange={(next) => {
              setOpen(next ? entry.toolCallId : null);
            }}
            onRetry={() => undefined}
          />
        </Variant>
      ))}
    </StoryFrame>
  );
};

/** The clustered run, closed and open. A member's own detail survives the cluster collapsing. */
export const Cluster: Story = () => {
  const [open, setOpen] = useState(true);
  const [members, setMembers] = useState<ReadonlySet<string>>(new Set(["call-grep-2"]));
  if (CLUSTER === undefined)
    return <StoryFrame brief="The fixture no longer contains a cluster." />;
  return (
    <StoryFrame
      brief={`${String(CLUSTER.count)} × ${CLUSTER.toolName}, summed to one duration. Close it and reopen it: the expanded member stays expanded.`}
    >
      <Variant label={open ? "open" : "closed"}>
        <ToolCluster
          cluster={CLUSTER}
          open={open}
          onOpenChange={setOpen}
          expandedMembers={members}
          onMemberOpenChange={(toolCallId, next) => {
            setMembers((current) => {
              const updated = new Set(current);
              if (next) updated.add(toolCallId);
              else updated.delete(toolCallId);
              return updated;
            });
          }}
        />
      </Variant>
    </StoryFrame>
  );
};

/**
 * The R21.7 gate: six kinds × four states, at the size they ship.
 *
 * Squint at it, or view it in greyscale. Every cell in a row must be tellable from every other by its
 * outline alone — and the `failed` column is deliberately all one shape, because a failure's shape
 * overrides its kind. That last part is the check most likely to look like a bug and is the rule.
 */
export const NodeShapes: Story = () => (
  <StoryFrame brief="Greyscale this story. If two shapes in a row are indistinguishable, colour is carrying the state and R21.7 fails.">
    <Variant label="kind × state">
      <table className="border-separate border-spacing-3">
        <thead>
          <tr>
            <th />
            {STATES.map((state) => (
              <th
                key={state}
                className="font-mono font-normal"
                style={{ color: "var(--zoc-text-muted)", fontSize: "var(--zoc-text-label)" }}
              >
                {state}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {KINDS.map((kind) => (
            <tr key={kind}>
              <th
                className="text-right font-mono font-normal"
                style={{ color: "var(--zoc-text-muted)", fontSize: "var(--zoc-text-label)" }}
              >
                {kind}
              </th>
              {STATES.map((state) => (
                <td key={state}>
                  <ToolNode kind={kind} state={state} />
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </Variant>
  </StoryFrame>
);

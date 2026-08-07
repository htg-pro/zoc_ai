/**
 * The mode consequence line — zoc-agent-chat-rebuild R11.10, R32.1, task 20.2.
 *
 * Feature: zoc-agent-chat-rebuild, task 20.2 (R11.10, R32.1).
 *
 * One muted line directly under the control row, stating what the current *pair* of modes permits. The
 * sentence comes from `mode-consequence.ts`, which derives it from the Capability_Policy — so this
 * component is spacing, a live region, and a truncation rule, and nothing else.
 *
 * ## Why it truncates and never wraps
 *
 * A composer whose height depends on a mode label would reflow the transcript every time either control
 * moved, and the transcript is the thing the user is reading. So the line is one line: it ellipsises, and
 * the full sentence stays available through the title and through the accessible name.
 *
 * ## Why `aria-live`
 *
 * The line is the only place the *interaction* between the two axes is stated, and both controls are
 * elsewhere in the row. A sighted user sees it change; without a live region a screen-reader user would
 * change Approval and hear nothing about what it now means under the selected Conversation_Mode.
 */
import { cn } from "@/lib/utils";
import type { ConversationMode } from "@zoc-studio/shared-types";
import { modeConsequence, type PermissionMode } from "./mode-consequence";

export interface ModeConsequenceLineProps {
  mode: ConversationMode;
  permissionMode: PermissionMode;
  className?: string;
}

export function ModeConsequenceLine({ mode, permissionMode, className }: ModeConsequenceLineProps) {
  const consequence = modeConsequence(mode, permissionMode);

  return (
    <p
      className={cn("truncate", className)}
      data-zoc-mode-consequence=""
      data-zoc-approval-inert={consequence.approvalIsInert ? "" : undefined}
      // Polite: it changes only when a control moves, which is a deliberate act the user is waiting to
      // hear the result of.
      aria-live="polite"
      title={consequence.sentence}
      style={{
        color: "var(--zoc-text-muted)",
        fontSize: "var(--zoc-text-label)",
      }}
    >
      {consequence.sentence}
    </p>
  );
}

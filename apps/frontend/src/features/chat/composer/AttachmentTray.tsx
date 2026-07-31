/**
 * The attachment tray — zoc-agent-chat-rebuild R33 (M2), task 20.2.
 *
 * An empty slot, on purpose. Image and document attachments are M2, and the reason the slot exists now is
 * that adding it later would reflow the composer — the control row's widths, the mention chips' wrapping,
 * and the container-query breakpoints are all decided by what is in this row.
 *
 * It renders nothing at all rather than a disabled button: a control that cannot do anything invites a
 * user to work out why, which is the rule the rest of the panel follows for disabled affordances. What it
 * reserves is layout, not an affordance.
 *
 * When 33.x fills it, the change is this file and nothing else.
 */
import { cn } from "@/lib/utils";

export interface AttachmentTrayProps {
  className?: string;
}

export function AttachmentTray({ className }: AttachmentTrayProps) {
  return <div className={cn("contents", className)} data-zoc-attachment-tray="" aria-hidden />;
}

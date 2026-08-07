/**
 * The one Session delete confirmation — zoc-agent-chat-rebuild R15.4, R21.6, R35.2, task 25.2.
 *
 * Extracted verbatim out of {@link SessionList} (22.5) because 25.2 consolidates *three* delete gates,
 * not one: the list's dialog, `SessionsPanel`'s `window.confirm`, and `SessionsView`'s `window.confirm`.
 * Leaving it inside the list would have made the two workspace surfaces write their own — three divergent
 * confirmations again, which is what R35.2 asks us to stop doing.
 *
 * The `window.confirm` calls it replaces are untrappable, unstylable, and invisible to the accessibility
 * tree, so a confirmation gate written that way cannot be asserted at all.
 *
 * One dialog per surface, whichever row asked for it — not one per row. A dialog per row would mount a
 * Radix `Dialog` per Session (500 of them in the 22.5 search fixture) and the confirmation is about a
 * decision rather than about a row.
 */
import type { Session } from "@zoc-studio/shared-types";

import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

export interface SessionDeleteDialogProps {
  /** The Session awaiting confirmation, or null when the dialog is closed. */
  session: Session | null;
  onCancel: () => void;
  onConfirm: (sessionId: string) => void;
}

export function SessionDeleteDialog({ session, onCancel, onConfirm }: SessionDeleteDialogProps) {
  return (
    <Dialog
      open={session !== null}
      onOpenChange={(open) => {
        if (!open) onCancel();
      }}
    >
      <DialogContent data-zoc-session-delete-dialog="">
        <DialogHeader>
          <DialogTitle>Delete this session?</DialogTitle>
          <DialogDescription>
            {session === null
              ? ""
              : `“${session.title}” and its ${String(session.messages.length)} ${
                  session.messages.length === 1 ? "message" : "messages"
                } are removed. This cannot be undone — archive it instead to keep the transcript.`}
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <button
            type="button"
            data-zoc-session-delete-cancel=""
            onClick={onCancel}
            className="rounded-[var(--zoc-radius-chip)] px-2 py-1 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[color:var(--zoc-agent-strong)]"
            style={{ color: "var(--zoc-text-muted)", fontSize: "var(--zoc-text-label)" }}
          >
            Keep it
          </button>
          <button
            type="button"
            data-zoc-session-delete-confirm=""
            onClick={() => {
              if (session !== null) onConfirm(session.id);
            }}
            className="rounded-[var(--zoc-radius-chip)] border px-2 py-1 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[color:var(--zoc-agent-strong)]"
            style={{
              borderColor: "var(--zoc-error)",
              color: "var(--zoc-error)",
              fontSize: "var(--zoc-text-label)",
            }}
          >
            Delete
          </button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

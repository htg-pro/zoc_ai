/**
 * The send control — zoc-agent-chat-rebuild R8.7, R12.6, R32.14, R32.15, task 20.2.
 *
 * One button with two jobs. Idle it sends; while a Run streams it becomes `Queue` and holds one message,
 * showing the queued count — which is R8.7's "keep the composer usable" made concrete: the user types the
 * next thing while the current Run finishes, and nothing is lost and nothing interrupts.
 *
 * ## Why it disables on `empty` and explains on everything else
 *
 * `composer-validate.ts` supplies the `[1, 10_000]` bound. An empty draft disables the control silently,
 * because a user who has typed nothing does not need telling. Every other refusal — too long, an
 * out-of-range mode, a mode with no workspace, an overflowing context — carries a sentence, because each
 * is a thing the user can fix and cannot guess. That split is `refusalIsWorthStating`'s, so the control and
 * the gate cannot disagree about which refusals are silent.
 *
 * ## Why one queued message and not a queue
 *
 * A queue of prompts against a Run whose result changes what the next prompt should say is a machine for
 * producing work the user no longer wants. One is enough to keep typing; more would need cancelling.
 */
import { ArrowUp, ListPlus } from "lucide-react";

import { cn } from "@/lib/utils";

export interface SendControlProps {
  /** True while a Run is in flight — `status` is `submitted` or `streaming`. */
  streaming: boolean;
  /** False when the draft cannot be sent for any reason. */
  enabled: boolean;
  /** The sentence to show, or `null` when the refusal is one that stays silent. */
  reason: string | null;
  /** How many messages are already queued behind the current Run. At most one. */
  queued: number;
  onSend: () => void;
  className?: string;
}

export function SendControl({
  streaming,
  enabled,
  reason,
  queued,
  onSend,
  className,
}: SendControlProps) {
  const label = streaming ? "Queue" : "Send";

  return (
    <div className={cn("flex items-center gap-2", className)}>
      {reason === null ? null : (
        <span
          data-zoc-send-reason=""
          // Polite rather than assertive: it changes as the user types, and an assertive region would
          // interrupt a screen reader on every keystroke past the limit.
          aria-live="polite"
          style={{ color: "var(--zoc-text-muted)", fontSize: "var(--zoc-text-label)" }}
        >
          {reason}
        </span>
      )}
      {queued > 0 ? (
        <span
          data-zoc-send-queued={String(queued)}
          style={{ color: "var(--zoc-text-muted)", fontSize: "var(--zoc-text-label)" }}
        >
          {queued === 1 ? "1 queued" : `${String(queued)} queued`}
        </span>
      ) : null}
      <button
        type="button"
        data-zoc-send=""
        data-zoc-send-mode={streaming ? "queue" : "send"}
        disabled={!enabled}
        // The keyboard shortcut is in the name, so a screen-reader user learns it without a tooltip.
        aria-label={`${label} — Command Enter`}
        aria-keyshortcuts="Meta+Enter Enter"
        onClick={onSend}
        className={cn(
          "inline-flex items-center gap-1 rounded-[var(--zoc-radius-chip)] border px-2 py-1",
          "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[color:var(--zoc-agent-strong)]",
          enabled ? "hover:bg-[var(--zoc-elev-2)]" : "cursor-not-allowed",
        )}
        style={{
          borderColor: enabled ? "var(--zoc-agent)" : "var(--zoc-border)",
          color: enabled ? "var(--zoc-text)" : "var(--zoc-text-faint)",
          fontSize: "var(--zoc-text-label)",
        }}
      >
        {streaming ? (
          <ListPlus aria-hidden className="size-3.5" />
        ) : (
          <ArrowUp aria-hidden className="size-3.5" />
        )}
        {label}
      </button>
    </div>
  );
}

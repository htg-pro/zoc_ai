/**
 * The composer's text area — zoc-agent-chat-rebuild R8.7, R12.4, task 20.2.
 *
 * A textarea that grows from one row to eight and then scrolls internally, and the one place the
 * composer's keys are routed. Everything it knows about the mention popover arrives as props, because the
 * *state* of the popover is the composer's and the *events* land here — so the routing lives with the
 * events and the decision lives with the state.
 *
 * ## Why the caret travels with every change
 *
 * `detectMentionQuery` needs the caret, not just the text: `@src/a` with the caret before the `@` is not
 * an active mention. Reading `selectionStart` in the parent would mean reading it after React had
 * committed, which is one render later than the keystroke — so the caret is reported with the text that
 * produced it.
 *
 * ## Why eight rows
 *
 * R8.7 keeps the composer usable while a Run streams, and a composer that grows without limit eventually
 * owns the panel — at which point the transcript it is a companion to is gone. Eight rows is the design's
 * figure; past it the textarea scrolls, which keeps the panel's layout a function of the *panel* rather
 * than of how much the user has typed.
 */
import { useEffect, useRef, type KeyboardEvent } from "react";

import { cn } from "@/lib/utils";

/** Rows before the textarea stops growing and starts scrolling. */
export const MAX_COMPOSER_ROWS = 8;

export interface ComposerInputProps {
  value: string;
  /** The draft and the caret that produced it, together. */
  onChange: (next: { readonly text: string; readonly caret: number }) => void;
  /** `⌘↵` or `↵` with no popover open. */
  onSubmit: () => void;
  /** `Esc`: the parent closes the popover, or clears the draft when none is open. */
  onEscape: () => void;
  /** True while the mention popover is open, which changes what `↵` and the arrows mean (R12.4). */
  popoverOpen?: boolean;
  onAcceptMention?: () => void;
  onMoveSelection?: (delta: 1 | -1) => void;
  placeholder?: string;
  /** The composer is never disabled while a Run streams (R8.7); this is for a read-only viewer (R1.4). */
  disabled?: boolean;
  className?: string;
}

export function ComposerInput({
  value,
  onChange,
  onSubmit,
  onEscape,
  popoverOpen = false,
  onAcceptMention,
  onMoveSelection,
  placeholder = "Ask a follow-up…",
  disabled = false,
  className,
}: ComposerInputProps) {
  const ref = useRef<HTMLTextAreaElement | null>(null);

  // Grow on every change rather than on input events only, so a draft restored from the store on a
  // Session switch is the right height on its first paint instead of one frame later.
  useEffect(() => {
    const element = ref.current;
    if (element === null) return;
    element.style.height = "auto";
    element.style.height = `${String(element.scrollHeight)}px`;
  }, [value]);

  const handleKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === "Escape") {
      event.preventDefault();
      onEscape();
      return;
    }

    if (popoverOpen && (event.key === "ArrowDown" || event.key === "ArrowUp")) {
      // The arrows belong to the popover while it is open. Without the `preventDefault` they would also
      // move the caret, so the selection and the insertion point would drift apart.
      event.preventDefault();
      onMoveSelection?.(event.key === "ArrowDown" ? 1 : -1);
      return;
    }

    if (event.key !== "Enter") return;

    // `⇧↵` is a newline in every case, including with the popover open: a user holding shift is writing
    // prose, not picking from a list.
    if (event.shiftKey) return;

    event.preventDefault();
    if (popoverOpen && onAcceptMention !== undefined) {
      onAcceptMention();
      return;
    }
    onSubmit();
  };

  return (
    <textarea
      ref={ref}
      value={value}
      rows={1}
      disabled={disabled}
      placeholder={placeholder}
      data-zoc-composer-input=""
      onChange={(event) => {
        onChange({
          text: event.target.value,
          caret: event.target.selectionStart ?? event.target.value.length,
        });
      }}
      // A click or an arrow key moves the caret without changing the text, and the popover's open state
      // depends on where the caret is — so the parent is told about those too.
      onSelect={(event) => {
        const element = event.currentTarget;
        onChange({ text: element.value, caret: element.selectionStart ?? element.value.length });
      }}
      onKeyDown={handleKeyDown}
      className={cn(
        "w-full resize-none bg-transparent outline-none placeholder:text-[color:var(--zoc-text-faint)]",
        className,
      )}
      style={{
        color: "var(--zoc-text)",
        fontSize: "var(--zoc-text-body)",
        lineHeight: "var(--zoc-leading-body)",
        // The ceiling is expressed in rows so it tracks the type scale rather than a pixel figure that
        // would be wrong at the next font-size change.
        maxHeight: `calc(${String(MAX_COMPOSER_ROWS)} * var(--zoc-leading-body) * var(--zoc-text-body))`,
        overflowY: "auto",
      }}
    />
  );
}

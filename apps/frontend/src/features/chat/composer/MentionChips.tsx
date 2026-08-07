/**
 * The mention chips — zoc-agent-chat-rebuild R12.3, R12.5, R12.7, task 20.2.
 *
 * Feature: zoc-agent-chat-rebuild, task 20.2 (R12.3, R12.5, R12.7).
 *
 * One removable chip per attached reference, above the textarea. Two states, and the second is the reason
 * the component exists rather than being a list of strings: a chip whose file was deleted or renamed after
 * selection renders struck through with an `unresolved` badge and is **excluded from the request** (R12.7).
 *
 * ## Why an unresolved chip stays on screen
 *
 * Dropping it silently would leave the user with a prompt that no longer says what they thought it said,
 * and no way to notice. Keeping it visible and excluded means the request is correct *and* the discrepancy
 * is legible — which is why `resolved` is a state a chip can be in rather than a filter applied before
 * rendering. `requestableMentions` in the store is the one place the exclusion happens.
 */
import { X } from "lucide-react";

import { cn } from "@/lib/utils";
import { formatTokens } from "./context-figures";
import type { ResolvedMention } from "../store";

export interface MentionChipsProps {
  mentions: readonly ResolvedMention[];
  onRemove: (id: string) => void;
  className?: string;
}

export function MentionChips({ mentions, onRemove, className }: MentionChipsProps) {
  if (mentions.length === 0) return null;

  return (
    <ul
      role="list"
      className={cn("flex flex-wrap items-center gap-1.5", className)}
      data-zoc-mention-chips=""
    >
      {mentions.map((mention) => (
        <li
          key={mention.id}
          data-zoc-mention-chip={mention.ref}
          data-resolved={mention.resolved ? "" : undefined}
          className="flex items-center gap-1 rounded-[var(--zoc-radius-chip)] border px-1.5 py-0.5"
          style={{
            backgroundColor: "var(--zoc-row-bg)",
            borderColor: mention.resolved ? "var(--zoc-border)" : "var(--zoc-error)",
          }}
        >
          <span
            className={cn("font-mono", !mention.resolved && "line-through")}
            style={{
              color: mention.resolved ? "var(--zoc-text-secondary)" : "var(--zoc-text-muted)",
              fontSize: "var(--zoc-text-meta)",
            }}
          >
            {mention.ref}
          </span>
          {mention.resolved ? (
            <span
              className="tabular-nums"
              data-zoc-chip-cost=""
              style={{ color: "var(--zoc-text-faint)", fontSize: "var(--zoc-text-label)" }}
            >
              {formatTokens(mention.estimatedTokens)}
            </span>
          ) : (
            <span
              data-zoc-chip-unresolved=""
              // The badge says what happened rather than just that something did: "unresolved" is the
              // word the request's exclusion is about.
              style={{ color: "var(--zoc-error)", fontSize: "var(--zoc-text-label)" }}
            >
              unresolved
            </span>
          )}
          <button
            type="button"
            data-zoc-chip-remove={mention.ref}
            aria-label={`Remove ${mention.ref}`}
            onClick={() => {
              onRemove(mention.id);
            }}
            className="rounded-[var(--zoc-radius-chip)] p-0.5 hover:bg-[var(--zoc-elev-2)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[color:var(--zoc-agent-strong)]"
            style={{ color: "var(--zoc-text-muted)" }}
          >
            <X aria-hidden className="size-3" />
          </button>
        </li>
      ))}
    </ul>
  );
}

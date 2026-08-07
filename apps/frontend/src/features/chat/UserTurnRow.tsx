/**
 * The user's own turn — zoc-agent-chat-rebuild R17.1, task 15.2.
 *
 * Feature: zoc-agent-chat-rebuild, task 15.2 (R17.1).
 *
 * Unboxed prose on the panel background at the answer type scale, which is the design's
 * message tier: a turn is not a card. A box around a message is what made the legacy panel
 * read as a stack of receipts.
 *
 * **A user turn is deliberately not markdown.** It is what the user typed, and rendering it
 * through `react-markdown` would silently reinterpret their text: a glob like `src/*.ts`
 * becomes emphasis, a line starting `# ` becomes a heading, and a snippet pasted without
 * fences loses its newlines. Pre-wrapped plain text keeps all of it — and is inert by
 * construction rather than by policy, which is the stronger guarantee of the two.
 */
import { cn } from "@/lib/utils";
import { FileText } from "lucide-react";
import { formatAttachmentBytes, type ComposerAttachment } from "./composer/attachment-model";

export interface UserTurnRowProps {
  text: string;
  attachments?: readonly ComposerAttachment[];
  className?: string;
}

/**
 * The user's own turn.
 *
 * The label is a `<span>` rather than a heading, because a transcript of fifty turns would
 * otherwise contribute fifty same-level headings to the document outline — which makes the
 * outline useless as navigation, the one thing it exists for.
 */
export function UserTurnRow({ text, attachments = [], className }: UserTurnRowProps) {
  return (
    <div
      className={cn("flex flex-col", className)}
      style={{ gap: "var(--zoc-row-gap-tight)" }}
      data-zoc-row="user-turn"
    >
      <span
        className="font-mono uppercase"
        style={{
          color: "var(--zoc-text-faint)",
          fontSize: "var(--zoc-text-label)",
          letterSpacing: "var(--zoc-tracking-label)",
        }}
      >
        You
      </span>
      <div
        // `whitespace-pre-wrap` rather than a markdown pass: the user's newlines and their
        // leading spaces are content, and this is the rendering that keeps them without
        // reinterpreting anything.
        className="whitespace-pre-wrap break-words"
        style={{
          color: "var(--zoc-text)",
          fontSize: "var(--zoc-text-answer)",
          lineHeight: "var(--zoc-leading-answer)",
        }}
        data-zoc-user-text=""
      >
        {text}
      </div>
      {attachments.length === 0 ? null : (
        <div className="flex flex-wrap gap-2" data-zoc-user-attachments="">
          {attachments.map((attachment) => (
            <div
              key={attachment.id}
              className="flex min-w-0 max-w-64 items-center gap-2 rounded-[var(--zoc-radius-chip)] border px-2 py-1.5"
              style={{ borderColor: "var(--zoc-border)", background: "var(--zoc-row-bg)" }}
              data-zoc-user-attachment={attachment.kind}
            >
              {attachment.kind === "image" && attachment.mediaType !== "image/svg+xml" ? (
                <img
                  src={attachment.url}
                  alt={attachment.name}
                  className="size-12 shrink-0 rounded object-cover"
                />
              ) : (
                <FileText aria-hidden className="size-5 shrink-0" />
              )}
              <span className="min-w-0">
                <span className="block truncate text-xs font-medium">{attachment.name}</span>
                <span className="block text-[11px]" style={{ color: "var(--zoc-text-faint)" }}>
                  {attachment.kind === "document"
                    ? `${String(attachment.estimatedTokens)} extracted tokens`
                    : formatAttachmentBytes(attachment.size)}
                </span>
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

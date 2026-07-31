/**
 * The user's own turn — zoc-agent-chat-rebuild R17.1, task 15.2.
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

export interface UserTurnRowProps {
  text: string;
  className?: string;
}

/**
 * The user's own turn.
 *
 * The label is a `<span>` rather than a heading, because a transcript of fifty turns would
 * otherwise contribute fifty same-level headings to the document outline — which makes the
 * outline useless as navigation, the one thing it exists for.
 */
export function UserTurnRow({ text, className }: UserTurnRowProps) {
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
    </div>
  );
}

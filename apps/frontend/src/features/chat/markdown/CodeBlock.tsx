/**
 * A fenced code block — zoc-agent-chat-rebuild R8.5, R8.6, R17.1.
 *
 * Three things R8.5 asks for: a language label, a copy control per fence, and a highlighted
 * body. The order they happen in is the design:
 *
 *   1. **While the fence is open**, the body is plain mono text. Nothing is tokenised — see
 *      `highlight.ts` for why re-tokenising a growing block is the most expensive thing the
 *      surface could do.
 *   2. **When the fence closes**, `highlightBlock` runs in an idle callback and the body is
 *      replaced in place. The swap is invisible: same font, same metrics, same layout, so no
 *      row height changes and the transcript does not reflow.
 *   3. **If highlighting fails or never runs**, the plain body stays. Unhighlighted code is
 *      completely readable, and a transcript row must not be able to fail on decoration.
 *
 * **The copy payload is the source text, never the DOM.** It is the string this component was
 * handed, not `textContent` of the rendered body — highlighted output has been through Monaco
 * and DOMPurify, and reading it back would paste markup or lose whitespace Monaco collapsed.
 * That is also what makes Property 9's "each control's payload equals its own block's source"
 * true by construction rather than by coincidence.
 */
import { useEffect, useRef, useState } from "react";
import { Check, Copy } from "lucide-react";

import { cn } from "@/lib/utils";
import { highlightBlock, whenIdle, type HighlightOptions } from "./highlight";

/** How long the copy control shows its confirmed state. */
const COPIED_FEEDBACK_MS = 1500;

export interface CodeBlockProps {
  /** The block's source text, exactly as the model emitted it. */
  code: string;
  /** The fence's info string. Empty for an untagged fence. */
  language?: string;
  /**
   * False while the fence is still arriving.
   *
   * The component's own reason for existing as a stateful thing: highlighting is gated on
   * this, and a caller that passed `true` mid-stream would reintroduce the per-delta
   * tokenisation the design forbids.
   */
  closed?: boolean;
  /** Injected in tests, so a fake Monaco can drive the highlighted path. */
  highlightOptions?: HighlightOptions;
  className?: string;
}

export function CodeBlock({
  code,
  language = "",
  closed = true,
  highlightOptions,
  className,
}: CodeBlockProps) {
  const [highlighted, setHighlighted] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const copyTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    // Streaming, or already highlighted for this exact source: nothing to do. The `code`
    // dependency is what makes a regenerated block re-highlight and a growing one not.
    if (!closed) {
      setHighlighted(null);
      return;
    }

    let live = true;
    const cancel = whenIdle(() => {
      void highlightBlock(code, language, highlightOptions ?? {}).then((html) => {
        // A row unmounted mid-tokenise must not set state, and one whose source changed
        // must not show the previous block's highlighting.
        if (live) setHighlighted(html);
      });
    });

    return () => {
      live = false;
      cancel();
    };
  }, [code, language, closed, highlightOptions]);

  useEffect(
    () => () => {
      if (copyTimer.current !== null) clearTimeout(copyTimer.current);
    },
    [],
  );

  const copy = (): void => {
    // The source string, not the DOM: see the header.
    void navigator.clipboard?.writeText(code).then(
      () => {
        setCopied(true);
        if (copyTimer.current !== null) clearTimeout(copyTimer.current);
        copyTimer.current = setTimeout(() => setCopied(false), COPIED_FEEDBACK_MS);
      },
      () => {
        // A refused clipboard is not worth a toast in a transcript row: the code is on
        // screen and selectable, so the user's fallback is the one they already had.
      },
    );
  };

  const label = language.trim().length > 0 ? language.trim() : "code";

  return (
    <div
      className={cn(
        "my-2 overflow-hidden rounded-[var(--zoc-radius-chip)] border",
        "border-[var(--zoc-border)] bg-[var(--zoc-elev-1)]",
        className,
      )}
      data-zoc-code-block=""
      data-language={label}
      data-streaming={closed ? undefined : ""}
    >
      <div className="flex items-center justify-between gap-2 border-b border-[var(--zoc-border)] px-2 py-1">
        <span
          className="font-mono uppercase"
          style={{
            color: "var(--zoc-text-faint)",
            fontSize: "var(--zoc-text-label)",
            letterSpacing: "var(--zoc-tracking-label)",
          }}
        >
          {label}
        </span>
        <button
          type="button"
          onClick={copy}
          data-zoc-copy-control=""
          // The payload is on the element as well as in the handler, so Property 9 can assert
          // the correspondence without driving a clipboard jsdom does not implement.
          data-copy-payload={code}
          // The name carries the language, because a transcript with six blocks otherwise
          // presents six controls called "Copy" to a screen reader (R21.x).
          aria-label={`Copy ${label} block`}
          className={cn(
            "inline-flex items-center gap-1 rounded-[var(--zoc-radius-chip)] px-1.5 py-0.5",
            "font-mono transition-colors hover:bg-[var(--zoc-row-bg)]",
          )}
          style={{ color: "var(--zoc-text-muted)", fontSize: "var(--zoc-text-label)" }}
        >
          {copied ? (
            <Check aria-hidden className="size-3" />
          ) : (
            <Copy aria-hidden className="size-3" />
          )}
          {copied ? "Copied" : "Copy"}
        </button>
      </div>

      <pre
        className="overflow-x-auto px-3 py-2 font-mono"
        style={{
          color: "var(--zoc-text-secondary)",
          fontSize: "var(--zoc-text-body)",
          lineHeight: "var(--zoc-leading-body)",
        }}
      >
        {highlighted === null ? (
          <code data-zoc-code-body="">{code}</code>
        ) : (
          <code
            data-zoc-code-body=""
            data-highlighted=""
            // The only `dangerouslySetInnerHTML` in the Chat_Surface, and the string reaching
            // it has been through `sanitizeHighlightHtml` — which is why that function exists
            // and why its allowlist is Monaco's output rather than "what markdown needs".
            dangerouslySetInnerHTML={{ __html: highlighted }}
          />
        )}
      </pre>
    </div>
  );
}

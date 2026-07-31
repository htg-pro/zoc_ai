/**
 * Assistant markdown, rendered inert — zoc-agent-chat-rebuild R8.1, R8.5, R8.6.
 *
 * The one place model-authored markdown becomes DOM. Every safety decision in the surface is
 * concentrated here, so a reviewer has one file to read rather than a policy spread across
 * every row that might render prose.
 *
 * ## Three layers, and each covers what the others cannot
 *
 * 1. **`skipHtml`.** `react-markdown`'s default, with no `rehype-raw`: raw HTML in model
 *    output is dropped at *parse* time. Nothing reaches the DOM to be cleaned, which is
 *    strictly better than sanitising after the fact — there is no serialise/reparse round
 *    trip for a mutation-XSS gadget to exploit.
 * 2. **A component map that renders only what it names.** `a` is rewritten through
 *    {@link isSafeUrl}; `img` renders as its alt text rather than a request; `code` becomes
 *    `CodeBlock`. Anything else falls through to `react-markdown`'s own element for the node,
 *    which is a text-bearing HTML element and never a script or an event handler, because
 *    `skipHtml` means the node came from markdown syntax rather than from a tag.
 * 3. **DOMPurify over the one string inserted as markup** — `monaco.editor.colorize`'s
 *    output, inside `CodeBlock`. That is the whole of R8.6's defence-in-depth surface,
 *    because it is the whole of the markup this component does not construct itself.
 *
 * **The repair runs before `react-markdown`, not inside it.** A truncated fence has to be
 * closed before the parser sees it, or the parser produces literal backticks and the row
 * reflows a delta later when the real closer arrives (R8.1).
 */
import { memo, useMemo, type ReactNode } from "react";
import Markdown from "react-markdown";

import { cn } from "@/lib/utils";
import { CodeBlock } from "./CodeBlock";
import type { HighlightOptions } from "./highlight";
import { repairStreamingMarkdown } from "./repair";
import { isSafeUrl } from "./sanitize";

export interface MarkdownBodyProps {
  /** The model's text. Repaired here, so callers pass it through unmodified. */
  text: string;
  /**
   * True while the message is still arriving.
   *
   * Two things depend on it: the repair only matters mid-stream, and `CodeBlock` withholds
   * highlighting until a fence has closed. A caller that reported `false` while streaming
   * would reintroduce per-delta tokenisation.
   */
  streaming?: boolean;
  highlightOptions?: HighlightOptions;
  className?: string;
}

/** The href a link renders with, or `undefined` to render it as plain text. */
function safeHref(href: string | undefined): string | undefined {
  if (href === undefined) return undefined;
  return isSafeUrl(href) ? href : undefined;
}

/** The text inside a node, for the fence body and for an image's alt fallback. */
function textOf(children: ReactNode): string {
  if (typeof children === "string") return children;
  if (typeof children === "number") return String(children);
  if (Array.isArray(children)) return children.map(textOf).join("");
  if (children !== null && typeof children === "object" && "props" in children) {
    return textOf((children as { props?: { children?: ReactNode } }).props?.children);
  }
  return "";
}

/**
 * The `code` element inside a `pre`, which is the shape every fence produces.
 *
 * **Fences are detected by this parent-child structure, not by a `language-*` class**, and the
 * difference is a bug this cost: `react-markdown` sets that class only when a fence carries an
 * info string, so an *untagged* fence — ``` with nothing after it — has no class and read as
 * inline code. It rendered as a one-line inline span with no label and no copy control, which
 * is wrong for the most common fence a model writes when it does not name a language.
 *
 * `pre > code` is unambiguous: markdown produces it for a fenced block and for nothing else.
 * Inline code is a bare `code` with no `pre` parent, so handling the fence case in `pre` makes
 * the two mutually exclusive by construction.
 */
function fenceOf(children: ReactNode): { language: string; code: string } | null {
  if (children === null || typeof children !== "object" || !("props" in children)) return null;
  const props = (children as { props?: { className?: string; children?: ReactNode } }).props;
  if (props === undefined) return null;
  const match = /language-(\S+)/.exec(props.className ?? "");
  return {
    language: match?.[1] ?? "",
    // Markdown always terminates a fence body with a newline; it is a delimiter rather than
    // content, and keeping it would add a blank last line to every copied block.
    code: textOf(props.children).replace(/\n$/, ""),
  };
}

export const MarkdownBody = memo(function MarkdownBody({
  text,
  streaming = false,
  highlightOptions,
  className,
}: MarkdownBodyProps) {
  // Only repaired while streaming: a settled message is already well-formed, and repairing it
  // would be appending delimiters to text that needs none.
  const source = useMemo(
    () => (streaming ? repairStreamingMarkdown(text) : text),
    [text, streaming],
  );

  return (
    <div
      className={cn("zoc-markdown", className)}
      data-zoc-markdown=""
      style={{
        color: "var(--zoc-text)",
        fontSize: "var(--zoc-text-answer)",
        lineHeight: "var(--zoc-leading-answer)",
      }}
    >
      <Markdown
        // `skipHtml` is the default and is stated anyway: it is the load-bearing safety
        // decision in this file, and a future reader adding `rehype-raw` should have to
        // delete an explicit prop rather than merely fail to notice an absent one.
        skipHtml
        components={{
          // The fence lives here, not in `code`: `pre > code` is the shape markdown gives a
          // fenced block and nothing else, so this is the one place the two forms of `code`
          // can be told apart without depending on an info string being present.
          pre: ({ children }) => {
            const fence = fenceOf(children);
            if (fence === null) return <>{children}</>;
            return (
              <CodeBlock
                code={fence.code}
                language={fence.language}
                // A fence in a *streaming* message may still be open.
                // `repairStreamingMarkdown` closed it for the parser's benefit, so the parser
                // reports a complete block either way — which is why "closed" is the caller's
                // fact and not the node's.
                closed={!streaming}
                {...(highlightOptions === undefined ? {} : { highlightOptions })}
              />
            );
          },

          // Reached only for *inline* code now, because a fenced block's `code` never renders:
          // its `pre` parent replaced the whole subtree above.
          code: ({ children }) => (
            <code
              data-zoc-inline-code=""
              className="rounded-[3px] px-1 py-px font-mono"
              style={{
                background: "var(--zoc-row-bg)",
                color: "var(--zoc-text-secondary)",
                fontSize: "var(--zoc-text-body)",
              }}
            >
              {children}
            </code>
          ),

          a: ({ href, children }) => {
            const safe = safeHref(href);
            if (safe === undefined) {
              // Rendered as its own text rather than dropped: the label is content the model
              // wrote, and a link the surface refuses to make navigable should still read.
              return <span data-zoc-unsafe-link="">{children}</span>;
            }
            return (
              <a
                href={safe}
                // `noreferrer` implies `noopener`; both are stated because the pair is the
                // convention a reviewer looks for.
                rel="noopener noreferrer nofollow"
                target="_blank"
                style={{ color: "var(--zoc-agent)" }}
              >
                {children}
              </a>
            );
          },

          img: ({ alt, src }) => {
            // **No remote request from model output**, which is R8.6's `src`-origin clause
            // read strictly: an `img` whose URL the model chose is an outbound request the
            // user did not ask for and a tracking pixel by default. The alt text renders
            // instead, so the content survives and the request does not.
            void src;
            return (
              <span data-zoc-image-placeholder="" style={{ color: "var(--zoc-text-faint)" }}>
                {alt !== undefined && alt.length > 0 ? `[image: ${alt}]` : "[image]"}
              </span>
            );
          },
        }}
      >
        {source}
      </Markdown>
    </div>
  );
});

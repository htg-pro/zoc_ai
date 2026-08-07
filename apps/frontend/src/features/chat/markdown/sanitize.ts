/**
 * The one sanitiser pass for rendered model output — zoc-agent-chat-rebuild R8.6.
 *
 * Feature: zoc-agent-chat-rebuild, R8.6.
 *
 * Two layers stand between a model's text and the DOM, and this is the second:
 *
 *   1. `react-markdown` runs with `skipHtml` (its default — no `rehype-raw`), so raw HTML in
 *      model output is **dropped at parse time** rather than sanitised after the fact. That
 *      is the layer that matters, because nothing reaches the DOM to be cleaned.
 *   2. This pass, over anything that is inserted as markup rather than as text: the
 *      `monaco.editor.colorize` output for a fenced block. `colorize` returns HTML, so its
 *      result is the one string in the surface that is set rather than rendered — and R8.6
 *      asks for defence in depth precisely because a single-layer argument is one library
 *      default away from being wrong.
 *
 * **The allowlist is narrow because the input is narrow.** `colorize` emits `span`s carrying
 * `class` and inline `color`, `br`, and text — nothing else. Allowing what markdown might
 * need would widen the surface for a string that never contains markdown. Anything the
 * profile does not name is stripped, so a `colorize` release that started emitting an anchor
 * would lose the anchor rather than gain an attack surface.
 */

import DOMPurify from "dompurify";

/**
 * Tags `monaco.editor.colorize` produces. Deliberately not "tags code might use".
 *
 * `div` is present because `colorize` wraps each line in one; `span` carries the token
 * classes; `br` appears in the single-line form.
 */
const ALLOWED_TAGS = ["span", "div", "br"] as const;

/**
 * `class` for the theme's token rules, `style` for the inline colours `colorize` emits when
 * a theme is not registered. No `id`, no `data-*`, and above all no event handler — the
 * profile is what makes "no attribute whose name begins with `on`" structural rather than a
 * regex somebody has to maintain.
 */
const ALLOWED_ATTR = ["class", "style"] as const;

/**
 * Sanitise a fragment of highlighter output.
 *
 * `RETURN_TRUSTED_TYPE` is deliberately off: the result is handed to React's
 * `dangerouslySetInnerHTML`, which takes a string, and asking for a `TrustedHTML` here would
 * only convert it back.
 */
export function sanitizeHighlightHtml(html: string): string {
  return DOMPurify.sanitize(html, {
    ALLOWED_TAGS: [...ALLOWED_TAGS],
    ALLOWED_ATTR: [...ALLOWED_ATTR],
    // A comment cannot execute, but it can carry the payload of a mutation-XSS gadget, and
    // nothing in highlighter output needs one.
    ALLOW_DATA_ATTR: false,
    KEEP_CONTENT: true,
  });
}

/**
 * Whether a URL from model output may be linked.
 *
 * R8.6's clause about `javascript:` URLs, expressed as an allowlist of schemes rather than a
 * denylist of one: `data:`, `vbscript:`, and `blob:` are all navigable in some context, and a
 * denylist would have to enumerate them correctly forever. A relative URL is permitted —
 * `react-markdown` resolves it against the document, and the document is the app's own.
 */
export function isSafeUrl(href: string): boolean {
  const trimmed = href.trim();
  if (trimmed.length === 0) return false;
  // A scheme-relative or absolute-path URL has no scheme to check.
  if (trimmed.startsWith("/") || trimmed.startsWith("#") || trimmed.startsWith("?")) return true;

  try {
    // A relative URL parses against the base and yields the base's own scheme, which is how
    // `./notes.md` is permitted without a special case.
    const parsed = new URL(trimmed, "https://zoc.invalid/");
    return (
      parsed.protocol === "https:" || parsed.protocol === "http:" || parsed.protocol === "mailto:"
    );
  } catch {
    // Unparseable is not linkable.
    return false;
  }
}

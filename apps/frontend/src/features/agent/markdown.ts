/**
 * Minimal markdown model for assistant answers (§12.1).
 *
 * Ask Mode answers arrive as streaming markdown and need to render headers,
 * bold, inline code, links and fenced code blocks — the last of which get
 * "Copy" and "Insert at cursor" affordances, so they must be identified as
 * *structured blocks* rather than styled text.
 *
 * This is a deliberately small hand-rolled parser rather than a markdown
 * library: the renderer only needs the handful of constructs above, and parsing
 * here (a) keeps the streaming path free of a heavy dependency and (b) means no
 * raw HTML is ever produced, so there is no `dangerouslySetInnerHTML` and no XSS
 * surface for model output.
 */

export type MarkdownBlock =
  | { kind: "code"; language: string | null; code: string; closed: boolean }
  | { kind: "text"; text: string };

/** Inline spans within a text block. */
export type InlineSpan =
  | { kind: "plain"; text: string }
  | { kind: "code"; text: string }
  | { kind: "bold"; text: string }
  | { kind: "italic"; text: string }
  | { kind: "path"; text: string };

const FENCE_RE = /^\s*```([\w+-]*)\s*$/;

/**
 * Split markdown into text and fenced-code blocks.
 *
 * An unterminated fence (the common case mid-stream) yields a `code` block with
 * `closed: false`, so a partially streamed snippet renders as code immediately
 * instead of flickering from prose into code when the closing fence arrives.
 */
export function splitMarkdownBlocks(markdown: string): MarkdownBlock[] {
  const blocks: MarkdownBlock[] = [];
  const lines = markdown.split("\n");
  let buffer: string[] = [];
  let codeLines: string[] | null = null;
  let language: string | null = null;

  const flushText = () => {
    if (buffer.length === 0) return;
    const text = buffer.join("\n");
    if (text.trim()) blocks.push({ kind: "text", text });
    buffer = [];
  };

  for (const line of lines) {
    const fence = FENCE_RE.exec(line);
    if (fence) {
      if (codeLines === null) {
        flushText();
        codeLines = [];
        language = fence[1] ? fence[1].toLowerCase() : null;
      } else {
        blocks.push({
          kind: "code",
          language,
          code: codeLines.join("\n"),
          closed: true,
        });
        codeLines = null;
        language = null;
      }
      continue;
    }
    if (codeLines !== null) codeLines.push(line);
    else buffer.push(line);
  }

  if (codeLines !== null) {
    blocks.push({ kind: "code", language, code: codeLines.join("\n"), closed: false });
  } else {
    flushText();
  }
  return blocks;
}

/** Heading level (1–6) of a markdown line, or 0 when it is not a heading. */
export function headingLevel(line: string): number {
  const match = /^(#{1,6})\s+/.exec(line);
  return match ? match[1].length : 0;
}

/** Strip the leading `#`s from a heading line. */
export function headingText(line: string): string {
  return line.replace(/^#{1,6}\s+/, "").trim();
}

/**
 * Whether `token` looks like a workspace file path worth linking (§12.1).
 *
 * Conservative on purpose: it must contain a path separator or a known source
 * extension, so ordinary prose (`e.g.`, `1.5`) is not turned into dead links.
 */
const PATHISH_RE =
  /^[\w./\\@-]*[\w-]+\.(?:ts|tsx|js|jsx|py|rs|go|json|md|toml|yaml|yml|css|html|sh|sql)$/i;

export function looksLikePath(token: string): boolean {
  const cleaned = normalizePathToken(token);
  if (!cleaned || cleaned.length > 200) return false;
  if (cleaned.includes(" ")) return false;
  if (!PATHISH_RE.test(cleaned)) return false;
  // Without a directory separator the token is just `word.ext`, which also
  // describes prose like "Node.js" or "Vue.js". Require a conventional
  // (lower-case) file stem in that case so product names stay plain text.
  if (!/[/\\]/.test(cleaned)) {
    const stem = cleaned.slice(0, cleaned.lastIndexOf("."));
    return /^[a-z0-9._-]+$/.test(stem);
  }
  return true;
}

/** Trim trailing punctuation so a path at the end of a sentence still resolves. */
export function normalizePathToken(token: string): string {
  return token.replace(/[.,;:)\]}'"]+$/, "");
}

const INLINE_RE = /(`[^`]+`|\*\*[^*]+\*\*|\*[^*]+\*|_[^_]+_)/g;

/**
 * Split one line of prose into inline spans.
 *
 * Runs the delimiter pass first, then scans the remaining plain runs for
 * path-like tokens, so a path inside backticks stays code (the author's intent)
 * and a bare path in prose becomes a link.
 */
export function splitInline(line: string): InlineSpan[] {
  const spans: InlineSpan[] = [];
  let index = 0;

  const pushPlainWithPaths = (text: string) => {
    if (!text) return;
    // Keep whitespace so the rendered line preserves spacing.
    for (const piece of text.split(/(\s+)/)) {
      if (!piece) continue;
      if (looksLikePath(piece)) spans.push({ kind: "path", text: piece });
      else spans.push({ kind: "plain", text: piece });
    }
  };

  for (const match of line.matchAll(INLINE_RE)) {
    const start = match.index ?? 0;
    pushPlainWithPaths(line.slice(index, start));
    const token = match[0];
    if (token.startsWith("`")) {
      spans.push({ kind: "code", text: token.slice(1, -1) });
    } else if (token.startsWith("**")) {
      spans.push({ kind: "bold", text: token.slice(2, -2) });
    } else {
      spans.push({ kind: "italic", text: token.slice(1, -1) });
    }
    index = start + token.length;
  }
  pushPlainWithPaths(line.slice(index));
  return spans;
}

/** Prefix used by the "Follow-up" affordance (§12.1). */
export const FOLLOW_UP_PREFIX = "Regarding your previous answer: ";

/**
 * Terminal output parser (Part 6.2, pure/dependency-free).
 *
 * Scans PTY output lines and returns interactive annotations (clickable file
 * paths, URLs, error-stack lines, and test-result summaries) with character
 * offsets, without mutating the raw text. The React overlay renders these on
 * top of xterm; this module is just the detection algebra.
 */
export interface PathAnnotation {
  type: "path";
  start: number;
  end: number;
  raw: string;
  path: string;
  line?: number;
  column?: number;
}
export interface UrlAnnotation {
  type: "url";
  start: number;
  end: number;
  raw: string;
  url: string;
}
export interface StackAnnotation {
  type: "stack";
  start: number;
  end: number;
  raw: string;
}
export interface TestSummaryAnnotation {
  type: "test-summary";
  start: number;
  end: number;
  raw: string;
  passed: number;
  failed: number;
  skipped: number;
}

export type Annotation = PathAnnotation | UrlAnnotation | StackAnnotation | TestSummaryAnnotation;

export interface ParsedLine {
  text: string;
  annotations: Annotation[];
}

const URL_RE = /https?:\/\/[^\s'")<>]+/g;
// A path token: optional ./ or ../ prefix, path chars, a dotted extension, and
// an optional :line[:col] suffix.
const PATH_RE =
  /(?:[A-Za-z]:[\\/]|\.{0,2}[\\/])?(?:[\w.-]+[\\/])*[\w.-]+\.[A-Za-z][\w]*(?::\d+(?::\d+)?)?/g;
const STACK_RE = /^\s*(?:at\s|File\s+"|Traceback(?:\s|$))/;

function count(line: string, keyword: string): number {
  const m = line.match(new RegExp(`(\\d+)\\s+${keyword}`, "i"));
  return m ? Number.parseInt(m[1], 10) : 0;
}

/** Parse a pytest / jest / cargo summary line, or `null` when it isn't one. */
export function parseTestSummary(
  line: string,
): { passed: number; failed: number; skipped: number } | null {
  if (!/\d+\s+(?:passed|failed)/i.test(line)) return null;
  return {
    passed: count(line, "passed"),
    failed: count(line, "failed"),
    skipped: count(line, "skipped") || count(line, "ignored"),
  };
}

function parsePathToken(token: string): { path: string; line?: number; column?: number } {
  const match = token.match(/^(.*\.[A-Za-z][\w]*)(?::(\d+))?(?::(\d+))?$/);
  if (!match) return { path: token };
  return {
    path: match[1],
    line: match[2] === undefined ? undefined : Number(match[2]),
    column: match[3] === undefined ? undefined : Number(match[3]),
  };
}

/** Annotate one line. Stack / test-summary lines are single whole-line
 *  annotations; otherwise URLs (matched first) and file paths are extracted as
 *  non-overlapping, offset-sorted annotations. */
export function parseTerminalLine(line: string): Annotation[] {
  if (STACK_RE.test(line)) {
    return [{ type: "stack", start: 0, end: line.length, raw: line }];
  }
  const summary = parseTestSummary(line);
  if (summary) {
    return [{ type: "test-summary", start: 0, end: line.length, raw: line, ...summary }];
  }

  const annotations: Annotation[] = [];
  const claimed: Array<[number, number]> = [];
  const overlaps = (s: number, e: number): boolean => claimed.some(([cs, ce]) => s < ce && cs < e);

  for (const m of line.matchAll(URL_RE)) {
    const raw = m[0].replace(/[.,;:!?]+$/, "");
    const start = m.index ?? 0;
    const end = start + raw.length;
    annotations.push({ type: "url", start, end, raw, url: raw });
    claimed.push([start, end]);
  }
  for (const m of line.matchAll(PATH_RE)) {
    const start = m.index ?? 0;
    const end = start + m[0].length;
    if (overlaps(start, end)) continue; // don't relabel a URL's path segment
    annotations.push({ type: "path", start, end, raw: m[0], ...parsePathToken(m[0]) });
    claimed.push([start, end]);
  }
  return annotations.sort((x, y) => x.start - y.start);
}

/** Annotate a multi-line chunk (split on `\n`). */
export function parseTerminalOutput(text: string): ParsedLine[] {
  return text.split("\n").map((line) => ({ text: line, annotations: parseTerminalLine(line) }));
}

/** Reduce a carriage-return progress line to its final overwritten segment. */
export function collapseCarriageReturns(line: string): string {
  const idx = line.lastIndexOf("\r");
  return idx === -1 ? line : line.slice(idx + 1);
}

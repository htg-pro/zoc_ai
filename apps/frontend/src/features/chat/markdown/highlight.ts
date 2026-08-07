/**
 * Syntax highlighting for a settled fence — zoc-agent-chat-rebuild R5.6, R8.5.
 *
 * Feature: zoc-agent-chat-rebuild, R5.6, R8.5.
 *
 * `monaco.editor.colorize(code, languageId, options)` returns highlighted HTML without an
 * editor instance, using the tokenizer and theme already shipped for the editor pane. Shiki
 * was rejected for exactly this reason: it would ship a second TextMate grammar set beside
 * Monaco's, which is the duplication R5.6 forbids (design.md:371).
 *
 * ## Two rules about *when*, and both are performance decisions
 *
 * **Never mid-stream.** Highlighting is requested only once a fence has closed. Re-tokenising
 * a growing block on every delta is the single most expensive thing the surface could do —
 * at R20.3's 40 parts per second, a 200-line block would be re-tokenised 40 times a second
 * against a 50 ms main-thread budget. While streaming, the body renders as plain mono text
 * and is highlighted in place when the fence completes.
 *
 * **In an idle callback.** Even a settled block is tokenised off the critical path, because a
 * Run that ends with six code blocks would otherwise tokenise all six in the commit that
 * renders the terminal row — the frame the user is most likely to be watching.
 *
 * ## Monaco is loaded lazily, and a failure is not an error
 *
 * The import is dynamic so a transcript with no code blocks never pulls the editor bundle.
 * If it fails — offline, a chunk error, a jsdom test with no Monaco at all — the caller keeps
 * the plain-text body. Unhighlighted code is completely readable; a thrown error in a
 * transcript row is not, and R8.5 asks for a language label and a copy control, neither of
 * which depends on this.
 */

import { sanitizeHighlightHtml } from "./sanitize";

/** The subset of Monaco this module touches, so no Monaco type reaches the view layer. */
interface ColorizeCapableMonaco {
  editor: {
    colorize(text: string, languageId: string, options: { tabSize?: number }): Promise<string>;
  };
}

/** Result of a highlight attempt. `null` means "render the plain body". */
export type HighlightResult = string | null;

/**
 * Language ids Monaco knows under a different name than the fence's info string.
 *
 * Only the aliases a model actually writes. A fence tagged with something Monaco has never
 * heard of colorizes as plain text rather than throwing, so an exhaustive table would be
 * work for no behavioural gain.
 */
const LANGUAGE_ALIASES: Readonly<Record<string, string>> = {
  ts: "typescript",
  tsx: "typescript",
  js: "javascript",
  jsx: "javascript",
  py: "python",
  rs: "rust",
  sh: "shell",
  bash: "shell",
  zsh: "shell",
  yml: "yaml",
  md: "markdown",
  "c++": "cpp",
  "objective-c": "objective-c",
  golang: "go",
};

/** The Monaco language id for a fence's info string, or `plaintext`. */
export function monacoLanguageId(language: string): string {
  const normalised = language.trim().toLowerCase();
  if (normalised.length === 0) return "plaintext";
  return LANGUAGE_ALIASES[normalised] ?? normalised;
}

/**
 * Longest block this module will tokenise.
 *
 * A model asked to print a large file can emit thousands of lines, and `colorize` is
 * synchronous inside its promise — a 10,000-line block would block the main thread for far
 * longer than R20.3's 50 ms budget however idle the callback was. Past the ceiling the plain
 * body is kept, which is the same outcome as a highlighter failure and equally readable.
 */
export const MAX_HIGHLIGHT_CHARS = 100_000;

/** Injected in tests; production dynamically imports the editor bundle. */
export type MonacoLoader = () => Promise<ColorizeCapableMonaco>;

const loadMonaco: MonacoLoader = async () => {
  // `monaco-editor` is aliased to `@codingame/monaco-vscode-editor-api` in this workspace, so
  // the specifier is the alias rather than the upstream package.
  const module = (await import("monaco-editor")) as unknown as ColorizeCapableMonaco;
  return module;
};

export interface HighlightOptions {
  readonly loader?: MonacoLoader;
  readonly tabSize?: number;
}

/**
 * Highlight one settled block, or answer `null`.
 *
 * Never throws. Every failure path — an oversized block, a Monaco that would not load, a
 * `colorize` that rejected — returns `null`, because the caller's fallback is the plain body
 * and a highlighter is not a thing a transcript row may fail on.
 */
export async function highlightBlock(
  code: string,
  language: string,
  options: HighlightOptions = {},
): Promise<HighlightResult> {
  if (code.length === 0 || code.length > MAX_HIGHLIGHT_CHARS) return null;

  try {
    const monaco = await (options.loader ?? loadMonaco)();
    const html = await monaco.editor.colorize(code, monacoLanguageId(language), {
      tabSize: options.tabSize ?? 2,
    });
    // The one string in the surface that is inserted as markup rather than rendered as text,
    // so it is the one that must be sanitised (R8.6).
    return sanitizeHighlightHtml(html);
  } catch {
    return null;
  }
}

/**
 * Run `work` when the browser is idle, or on a timer where it cannot be.
 *
 * `requestIdleCallback` is unavailable in Safari and in jsdom, and a highlight that simply
 * never ran there would be a silent per-browser difference. The `setTimeout` fallback runs the
 * same work one macrotask later — off the commit that rendered the row, which is the property
 * that matters — rather than not at all.
 *
 * Returns a canceller, so a row unmounted before its callback fires does not tokenise a block
 * nobody is looking at.
 */
export function whenIdle(work: () => void, timeoutMs = 200): () => void {
  const scope = globalThis as {
    requestIdleCallback?: (callback: () => void, options?: { timeout: number }) => number;
    cancelIdleCallback?: (handle: number) => void;
  };

  if (typeof scope.requestIdleCallback === "function") {
    const handle = scope.requestIdleCallback(work, { timeout: timeoutMs });
    return () => scope.cancelIdleCallback?.(handle);
  }

  const timer = globalThis.setTimeout(work, 0);
  return () => {
    globalThis.clearTimeout(timer);
  };
}

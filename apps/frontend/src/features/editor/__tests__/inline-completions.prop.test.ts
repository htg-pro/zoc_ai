// Feature: editor-diagnostics-completions, Property 7: Debounce collapses a keystroke burst to one trailing request
// Feature: editor-diagnostics-completions, Property 8: Request payload is bounded to the cursor window
// Feature: editor-diagnostics-completions, Property 9: Cancelled or superseded responses never render
// Feature: editor-diagnostics-completions, Property 10: Ghost text equals the ordered concatenation of received tokens; empty renders nothing
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fc from "fast-check";
import type { CompletionRequestBody } from "@/lib/completions-client";
import {
  DEFAULT_DEBOUNCE_MS,
  DEFAULT_MAX_PREFIX,
  DEFAULT_MAX_SUFFIX,
  buildCursorWindow,
  createInlineCompletionController,
} from "../inline-completions";

const win = (prefix: string, suffix: string): CompletionRequestBody => ({
  prefix,
  suffix,
  language: "python",
  filePath: "/f.py",
});

describe("inline-completions debounce (Property 7)", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("Property 7: a keystroke burst collapses to exactly one trailing request", () => {
    fc.assert(
      fc.property(
        // Inter-keystroke gaps strictly below the debounce window.
        fc.array(fc.integer({ min: 1, max: DEFAULT_DEBOUNCE_MS - 1 }), { minLength: 1, maxLength: 12 }),
        (gaps) => {
          const stream = vi.fn(async () => {});
          const c = createInlineCompletionController({ streamCompletion: stream });

          c.request(win("x", ""), { automatic: true });
          for (const gap of gaps) {
            vi.advanceTimersByTime(gap); // < 400ms: no fire yet
            expect(stream).not.toHaveBeenCalled();
            c.request(win("x", ""), { automatic: true }); // R8.3: restarts the timer
          }
          // No request has fired for any sub-400ms interval.
          expect(stream).not.toHaveBeenCalled();
          vi.advanceTimersByTime(DEFAULT_DEBOUNCE_MS); // 400ms of quiet
          expect(stream).toHaveBeenCalledTimes(1); // R8.2: exactly one trailing request
          c.dispose();
        },
      ),
      { numRuns: 150 },
    );
  });

  it("Property 7: an automatic trigger with both prefix and suffix empty makes no request", () => {
    const stream = vi.fn(async () => {});
    const c = createInlineCompletionController({ streamCompletion: stream });
    c.request(win("", ""), { automatic: true });
    vi.advanceTimersByTime(DEFAULT_DEBOUNCE_MS * 2);
    expect(stream).not.toHaveBeenCalled(); // R8.4
    c.dispose();
  });
});

describe("inline-completions cursor window (Property 8)", () => {
  it("Property 8: prefix ≤500 before, suffix ≤200 after, plus language and path", () => {
    fc.assert(
      fc.property(
        fc.string({ maxLength: 1500 }),
        fc.nat(),
        fc.string({ maxLength: 12 }),
        fc.string({ maxLength: 40 }),
        (text, rawOffset, language, filePath) => {
          const offset = Math.min(rawOffset, text.length);
          const body = buildCursorWindow(text, offset, language, filePath);

          const expectedPrefix = text.slice(Math.max(0, offset - DEFAULT_MAX_PREFIX), offset);
          const expectedSuffix = text.slice(offset, offset + DEFAULT_MAX_SUFFIX);
          expect(body.prefix).toBe(expectedPrefix);
          expect(body.suffix).toBe(expectedSuffix);
          expect(body.prefix.length).toBeLessThanOrEqual(DEFAULT_MAX_PREFIX);
          expect(body.suffix.length).toBeLessThanOrEqual(DEFAULT_MAX_SUFFIX);
          expect(body.language).toBe(language);
          expect(body.filePath).toBe(filePath);
        },
      ),
      { numRuns: 200 },
    );
  });
});

interface Captured {
  onToken: (chunk: string) => void;
  signal: AbortSignal;
}

describe("inline-completions cancellation/stale discard (Property 9)", () => {
  it("Property 9: a superseded request is aborted and its late chunks never render", () => {
    fc.assert(
      fc.property(
        fc.array(fc.string({ minLength: 1, maxLength: 5 }), { minLength: 1, maxLength: 6 }),
        fc.string({ minLength: 1, maxLength: 5 }),
        (staleChunks, liveChunk) => {
          const calls: Captured[] = [];
          const stream = vi.fn((_body: CompletionRequestBody, onToken: (c: string) => void, signal: AbortSignal) => {
            calls.push({ onToken, signal });
            return new Promise<void>(() => {}); // never resolves on its own
          });
          const c = createInlineCompletionController({ streamCompletion: stream });

          c.request(win("a", ""), { automatic: false }); // request A
          c.request(win("ab", ""), { automatic: false }); // request B supersedes A (R9.2)

          expect(calls[0].signal.aborted).toBe(true); // A aborted
          // R9.3: A's late chunks are dropped and never grow the ghost text.
          for (const ch of staleChunks) calls[0].onToken(ch);
          expect(c.currentText()).toBe("");

          // B's chunk applies to the current request.
          calls[1].onToken(liveChunk);
          expect(c.currentText()).toBe(liveChunk);
          c.dispose();
        },
      ),
      { numRuns: 200 },
    );
  });
});

describe("inline-completions ghost accumulation (Property 10)", () => {
  it("Property 10: ghost text equals the ordered concatenation of tokens; empty renders nothing", () => {
    fc.assert(
      fc.property(fc.array(fc.string({ maxLength: 6 }), { maxLength: 20 }), (chunks) => {
        const updates: string[] = [];
        const stream = async (
          _body: CompletionRequestBody,
          onToken: (c: string) => void,
        ): Promise<void> => {
          for (const ch of chunks) onToken(ch);
        };
        const c = createInlineCompletionController({
          streamCompletion: stream,
          onUpdate: (t) => updates.push(t),
        });
        c.request(win("x", ""), { automatic: false });

        // Non-empty chunks are the only ones that carry text; the ghost text is
        // their ordered concatenation.
        expect(c.currentText()).toBe(chunks.join(""));
        if (chunks.join("") === "") {
          // Empty completion → nothing to show (R10.2/R16.3).
          expect(c.currentText()).toBe("");
        }
        c.dispose();
      }),
      { numRuns: 200 },
    );
  });
});

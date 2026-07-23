/**
 * Inline AI completions provider (§3.3, Requirements 8–10, 16).
 *
 * Implements a Monaco `InlineCompletionsProvider` backed by the streaming
 * completions client. The universally-quantified behavior lives in small,
 * injectable, pure-ish helpers so it is unit- and property-testable without a
 * live Monaco editor:
 *
 * - {@link buildCursorWindow} — the ≤500-char prefix / ≤200-char suffix payload
 *   (Property 8).
 * - {@link createInlineCompletionController} — the 400 ms debounce, the
 *   both-empty automatic gate, the `AbortController` + monotonic `requestSeq`
 *   cancellation/stale-discard, and the ordered ghost-text accumulation
 *   (Properties 7, 9, 10).
 *
 * The Monaco adapter ({@link createInlineCompletionsProvider}) wires those into
 * a provider object and registers it; Tab-to-accept and type-to-dismiss are
 * Monaco's native inline-suggest behaviors (R10.3/R10.4).
 */

import type { CompletionRequestBody } from "@/lib/completions-client";

export const DEFAULT_DEBOUNCE_MS = 400; // R8.2
export const DEFAULT_MAX_PREFIX = 500; // R9.1
export const DEFAULT_MAX_SUFFIX = 200; // R9.1

/** R9.1: the bounded cursor-window request payload. */
export function buildCursorWindow(
  text: string,
  cursorOffset: number,
  language: string,
  filePath: string,
  maxPrefix: number = DEFAULT_MAX_PREFIX,
  maxSuffix: number = DEFAULT_MAX_SUFFIX,
): CompletionRequestBody {
  const offset = Math.max(0, Math.min(cursorOffset, text.length));
  const prefix = text.slice(Math.max(0, offset - maxPrefix), offset);
  const suffix = text.slice(offset, offset + maxSuffix);
  return { prefix, suffix, language, filePath };
}

/** R8.4: an automatic trigger with both prefix and suffix empty makes no request. */
export function hasNonEmptyContext(body: {
  prefix: string;
  suffix: string;
}): boolean {
  return body.prefix.length > 0 || body.suffix.length > 0;
}

// Injectable timers so Property 7 can drive the debounce with Vitest fake timers.
export interface TimerApi {
  setTimeout: (fn: () => void, ms: number) => number;
  clearTimeout: (handle: number) => void;
}

const REAL_TIMERS: TimerApi = {
  setTimeout: (fn, ms) => globalThis.setTimeout(fn, ms) as unknown as number,
  clearTimeout: (handle) => globalThis.clearTimeout(handle),
};

export type StreamCompletionFn = (
  body: CompletionRequestBody,
  onToken: (chunk: string) => void,
  signal: AbortSignal,
) => Promise<void>;

export interface InlineCompletionControllerDeps {
  streamCompletion: StreamCompletionFn;
  /** Called whenever the ghost text for the current request changes. */
  onUpdate?: (text: string) => void;
  debounceMs?: number;
  timers?: TimerApi;
}

export interface RequestOptions {
  /** An automatic (debounced) trigger vs. an explicit invoke that bypasses the
   *  debounce and the both-empty gate. */
  automatic: boolean;
}

/**
 * The debounce + cancellation + accumulation core (Properties 7, 9, 10).
 *
 * `request(window, { automatic })`:
 * - automatic: (re)starts a `debounceMs` timer; a further call restarts it and
 *   cancels the pending fire, so a keystroke burst collapses to one trailing
 *   request (R8.2/R8.3). If both prefix and suffix are empty, no request is made
 *   (R8.4).
 * - explicit: fires immediately, bypassing the debounce and the empty gate.
 *
 * On fire it increments a monotonic `requestSeq`, aborts any in-flight request
 * (R9.2), and streams tokens into a per-request buffer. A token that arrives for
 * a superseded/aborted `requestSeq` is dropped and never grows the ghost text
 * (R9.3). The ghost text is the ordered concatenation of the current request's
 * tokens; an empty completion yields the empty string (R10.2/R16.3).
 */
export interface InlineCompletionController {
  request(window: CompletionRequestBody, options: RequestOptions): void;
  /** The ghost text accumulated for the current request. */
  currentText(): string;
  /** The current request sequence (for adapters/tests). */
  currentSeq(): number;
  /** Abort any in-flight request and cancel any pending debounce. */
  cancel(): void;
  dispose(): void;
}

export function createInlineCompletionController(
  deps: InlineCompletionControllerDeps,
): InlineCompletionController {
  const debounceMs = deps.debounceMs ?? DEFAULT_DEBOUNCE_MS;
  const timers = deps.timers ?? REAL_TIMERS;

  let seq = 0;
  let text = "";
  let controller: AbortController | null = null;
  let debounceHandle: number | null = null;

  const clearDebounce = (): void => {
    if (debounceHandle !== null) {
      timers.clearTimeout(debounceHandle);
      debounceHandle = null;
    }
  };

  const abortInflight = (): void => {
    if (controller) {
      controller.abort();
      controller = null;
    }
  };

  const dispatch = (window: CompletionRequestBody): void => {
    abortInflight();
    const mySeq = ++seq;
    text = "";
    deps.onUpdate?.(text);
    const myController = new AbortController();
    controller = myController;

    const onToken = (chunk: string): void => {
      // R9.3: drop chunks from a superseded/aborted request.
      if (mySeq !== seq || myController.signal.aborted) return;
      text += chunk; // R10.2: ordered accumulation.
      deps.onUpdate?.(text);
    };

    void Promise.resolve(deps.streamCompletion(window, onToken, myController.signal))
      .catch(() => undefined) // R16.3: quiet failure.
      .finally(() => {
        if (mySeq === seq) controller = null;
      });
  };

  return {
    request(window, options) {
      if (options.automatic) {
        // R8.4: both-empty automatic trigger → no request.
        if (!hasNonEmptyContext(window)) return;
        // R8.3: restart the debounce; the interrupted interval fires nothing.
        clearDebounce();
        debounceHandle = timers.setTimeout(() => {
          debounceHandle = null;
          dispatch(window); // R8.2: one request 400 ms after the last keystroke.
        }, debounceMs);
        return;
      }
      // Explicit invoke bypasses the debounce and the empty gate.
      clearDebounce();
      dispatch(window);
    },
    currentText: () => text,
    currentSeq: () => seq,
    cancel() {
      clearDebounce();
      abortInflight();
    },
    dispose() {
      clearDebounce();
      abortInflight();
    },
  };
}

// ── Monaco adapter ──────────────────────────────────────────────────────────

// Loosely-typed Monaco surface — only the members we touch, so this module has
// no hard dependency on monaco's types.
interface MonacoModelLike {
  getValue(): string;
  getOffsetAt(position: unknown): number;
  getLanguageId?: () => string;
  uri?: { path?: string; toString(): string };
}

interface MonacoInlinePosition {
  lineNumber: number;
  column: number;
}

interface MonacoNamespaceLike {
  languages: {
    registerInlineCompletionsProvider: (
      selector: unknown,
      provider: unknown,
    ) => { dispose: () => void };
    InlineCompletionTriggerKind?: { Automatic?: number; Explicit?: number; Invoke?: number };
  };
}

export interface InlineCompletionsDeps {
  streamCompletion: StreamCompletionFn;
  debounceMs?: number;
  maxPrefix?: number;
  maxSuffix?: number;
  timers?: TimerApi;
  /** Optional re-trigger so streamed tokens grow the on-screen ghost text. */
  rerender?: () => void;
}

export interface RegisteredInlineProvider {
  provider: unknown;
  dispose(): void;
}

/**
 * Build and register the Monaco inline-completions provider (R8.1). The
 * returned `provider.provideInlineCompletions` triggers the controller (which
 * debounces + streams) and returns the current ghost text as a single inline
 * completion item; an empty completion yields no items (R10.1/R16.3).
 */
export function createInlineCompletionsProvider(
  monaco: MonacoNamespaceLike,
  deps: InlineCompletionsDeps,
): RegisteredInlineProvider {
  const maxPrefix = deps.maxPrefix ?? DEFAULT_MAX_PREFIX;
  const maxSuffix = deps.maxSuffix ?? DEFAULT_MAX_SUFFIX;

  const controller = createInlineCompletionController({
    streamCompletion: deps.streamCompletion,
    debounceMs: deps.debounceMs,
    timers: deps.timers,
    onUpdate: () => deps.rerender?.(),
  });

  const explicitKind =
    monaco.languages.InlineCompletionTriggerKind?.Explicit ??
    monaco.languages.InlineCompletionTriggerKind?.Invoke;

  const provider = {
    provideInlineCompletions(
      model: MonacoModelLike,
      position: MonacoInlinePosition,
      context: { triggerKind?: number },
      _token: unknown,
    ): { items: Array<{ insertText: string }> } {
      const text = model.getValue();
      const offset = model.getOffsetAt(position);
      const language = model.getLanguageId?.() ?? "";
      const filePath = model.uri?.path ?? model.uri?.toString() ?? "";
      const window = buildCursorWindow(text, offset, language, filePath, maxPrefix, maxSuffix);

      const automatic =
        explicitKind === undefined ? true : context.triggerKind !== explicitKind;
      controller.request(window, { automatic });

      const ghost = controller.currentText();
      return { items: ghost ? [{ insertText: ghost }] : [] };
    },
    freeInlineCompletions(): void {
      /* nothing to free — items are plain objects */
    },
  };

  const registration = monaco.languages.registerInlineCompletionsProvider(
    { pattern: "**" },
    provider,
  );

  return {
    provider,
    dispose() {
      controller.dispose();
      registration.dispose();
    },
  };
}

/**
 * Token_Rate — zoc-agent-chat-rebuild R13.8, R13.9, R13.10, 9.9.
 *
 * Generated output tokens per second, measured **runtime-side** over the
 * **first-token → last-token** interval. Both halves of that are decisions the design
 * makes explicitly, and it records the two alternatives it rejected because either
 * would look like a simplification later:
 *
 *   - **Client-side timing of part arrival** measures the transport, not the model.
 *     SSE framing, 11.1's re-attach backoff, and 17.1's rAF coalescing all sit
 *     between the model and the clock, so the figure would move when the renderer
 *     changed.
 *   - **Starting the clock at dispatch** folds queueing and prompt processing into
 *     the denominator, which measures time-to-first-token — a real number, but budget
 *     20.1's number, not this one.
 *
 * **The numerator is the provider's count, not ours.** Deltas are counted as
 * characters over four while the answer streams, because the pill has to show
 * *something* before any usage is reported; {@link TokenRateMeter.reconcile} replaces
 * that estimate with the provider's own `outputTokens` as soon as a step finishes. So
 * the live figure is an approximation that converges, and the terminal figure on the
 * usage row is exact.
 *
 * **A `null` is not a zero.** `current()` answers `null` until there is both an
 * interval and a token count, and R13.12 makes that distinction load-bearing one
 * level up: the model picker lists a model with no recorded history with *no figure*
 * rather than with `0`, because zero tokens per second is a legible claim about a
 * model and it would be a false one.
 */

/** A monotonic clock. Wall-clock time can jump; a rate measured across a jump is a lie. */
export type Clock = () => number;

const defaultClock: Clock = () => performance.now();

/**
 * Characters per token, for the live estimate only.
 *
 * Four is the usual English-prose figure and it is wrong for code, for CJK, and for
 * every tokenizer in particular — which is why it is only ever the *pre-reconcile*
 * numerator. Running a real tokenizer per delta would put a CPU cost on the hot path
 * to improve a number that is about to be replaced by the provider's own.
 */
export const CHARS_PER_TOKEN = 4;

/** Decimal places on the reported rate. */
const PRECISION = 1;

export interface TokenRateOptions {
  readonly now?: Clock;
  /**
   * Whether to exclude the time a tool held the loop.
   *
   * **A refinement on a literal reading of "first-token → last-token", and the reason
   * is that a literal reading fabricates a number.** In an Agent Run with three tool
   * calls taking five seconds each, four seconds of generation spread across a
   * nineteen-second window reads as ~5 tok/s for a model doing 25 — and R13.8 exists
   * precisely because the panel used to display a hard-coded `"14 tok/s"`. Tool
   * execution is the same class of thing as the prompt processing the design already
   * excludes: time when the model is not generating.
   *
   * It is not a heuristic and there is no threshold. The stream says exactly when a
   * tool starts and stops — `tool-input-available` and its settlement — so the caller
   * brackets those with {@link TokenRateMeter.pause} and
   * {@link TokenRateMeter.resume}. Set false to measure the raw wall-clock span.
   */
  readonly excludeToolTime?: boolean;
}

export interface TokenRateMeter {
  /** A text or reasoning delta arrived. The first call starts the interval. */
  observeDelta(approxTokens: number, now?: number): void;
  /** Replace the approximation with the provider's own output-token count. */
  reconcile(providerOutputTokens: number): void;
  /** The model stopped generating — a tool holds the loop. */
  pause(now?: number): void;
  resume(now?: number): void;
  current(): number | null;
  /** Milliseconds counted as generation. Exposed so a test can assert the interval. */
  readonly activeMs: number;
}

class Meter implements TokenRateMeter {
  private readonly clock: Clock;
  private readonly excludeToolTime: boolean;

  /** When the current generating stretch began, or null while paused/not started. */
  private stretchStartedAtMs: number | null = null;
  /** Completed generating stretches, in milliseconds. */
  private settledMs = 0;
  /** The last delta's timestamp within the open stretch. */
  private lastDeltaAtMs: number | null = null;
  private estimatedTokens = 0;
  private reportedTokens: number | null = null;

  constructor(options: TokenRateOptions = {}) {
    this.clock = options.now ?? defaultClock;
    this.excludeToolTime = options.excludeToolTime ?? true;
  }

  /**
   * The interval, in milliseconds.
   *
   * Closed at the *last delta* rather than at "now", which is what makes the figure
   * stable after the answer ends: a rate whose denominator kept growing would decay
   * every time the pill re-read it, and the terminal figure on the usage row would
   * depend on when the row happened to be written.
   */
  get activeMs(): number {
    const open =
      this.stretchStartedAtMs !== null && this.lastDeltaAtMs !== null
        ? Math.max(0, this.lastDeltaAtMs - this.stretchStartedAtMs)
        : 0;
    return this.settledMs + open;
  }

  observeDelta(approxTokens: number, now?: number): void {
    const at = now ?? this.clock();
    // The first delta starts the interval. Everything before it — admission, the
    // Slot queue, prompt processing — is outside by construction, which is the
    // property the 2-second-TTFT guard test pins.
    if (this.stretchStartedAtMs === null) this.stretchStartedAtMs = at;
    this.lastDeltaAtMs = at;
    if (Number.isFinite(approxTokens) && approxTokens > 0) {
      this.estimatedTokens += approxTokens;
    }
  }

  /**
   * Adopt the provider's output-token count.
   *
   * Ignored when it is zero or absent, deliberately. A provider that streamed text and
   * then reported `outputTokens: 0` has omitted usage rather than generated nothing —
   * several do on streaming responses — and treating it as authoritative would blank
   * the rate for exactly those providers. A Run that genuinely generated nothing has
   * no deltas either, so it still answers `null` through the interval check below.
   */
  reconcile(providerOutputTokens: number): void {
    if (!Number.isFinite(providerOutputTokens) || providerOutputTokens <= 0) return;
    this.reportedTokens = providerOutputTokens;
  }

  pause(now?: number): void {
    if (!this.excludeToolTime) return;
    if (this.stretchStartedAtMs === null) return;
    const at = now ?? this.clock();
    // The stretch ends at the last delta, not at the pause: the gap between the model's
    // final token and the tool call starting is the loop's own latency, not generation.
    const end = this.lastDeltaAtMs ?? at;
    this.settledMs += Math.max(0, end - this.stretchStartedAtMs);
    this.stretchStartedAtMs = null;
    this.lastDeltaAtMs = null;
  }

  resume(_now?: number): void {
    // Nothing to do: the next delta opens the next stretch, so the time between the
    // tool settling and the model's next token is excluded too.
    void _now;
  }

  current(): number | null {
    const tokens = this.reportedTokens ?? this.estimatedTokens;
    const ms = this.activeMs;
    if (tokens <= 0 || ms <= 0) return null;
    const rate = (tokens * 1000) / ms;
    if (!Number.isFinite(rate)) return null;
    const factor = 10 ** PRECISION;
    return Math.round(rate * factor) / factor;
  }
}

export function createTokenRateMeter(options: TokenRateOptions = {}): TokenRateMeter {
  return new Meter(options);
}

/**
 * A meter that measures nothing, so `tokensPerSecond` stays honestly null.
 *
 * Not a degenerate case to be tidied away: compaction's summariser call and the title
 * route are provider calls that are not the answer stream, so their tokens must not
 * enter a rate that claims to describe how fast the answer arrived (R27.2).
 */
export function createNullTokenRateMeter(): TokenRateMeter {
  return {
    observeDelta: () => undefined,
    reconcile: () => undefined,
    pause: () => undefined,
    resume: () => undefined,
    current: () => null,
    activeMs: 0,
  };
}

/** Tokens a delta is worth, before the provider's own count replaces the estimate. */
export function estimateTokens(text: string): number {
  return text.length / CHARS_PER_TOKEN;
}

/**
 * The mean of a model's recorded benchmark runs, or `null` when it has none.
 *
 * `null` rather than `0` for R13.12's reason: the picker renders no figure at all for a
 * model nothing has been measured on, and a `0` would render as a claim.
 */
export function meanTokensPerSecond(
  rates: ReadonlyArray<number | null | undefined>,
): number | null {
  const usable = rates.filter(
    (rate): rate is number => typeof rate === "number" && Number.isFinite(rate) && rate > 0,
  );
  if (usable.length === 0) return null;
  const total = usable.reduce((sum, rate) => sum + rate, 0);
  const factor = 10 ** PRECISION;
  return Math.round((total / usable.length) * factor) / factor;
}

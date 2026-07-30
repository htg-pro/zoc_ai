/**
 * The Run driver — zoc-agent-chat-rebuild R7.7, R16.1, R16.3, 9.7.
 *
 * One object per Run, sitting between `streamRun`'s chunk stream and the
 * `RunRecord` that buffers and fans it out. It owns three things no other module
 * can own correctly:
 *
 *   - **The `seq` space.** One {@link SeqFraming} per Run, created here, so every
 *     chunk — the model's, the writers', and the cancellation's — draws from one
 *     allocator (R7.7).
 *   - **The cancel grace.** Abort, then 1500 ms for in-flight tools to settle,
 *     then close regardless (R16.1). The timer is the load-bearing part: a tool
 *     that ignores its `AbortSignal` cannot be interrupted, so the only way to
 *     meet a 2-second budget is to stop waiting for it.
 *   - **Which tools were in flight.** The driver sees every chunk, so it is the
 *     only place that knows which `toolCallId`s had started and not finished when
 *     the grace expired — and therefore the only place that can report them as
 *     abandoned instead of leaving them spinning in the transcript forever.
 *
 * **The stream is not cancelled on a forced close, deliberately.** After the
 * grace, framing is shut (`SeqFraming` drops and counts everything behind a
 * terminal lifecycle), but the read loop keeps draining. Cancelling the reader
 * would tear down the SDK stream before `onFinish` ran, and `onFinish` is where
 * R15.6 persists the partial message — the answer the user already read. So the
 * Run settles at 1500 ms while its abandoned stream drains quietly in the
 * background, and `droppedAfterClose` is what makes that observable.
 */

import type { ZocUIChunk } from "./build-agent.ts";
import {
  createRunWriter,
  createSeqFraming,
  type OutboundChunk,
  type RunWriter,
  type SeqFraming,
  type TerminalRunState,
} from "./writer.ts";
import { ErrorCode } from "../http/errors.ts";
import type { RunRecord, RunStore, SlotManager } from "./run-store.ts";

/** R16.1's grace, and design.md:1310's figure. */
export const CANCEL_GRACE_MS = 1500;

/** What an abandoned tool's error part says, and what it carries (design.md:1187). */
const ABANDONED_TOOL_MESSAGE =
  "This step was still running when the run was cancelled, so it was abandoned.";

/** What `open` is handed: the ids and the signal cancellation aborts. */
export interface RunStreamBinding {
  readonly runId: string;
  readonly messageId: string;
  readonly sessionId: string;
  /** `RunRecord.abort.signal` — the one `agent.stream()` must receive (R16.1). */
  readonly signal: AbortSignal;
}

export type OpenRunStream = (
  binding: RunStreamBinding,
) => ReadableStream<ZocUIChunk> | Promise<ReadableStream<ZocUIChunk>>;

export interface RunDriverOptions {
  readonly record: RunRecord;
  readonly messageId: string;
  /**
   * Opens the Run's chunk stream — normally `streamRun`.
   *
   * A thunk rather than a stream, because a queued Run must not dispatch: the
   * provider call, the history read, and the context assembly all belong after
   * admission, and handing the driver a live stream would have started all three
   * while the Run was still waiting for a Slot.
   */
  readonly open: OpenRunStream;
  readonly graceMs?: number;
  readonly now?: () => Date;
  /**
   * Where a driver-internal failure goes.
   *
   * Reported rather than thrown: `start()` is fire-and-forget from the route, so
   * a throw would surface as an unhandled rejection on a Run that still has to
   * reach a terminal state and release its Slot.
   */
  readonly onInternalError?: (error: unknown) => void;
}

export class RunDriver {
  readonly record: RunRecord;
  readonly messageId: string;
  /** Resolves with the state the Run settled in. Never rejects. */
  readonly settled: Promise<TerminalRunState>;

  private readonly framing: SeqFraming;
  private readonly writer: RunWriter;
  private readonly open: OpenRunStream;
  private readonly graceMs: number;
  private readonly now: () => Date;
  private readonly onInternalError: (error: unknown) => void;
  /** `toolCallId` → whether it has settled. Populated from the chunk stream. */
  private readonly inFlight = new Set<string>();
  private resolveSettled!: (state: TerminalRunState) => void;
  private settledState: TerminalRunState | null = null;
  private started = false;
  private cancelRequested = false;
  private graceTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(options: RunDriverOptions) {
    this.record = options.record;
    this.messageId = options.messageId;
    this.open = options.open;
    this.graceMs = options.graceMs ?? CANCEL_GRACE_MS;
    this.now = options.now ?? (() => new Date());
    this.onInternalError = options.onInternalError ?? (() => {});
    this.framing = createSeqFraming({ sink: this.record });
    // The forced-close writer. Bound to the same framing as the Run's own parts,
    // so a cancellation lifecycle is numbered in sequence with everything before
    // it rather than being a second, unnumbered channel.
    this.writer = createRunWriter({
      runId: this.record.runId,
      messageId: this.messageId,
      writer: { write: (chunk) => void this.framing.frame(chunk) },
      now: this.now,
    });
    this.settled = new Promise<TerminalRunState>((resolve) => {
      this.resolveSettled = resolve;
    });
  }

  get lastSeq(): number {
    return this.framing.lastSeq;
  }

  /** Chunks the framing refused because the Run had already closed. */
  get droppedAfterClose(): number {
    return this.framing.droppedAfterClose;
  }

  get isSettled(): boolean {
    return this.settledState !== null;
  }

  /**
   * Report that the Run is waiting for a Slot, with its place in the queue.
   *
   * Emitted as a part rather than returned in the `POST /v1/runs` body alone
   * because the position is the only thing the user can see while nothing is
   * happening, and it has to be able to change — a queue that reports `3` once and
   * then goes silent for a minute is indistinguishable from a runtime that hung.
   */
  announceQueued(position: number): void {
    if (this.started || this.isSettled) return;
    this.writer.lifecycle({
      state: "queued",
      queuePosition: position,
      provider: this.record.provider,
      model: this.record.model,
    });
  }

  /**
   * Open the stream and pump it. Idempotent, and never rejects.
   *
   * Returns when the underlying stream has drained, which is *not* the same moment
   * the Run settles: a forced close settles the Run at the grace and leaves this
   * draining. Callers that want the settle should await {@link settled}.
   */
  async start(): Promise<void> {
    if (this.started || this.isSettled) return;
    this.started = true;
    this.record.transitionTo("running");

    let reader: ReadableStreamDefaultReader<ZocUIChunk>;
    try {
      reader = (await this.open(this.binding())).getReader();
    } catch (error) {
      // `open` failing is a Run that never produced a chunk. It still needs a
      // terminal row, or the surface has a spinner with nothing behind it.
      this.onInternalError(error);
      this.failWithoutStream();
      return;
    }

    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        this.observe(value);
        this.framing.frame(value as OutboundChunk);
      }
    } catch (error) {
      this.onInternalError(error);
    }

    // `streamRun` writes its own terminal lifecycle, so by here the framing
    // normally knows the state. The fallbacks cover the two ways it might not: a
    // stream that ended without one, and a cancel whose grace already fired.
    this.settle(this.framing.terminalState ?? (this.cancelRequested ? "cancelled" : "completed"));
  }

  /**
   * Begin cancellation (R16.1). Returns immediately; the grace runs on a timer.
   *
   * Returning immediately is the contract `POST /v1/runs/:id/cancel` answers
   * `202 { accepted: true }` against: the caller is told the request was taken,
   * not that the Run has stopped, because the second can take up to the grace and
   * an HTTP request held open for it would be a request that times out on a slow
   * tool.
   */
  cancel(): boolean {
    if (this.isSettled) return false;
    if (this.cancelRequested) return true;
    this.cancelRequested = true;

    // The abort comes first so a tool that *does* honour its signal gets the whole
    // grace to unwind, rather than the grace minus whatever the timer setup costs.
    this.record.abort.abort();

    this.graceTimer = setTimeout(() => {
      this.graceTimer = null;
      this.forceClose();
    }, this.graceMs);
    // A pending timer must not be the reason the process outlives its work.
    this.graceTimer.unref?.();
    return true;
  }

  /**
   * Cancel a Run that never got a Slot.
   *
   * Separate from {@link cancel} because there is nothing to abort and nothing to
   * wait for: no stream was opened, so the grace would be 1500 ms of doing nothing
   * before writing the part that could be written now. `start()` is blocked
   * afterwards by the settled check, so a late promotion cannot revive it.
   */
  cancelBeforeStart(): boolean {
    if (this.isSettled) return false;
    this.cancelRequested = true;
    this.record.abort.abort();
    this.writer.lifecycle({
      state: "cancelled",
      code: ErrorCode.RUN_CANCELLED,
      message: "Run cancelled before it started.",
      provider: this.record.provider,
      model: this.record.model,
    });
    this.settle("cancelled");
    return true;
  }

  /** The ids and signal `open` is called with. */
  private binding(): RunStreamBinding {
    return {
      runId: this.record.runId,
      messageId: this.messageId,
      sessionId: this.record.sessionId,
      signal: this.record.abort.signal,
    };
  }

  /**
   * Note what a chunk means for the abandonment set.
   *
   * `tool-input-available` is the in-flight marker rather than `tool-input-start`:
   * the input is complete at that point, which is when `execute` runs. A call whose
   * input never completed never started, so reporting it as abandoned would invent
   * a step that never happened.
   */
  private observe(chunk: ZocUIChunk): void {
    const id = (chunk as { toolCallId?: unknown }).toolCallId;
    if (typeof id !== "string") return;
    switch (chunk.type) {
      case "tool-input-available":
        this.inFlight.add(id);
        return;
      case "tool-output-available":
        // A `preliminary` output is a progress report from a tool that is still
        // running (the SDK's streaming-tool path), so it is not a settlement.
        if ((chunk as { preliminary?: unknown }).preliminary !== true) {
          this.inFlight.delete(id);
        }
        return;
      case "tool-output-error":
      case "tool-output-denied":
      case "tool-input-error":
        this.inFlight.delete(id);
        return;
      default:
        return;
    }
  }

  /**
   * The grace expired: abandon what is still running and close the Run.
   *
   * Order is the contract. Every abandoned tool gets its error part *before* the
   * cancelled lifecycle, because `SeqFraming` shuts on the lifecycle and would drop
   * anything written after it — the transcript would then show a Run that ended
   * with a tool still spinning, which is the exact state this method exists to
   * prevent.
   */
  private forceClose(): void {
    if (this.framing.closed || this.isSettled) {
      // `streamRun` reached its own terminal lifecycle inside the grace. Nothing
      // to abandon and nothing to announce; this is the common case.
      this.settle(this.framing.terminalState ?? "cancelled");
      return;
    }

    for (const toolCallId of this.inFlight) {
      this.framing.frame({
        type: "tool-output-error",
        toolCallId,
        errorText: ABANDONED_TOOL_MESSAGE,
        // `code`, `retryable`, and `details` ride here because the native tool part
        // has an `errorText` and nothing else — design.md:1187's convention, so one
        // renderer normaliser covers tool errors alongside the other two sources.
        providerMetadata: {
          zoc: { code: ErrorCode.CANCELLED, retryable: false, details: null },
        },
      });
    }
    this.inFlight.clear();

    this.writer.lifecycle({
      state: "cancelled",
      code: ErrorCode.RUN_CANCELLED,
      message: "Run cancelled.",
      provider: this.record.provider,
      model: this.record.model,
    });
    this.settle("cancelled");
  }

  /**
   * `open` threw, so there is no stream and no chunk but there is still a Run.
   *
   * The error itself has already gone to `onInternalError`; it is deliberately not
   * carried into the part, because R9.8 makes `message` a human sentence with no
   * type name in it and a thrown internal is exactly the kind of string that
   * breaks that.
   */
  private failWithoutStream(): void {
    this.writer.lifecycle({
      state: "failed",
      code: ErrorCode.INTERNAL,
      message: "This run could not be started.",
      provider: this.record.provider,
      model: this.record.model,
    });
    this.settle("failed");
  }

  private settle(state: TerminalRunState): void {
    if (this.graceTimer !== null) {
      clearTimeout(this.graceTimer);
      this.graceTimer = null;
    }
    if (this.settledState !== null) return;
    this.settledState = state;
    this.record.transitionTo(state);
    this.resolveSettled(state);
  }
}

// ── The Run table ─────────────────────────────────────────────────────

export interface RunManagerOptions {
  readonly store: RunStore;
  readonly slots: SlotManager;
  readonly graceMs?: number;
  readonly now?: () => Date;
  readonly onInternalError?: (error: unknown) => void;
}

export interface RunSubmission {
  readonly runId: string;
  readonly messageId: string;
  readonly sessionId: string;
  readonly provider: string;
  readonly model: string;
  readonly conversationMode: string;
  readonly permissionMode: string;
  readonly open: OpenRunStream;
  readonly parentRunId?: string | null;
}

export interface Admitted {
  readonly driver: RunDriver;
  /** null when the Run started immediately; a 1-based place in the queue otherwise. */
  readonly queuePosition: number | null;
}

/**
 * Submission, admission, and the queue drain in one place.
 *
 * It exists so the three run routes are HTTP and nothing else. The drain is the
 * reason it cannot live in the route module: a Slot frees when a Run *settles*,
 * which is a stream event, so the thing that starts the next Run has to be
 * subscribed to the previous one's settlement — not to a request.
 */
export class RunManager {
  readonly store: RunStore;
  readonly slots: SlotManager;

  private readonly drivers = new Map<string, RunDriver>();
  private readonly graceMs: number | undefined;
  private readonly now: (() => Date) | undefined;
  private readonly onInternalError: ((error: unknown) => void) | undefined;

  constructor(options: RunManagerOptions) {
    this.store = options.store;
    this.slots = options.slots;
    this.graceMs = options.graceMs;
    this.now = options.now;
    this.onInternalError = options.onInternalError;
  }

  driver(runId: string): RunDriver | null {
    return this.drivers.get(runId) ?? null;
  }

  record(runId: string): RunRecord | null {
    return this.store.get(runId);
  }

  /** Whether a Run is streaming on this Session — the compact-now 409's question. */
  hasActiveRun(sessionId: string): boolean {
    return this.store.activeForSession(sessionId).length > 0;
  }

  /**
   * Register a Run and either start it or queue it.
   *
   * Throws `SlotQueueFullError`, which the route maps to `slot_queue_full`. The
   * record is created *before* admission is asked for so a queued Run is
   * addressable straight away: the surface is handed a `streamUrl` in the same
   * response, and a stream route that 404'd until a Slot freed would make queueing
   * indistinguishable from failure.
   */
  submit(submission: RunSubmission): Admitted {
    const clock = this.now;
    const record = this.store.create({
      runId: submission.runId,
      sessionId: submission.sessionId,
      provider: submission.provider,
      model: submission.model,
      conversationMode: submission.conversationMode,
      permissionMode: submission.permissionMode,
      parentRunId: submission.parentRunId ?? null,
      ...(clock === undefined ? {} : { now: () => clock().getTime() }),
    });

    const driver = new RunDriver({
      record,
      messageId: submission.messageId,
      open: submission.open,
      ...(this.graceMs === undefined ? {} : { graceMs: this.graceMs }),
      ...(this.now === undefined ? {} : { now: this.now }),
      ...(this.onInternalError === undefined ? {} : { onInternalError: this.onInternalError }),
    });
    this.drivers.set(submission.runId, driver);

    void driver.settled.then(() => {
      this.promote(this.slots.release(submission.runId));
    });

    let admission;
    try {
      admission = this.slots.submit({
        runId: submission.runId,
        providerId: submission.provider,
      });
    } catch (error) {
      // The Slot was refused, so this Run will never stream. Drop it rather than
      // leaving a `queued` record the stream route would happily attach to.
      this.drivers.delete(submission.runId);
      this.store.delete(submission.runId);
      throw error;
    }

    if (admission.admitted) {
      void driver.start();
      return { driver, queuePosition: null };
    }
    driver.announceQueued(admission.position);
    return { driver, queuePosition: admission.position };
  }

  /**
   * Cancel a Run, whichever side of admission it is on.
   *
   * `false` means there was nothing to cancel — no such Run, or one that had
   * already settled. The route turns that into `202` all the same: cancel is
   * idempotent by design, and a surface whose stop button 404s because the Run
   * finished a moment earlier is a surface reporting an error for a race it won.
   */
  cancel(runId: string): boolean {
    const driver = this.drivers.get(runId);
    if (driver === undefined) return false;
    if (driver.isSettled) return false;

    // A Run still in the queue has no stream to abort and no tool to wait for, so
    // it is settled here rather than being given a grace it cannot use.
    if (this.slots.positionOf(runId) !== null) {
      this.slots.cancelQueued(runId);
      driver.cancelBeforeStart();
      this.reannounceQueue();
      return true;
    }
    return driver.cancel();
  }

  /** Start the Runs a release promoted, and re-report the positions behind them. */
  private promote(startedRunIds: readonly string[]): void {
    for (const runId of startedRunIds) {
      const driver = this.drivers.get(runId);
      if (driver !== undefined) void driver.start();
    }
    if (startedRunIds.length > 0) this.reannounceQueue();
  }

  /**
   * Re-emit each waiting Run's position after the queue shifts.
   *
   * A position that is reported once and never again is worse than no position at
   * all: the number the user is looking at becomes silently wrong the moment
   * anything ahead of them finishes, and they have no way to tell. The lifecycle
   * part reconciles by run id, so each of these updates a row in place rather than
   * adding one.
   */
  private reannounceQueue(): void {
    this.slots.queuedRunIds.forEach((runId, index) => {
      this.drivers.get(runId)?.announceQueued(index + 1);
    });
  }
}

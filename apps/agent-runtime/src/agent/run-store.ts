/**
 * Agent_Runtime run store, resume ring, and Slot manager — zoc-agent-chat-rebuild
 * R16.3, R25.1, R25.2, R25.7.
 *
 * Feature: zoc-agent-chat-rebuild, R16.3, R25.1, R25.2, R25.7.
 *
 * Three things live here because all three are per-Run bookkeeping the HTTP layer
 * reads and the agent loop writes, and splitting them across files would put the
 * Slot budget in one module and the thing it counts in another:
 *
 *   - `RunStore` — the live Run table. `GET /v1/runs/:id/stream` resolves through
 *     it, and a miss is R16.3's `run_not_found` rather than a silent empty stream.
 *   - `ResumeRing` — the per-Run 2048-chunk buffer a re-attach replays from.
 *   - `SlotManager` — the concurrency budget, plus the per-path mutex R25.7's
 *     same-file conflict needs.
 *
 * **What this deliberately is not: durable.** The resume window is memory. A
 * dropped connection is recoverable; an Agent_Runtime crash is not — the Run is
 * marked failed with `runtime_unavailable` and the transcript received so far is
 * preserved (R3.8). That is the concrete, accepted cost of rejecting a durable
 * graph executor, and `RunStore` plus `SlotManager` are named in the design as the
 * two seams where a durable executor could be substituted without touching the
 * wire protocol. Anything added here that a durable implementation could not also
 * provide narrows that seam, so keep the surface small.
 */

import { isLocalProvider } from "../providers/registry.ts";
import type { BufferedChunk, ChunkSink } from "./writer.ts";
import { SSE_KEEPALIVE, isTerminalRunState } from "./writer.ts";

/**
 * Chunks held per Run for resume (R16.3).
 *
 * 2048 is chosen against R20.3's 40-parts-per-second ceiling: it guarantees a
 * resume window of at least 51 s of worst-case streaming, which comfortably
 * covers 11.1's five-attempt schedule whose worst case is 7.75 s elapsed. Sizing
 * it by *count* rather than bytes is deliberate — the transport's contract is
 * expressed in sequence numbers, so a window measured in the same unit cannot
 * disagree with the protocol about whether a given `seq` is still available.
 */
export const RESUME_RING_CAPACITY = 2048;

/** Default concurrent Runs (R25.1). Three, matching `store.ts`'s `maxConcurrentRuns ?? 3`. */
export const DEFAULT_SLOT_COUNT = 3;

/**
 * Concurrent Runs allowed against a local provider.
 *
 * One, regardless of the configured Slot count: `llama-server` serves one loaded
 * model, so a second concurrent local Run would either queue inside the server or
 * force a model reload. This is a constraint of the local runtime, not a policy
 * choice, which is why it is not configurable.
 */
export const LOCAL_PROVIDER_CEILING = 1;

/**
 * How many Runs may wait behind a full Slot set before submission is refused with
 * `slot_queue_full`.
 *
 * A bound rather than an unbounded queue because an unbounded one turns a
 * runaway caller into unbounded memory, and because a user staring at "queued at
 * position 47" is being told a useless thing politely.
 */
export const DEFAULT_QUEUE_LIMIT = 16;

/**
 * How long a finished Run stays resolvable.
 *
 * Not zero: 11.1 re-attaches with full jitter for up to 7.75 s, and a Run that
 * completed one millisecond before the client's last attempt must answer with its
 * terminal chunks rather than a 404 that the transport would render as
 * `stream_lost` — an interrupted row for a Run that actually succeeded. Five
 * minutes is far past the retry schedule and short enough that the ring buffers of
 * finished Runs do not dominate the 250 MB idle budget (R20.6).
 */
export const FINISHED_RUN_RETENTION_MS = 5 * 60_000;

/** Hard cap on retained Runs, so retention cannot outrun the memory budget. */
export const MAX_RETAINED_RUNS = 64;

// ── The resume ring ───────────────────────────────────────────────────

export type ReplayOutcome =
  | { readonly ok: true; readonly chunks: readonly BufferedChunk[] }
  /** The requested `seq` fell out of the window; the gap cannot be closed. */
  | { readonly ok: false; readonly reason: "resume_window_expired" };

/**
 * A fixed-capacity FIFO of emitted chunks.
 *
 * A plain array with a shift-free head index rather than a linked list: replay
 * is a contiguous slice, which is the operation that actually runs on the hot
 * path, and `Array.prototype.shift` on a 2048-element array is an O(n) memmove
 * per emission at 40 emissions a second.
 */
export class ResumeRing {
  private readonly capacity: number;
  private readonly items: BufferedChunk[] = [];
  private head = 0;
  private evicted = 0;

  constructor(capacity: number = RESUME_RING_CAPACITY) {
    if (!Number.isInteger(capacity) || capacity < 1) {
      throw new RangeError("ResumeRing capacity must be a positive integer");
    }
    this.capacity = capacity;
  }

  get size(): number {
    return this.items.length - this.head;
  }

  /** Chunks dropped out of the window since the Run began. */
  get evictedCount(): number {
    return this.evicted;
  }

  /** The lowest `seq` still replayable, or null while the ring is empty. */
  get oldestSeq(): number | null {
    return this.size === 0 ? null : (this.items[this.head] as BufferedChunk).seq;
  }

  /** The highest `seq` buffered, or null while the ring is empty. */
  get newestSeq(): number | null {
    return this.size === 0 ? null : (this.items.at(-1) as BufferedChunk).seq;
  }

  push(entry: BufferedChunk): void {
    this.items.push(entry);
    if (this.size > this.capacity) {
      this.head += 1;
      this.evicted += 1;
      // Compact when the dead prefix is at least as large as the live window, so
      // the backing array stays O(capacity) without paying a memmove per push.
      if (this.head >= this.capacity) {
        this.items.splice(0, this.head);
        this.head = 0;
      }
    }
  }

  /**
   * Every buffered chunk with `seq > fromSeq`, in order.
   *
   * Refuses when `fromSeq < oldestSeq - 1` — the client's next expected chunk has
   * already been evicted, so replaying what remains would hand it an
   * out-of-order stream, which is precisely what the sequence contract exists to
   * prevent. Better a 409 the transport turns into one honest interrupted row.
   *
   * An empty ring always succeeds with nothing to replay: either the Run has
   * emitted nothing yet (so `fromSeq` is 0 and there is genuinely no gap), or a
   * client is claiming to have seen chunks that were never sent, in which case
   * attaching it live is the benign outcome and refusing would strand a caller
   * over a bug it cannot fix.
   */
  replayFrom(fromSeq: number): ReplayOutcome {
    const oldest = this.oldestSeq;
    if (oldest === null) return { ok: true, chunks: [] };
    if (fromSeq < oldest - 1) return { ok: false, reason: "resume_window_expired" };

    const live = this.items.slice(this.head);
    // `live` is sorted by construction, so the first index past `fromSeq` bounds
    // the slice; a filter would be the same result at the cost of a full scan.
    let start = 0;
    while (start < live.length && (live[start] as BufferedChunk).seq <= fromSeq) {
      start += 1;
    }
    return { ok: true, chunks: live.slice(start) };
  }

  /** Every buffered chunk, oldest first. For tests and diagnostics. */
  snapshot(): readonly BufferedChunk[] {
    return this.items.slice(this.head);
  }
}

// ── The per-Run record ────────────────────────────────────────────────

/** A live SSE reader. Returns false when the socket is gone, so it can be reaped. */
export type FrameSubscriber = (frame: string) => boolean | void;

export type RunPhase =
  | "queued"
  | "running"
  | "awaiting-approval"
  | "completed"
  | "cancelled"
  | "failed"
  | "interrupted";

export interface RunRecordInit {
  readonly runId: string;
  readonly sessionId: string;
  readonly provider: string;
  readonly model: string;
  readonly conversationMode: string;
  readonly permissionMode: string;
  /** Set for a sub-agent Run (M2 29.1); null for a top-level one. */
  readonly parentRunId?: string | null;
  readonly now?: () => number;
}

/**
 * One Run's live state.
 *
 * Implements `ChunkSink`, so the framing stage in `writer.ts` writes straight
 * through it: `append` fills the resume ring, `broadcast` fans out to attached
 * readers. Two methods rather than one because a detached reader must not stop a
 * chunk being buffered for the resume that follows — that is exactly the
 * mid-stream-disconnect case 11.1 recovers from.
 */
export class RunRecord implements ChunkSink {
  readonly runId: string;
  readonly sessionId: string;
  readonly provider: string;
  readonly model: string;
  readonly conversationMode: string;
  readonly permissionMode: string;
  readonly parentRunId: string | null;
  readonly ring: ResumeRing;
  /** Passed to `agent.stream()`; cancellation aborts it (R16.1). */
  readonly abort = new AbortController();
  readonly startedAtMs: number;

  private readonly now: () => number;
  private readonly subscribers = new Set<FrameSubscriber>();
  private phaseValue: RunPhase = "queued";
  private finishedAtMs: number | null = null;

  constructor(init: RunRecordInit) {
    this.runId = init.runId;
    this.sessionId = init.sessionId;
    this.provider = init.provider;
    this.model = init.model;
    this.conversationMode = init.conversationMode;
    this.permissionMode = init.permissionMode;
    this.parentRunId = init.parentRunId ?? null;
    this.now = init.now ?? (() => Date.now());
    this.ring = new ResumeRing();
    this.startedAtMs = this.now();
  }

  get phase(): RunPhase {
    return this.phaseValue;
  }

  get finished(): boolean {
    return isTerminalRunState(this.phaseValue);
  }

  get finishedAt(): number | null {
    return this.finishedAtMs;
  }

  get readerCount(): number {
    return this.subscribers.size;
  }

  get lastSeq(): number {
    return this.ring.newestSeq ?? 0;
  }

  /**
   * Record a phase change.
   *
   * State is tracked here as well as being streamed because the HTTP layer needs
   * it without reading the transcript: `/v1/runs/:id/cancel` on a finished Run is
   * a no-op rather than an error, and the compact-now route's
   * `compaction_run_active` 409 is a question about phase, not about parts.
   *
   * Terminal is one-way. A late transition after `completed` is ignored, matching
   * the framing stage's drop-after-close rule so the two cannot disagree about
   * whether a Run is over.
   */
  transitionTo(phase: RunPhase): boolean {
    if (this.finished) return false;
    this.phaseValue = phase;
    if (isTerminalRunState(phase)) this.finishedAtMs = this.now();
    return true;
  }

  append(entry: BufferedChunk): void {
    this.ring.push(entry);
  }

  broadcast(_entry: BufferedChunk, frame: string): void {
    this.emitFrame(frame);
  }

  /** Send a keepalive comment to attached readers. Consumes no `seq`. */
  keepalive(): void {
    this.emitFrame(SSE_KEEPALIVE);
  }

  /**
   * Attach a reader. The returned function detaches it.
   *
   * A subscriber that returns `false` is dropped on the spot: a closed socket
   * must not accumulate across a long Run, and discovering it on write is
   * cheaper and more reliable than polling for liveness.
   */
  subscribe(subscriber: FrameSubscriber): () => void {
    this.subscribers.add(subscriber);
    return () => {
      this.subscribers.delete(subscriber);
    };
  }

  replayFrom(fromSeq: number): ReplayOutcome {
    return this.ring.replayFrom(fromSeq);
  }

  private emitFrame(frame: string): void {
    for (const subscriber of [...this.subscribers]) {
      let alive: boolean | void = true;
      try {
        alive = subscriber(frame);
      } catch {
        // A throwing reader is a broken socket, not a reason to fail the Run.
        alive = false;
      }
      if (alive === false) this.subscribers.delete(subscriber);
    }
  }
}

// ── The Run table ─────────────────────────────────────────────────────

export interface RunStoreOptions {
  readonly retentionMs?: number;
  readonly maxRetained?: number;
  readonly now?: () => number;
}

/**
 * The live Run table.
 *
 * Pruning happens on write rather than on a timer: a timer is a handle the
 * process has to own and shut down, and it would fire on an idle runtime whose
 * whole job at that moment is to stay under the 250 MB idle budget (R20.6).
 * Pruning where Runs are created bounds the table exactly where it can grow.
 */
export class RunStore {
  private readonly runs = new Map<string, RunRecord>();
  private readonly retentionMs: number;
  private readonly maxRetained: number;
  private readonly now: () => number;

  constructor(options: RunStoreOptions = {}) {
    this.retentionMs = options.retentionMs ?? FINISHED_RUN_RETENTION_MS;
    this.maxRetained = options.maxRetained ?? MAX_RETAINED_RUNS;
    this.now = options.now ?? (() => Date.now());
  }

  get size(): number {
    return this.runs.size;
  }

  create(init: RunRecordInit): RunRecord {
    const record = new RunRecord({ now: this.now, ...init });
    this.runs.set(record.runId, record);
    this.prune();
    return record;
  }

  /** The Run, or null — which the stream route turns into R16.3's `run_not_found`. */
  get(runId: string): RunRecord | null {
    return this.runs.get(runId) ?? null;
  }

  /** Every Run still in the table, oldest first. */
  list(): readonly RunRecord[] {
    return [...this.runs.values()].sort((a, b) => a.startedAtMs - b.startedAtMs);
  }

  /** Active (non-terminal) Runs on one Session — the compact-now 409's input. */
  activeForSession(sessionId: string): readonly RunRecord[] {
    return this.list().filter((run) => run.sessionId === sessionId && !run.finished);
  }

  /** The sub-agent Runs one level below `runId` (R25.6). */
  childrenOf(runId: string): readonly RunRecord[] {
    return this.list().filter((run) => run.parentRunId === runId);
  }

  /**
   * Every sub-agent Run beneath `runId`, shallowest level first (R25.6).
   *
   * Breadth-first over a `visited` set rather than a recursion, because
   * `parentRunId` is a field a caller supplies and a cycle in it is therefore
   * reachable input: a plain recursion would hang the runtime instead of refusing
   * the malformed graph. A Run naming *itself* as parent is the one-node case of
   * the same thing and is excluded by seeding the set with `runId`.
   *
   * `runId` is never in the result. The caller cancels the parent itself, and
   * including it here would make a cascade indistinguishable from a self-cancel —
   * which matters because `cancel` is idempotent and would then double-report.
   *
   * Scans the table per level rather than maintaining a parent index. The table is
   * capped at {@link MAX_RETAINED_RUNS}, a cascade runs once per user-visible stop,
   * and an index is a second structure that `delete` and `prune` would both have to
   * keep honest — a correctness liability for no measurable gain at n ≤ 64.
   */
  descendantsOf(runId: string): readonly RunRecord[] {
    const found: RunRecord[] = [];
    const visited = new Set<string>([runId]);
    const frontier: string[] = [runId];
    while (frontier.length > 0) {
      const parentId = frontier.shift() as string;
      for (const child of this.childrenOf(parentId)) {
        if (visited.has(child.runId)) continue;
        visited.add(child.runId);
        found.push(child);
        frontier.push(child.runId);
      }
    }
    return found;
  }

  delete(runId: string): boolean {
    return this.runs.delete(runId);
  }

  /**
   * Drop finished Runs past the retention window, then oldest-first over the cap.
   *
   * Active Runs are never pruned regardless of the cap: evicting a streaming Run
   * to satisfy a table limit would 404 a live client. If the cap is genuinely
   * exceeded by active Runs the Slot manager has already failed, and hiding that
   * by discarding one is strictly worse than letting the table exceed its target.
   */
  private prune(): void {
    const cutoff = this.now() - this.retentionMs;
    for (const [runId, record] of this.runs) {
      if (record.finished && (record.finishedAt ?? 0) <= cutoff) {
        this.runs.delete(runId);
      }
    }
    if (this.runs.size <= this.maxRetained) return;

    const finishedOldestFirst = this.list()
      .filter((record) => record.finished)
      .sort((a, b) => (a.finishedAt ?? 0) - (b.finishedAt ?? 0));
    for (const record of finishedOldestFirst) {
      if (this.runs.size <= this.maxRetained) break;
      this.runs.delete(record.runId);
    }
  }
}

// ── The Slot manager ──────────────────────────────────────────────────

export interface SlotRequest {
  readonly runId: string;
  readonly providerId: string;
}

export type SlotAdmission =
  | { readonly admitted: true }
  /** Queued. `position` is 1-based, 1 meaning next to start (R25.2). */
  | { readonly admitted: false; readonly position: number };

export class SlotQueueFullError extends Error {
  constructor(limit: number) {
    super(`The run queue is full at ${limit} waiting runs.`);
    this.name = "SlotQueueFullError";
  }
}

export interface SlotManagerOptions {
  readonly capacity?: number;
  readonly queueLimit?: number;
  /** Injected in tests; production keys off the provider registry's `local` flag. */
  readonly isLocal?: (providerId: string) => boolean;
}

/**
 * The concurrency budget (R25.1, R25.2).
 *
 * Ships in M1 at its real default of 3 rather than at 1: `store.ts` already reads
 * `maxConcurrentRuns ?? 3`, so a lower default would be a behaviour regression
 * dressed as a rebuild artefact. M2's 29.1 adds parent/child accounting against
 * this same budget — a parent plus two sub-agents saturates it — and nothing here
 * assumes a Run is top-level.
 *
 * **Admission is strict FIFO, and the head-of-line cost is a decision.** When a
 * Slot frees, the queue head is considered and, if it cannot start, nothing
 * behind it is promoted. The only thing that can block a head with a Slot free is
 * the local-provider ceiling, so the case is: a local Run is streaming and the
 * head is a second local Run, with cloud Runs behind it. Backfilling past the
 * head would raise throughput there, and it is rejected because it makes start
 * order depend on provider — a user who submits A then B can watch B answer
 * first, and "fairly" in Property 59 is the property that rules that out. The
 * blocked head always clears when the active local Run ends, so the cost is
 * bounded delay, never starvation.
 */
export class SlotManager {
  readonly capacity: number;
  readonly queueLimit: number;

  private readonly isLocal: (providerId: string) => boolean;
  private readonly active = new Map<string, string>();
  private readonly waiting: SlotRequest[] = [];

  constructor(options: SlotManagerOptions = {}) {
    const capacity = options.capacity ?? DEFAULT_SLOT_COUNT;
    if (!Number.isInteger(capacity) || capacity < 1) {
      throw new RangeError("Slot capacity must be a positive integer");
    }
    this.capacity = capacity;
    this.queueLimit = options.queueLimit ?? DEFAULT_QUEUE_LIMIT;
    this.isLocal = options.isLocal ?? isLocalProvider;
  }

  get activeCount(): number {
    return this.active.size;
  }

  get activeRunIds(): readonly string[] {
    return [...this.active.keys()];
  }

  get queuedRunIds(): readonly string[] {
    return this.waiting.map((request) => request.runId);
  }

  get queueDepth(): number {
    return this.waiting.length;
  }

  /** 1-based queue position, or null when the Run is not waiting. */
  positionOf(runId: string): number | null {
    const index = this.waiting.findIndex((request) => request.runId === runId);
    return index === -1 ? null : index + 1;
  }

  /**
   * Ask for a Slot.
   *
   * Throws `SlotQueueFullError` — which 9.7 maps to `slot_queue_full` — rather
   * than returning a third variant, because a refusal is not an admission
   * outcome the caller should be able to forget to handle.
   */
  submit(request: SlotRequest): SlotAdmission {
    if (this.active.has(request.runId) || this.positionOf(request.runId) !== null) {
      throw new Error(`Run ${request.runId} has already been submitted.`);
    }
    // Only admit immediately when nothing is waiting: jumping a queue because a
    // Slot happens to be free is the same unfairness backfilling would be.
    if (this.waiting.length === 0 && this.canStart(request)) {
      this.active.set(request.runId, request.providerId);
      return { admitted: true };
    }
    if (this.waiting.length >= this.queueLimit) {
      throw new SlotQueueFullError(this.queueLimit);
    }
    this.waiting.push(request);
    return { admitted: false, position: this.waiting.length };
  }

  /**
   * Give up a Slot and promote whatever the queue head allows.
   *
   * Returns the Run ids that just started, in start order, so the caller can
   * emit each one's `running` lifecycle part. Returning them rather than invoking
   * a callback keeps this class free of the writer and testable without one.
   */
  release(runId: string): readonly string[] {
    if (!this.active.delete(runId)) {
      // Releasing a queued Run is a cancel-before-start, not an error: 9.7's
      // cancel route does not know or care which side of admission it is on.
      this.cancelQueued(runId);
      return [];
    }
    return this.drain();
  }

  /** Remove a Run that was cancelled while waiting. Positions behind it close up. */
  cancelQueued(runId: string): boolean {
    const index = this.waiting.findIndex((request) => request.runId === runId);
    if (index === -1) return false;
    this.waiting.splice(index, 1);
    return true;
  }

  private drain(): readonly string[] {
    const started: string[] = [];
    while (this.waiting.length > 0) {
      const head = this.waiting[0] as SlotRequest;
      if (!this.canStart(head)) break;
      this.waiting.shift();
      this.active.set(head.runId, head.providerId);
      started.push(head.runId);
    }
    return started;
  }

  private canStart(request: SlotRequest): boolean {
    if (this.active.size >= this.capacity) return false;
    if (!this.isLocal(request.providerId)) return true;
    const activeLocal = [...this.active.values()].filter((providerId) =>
      this.isLocal(providerId),
    ).length;
    return activeLocal < LOCAL_PROVIDER_CEILING;
  }
}

// ── The per-path mutex ────────────────────────────────────────────────

/**
 * Serialises work per workspace path (R25.7).
 *
 * The second Run's `workspace_apply_hunks` waits here; by the time it acquires
 * the lock the file's `baseDigest` no longer matches, so its diff is marked stale
 * through the same R10.8 path a human edit would trigger. One staleness
 * mechanism, two causes — which is why this only has to serialise, not detect.
 *
 * Keys are normalised for separators and trailing slashes but **not case**. On a
 * case-sensitive filesystem, folding case would serialise two genuinely different
 * files; on a case-insensitive one, not folding means two locks for one file, and
 * that residue is caught by the digest check the lock exists to set up. Losing
 * correctness on Linux to save a redundant digest comparison on macOS is the
 * wrong trade.
 */
export class PathMutex {
  private readonly chains = new Map<string, Promise<unknown>>();

  static normalizeKey(path: string): string {
    const unified = path.replace(/\\/g, "/").replace(/\/{2,}/g, "/");
    return unified.length > 1 ? unified.replace(/\/+$/, "") : unified;
  }

  get heldCount(): number {
    return this.chains.size;
  }

  /**
   * Run `work` with exclusive access to `path`.
   *
   * The chain is advanced with a settle-swallowing `catch` so one caller's
   * rejection does not poison the lock for the next, while the original
   * rejection still propagates to *its* caller.
   */
  async run<T>(path: string, work: () => Promise<T>): Promise<T> {
    const key = PathMutex.normalizeKey(path);
    const previous = this.chains.get(key) ?? Promise.resolve();

    const result = previous.then(work, work);
    const chain = result.then(
      () => undefined,
      () => undefined,
    );
    this.chains.set(key, chain);

    try {
      return await result;
    } finally {
      // Drop the key once this is the last waiter, so an idle runtime holds no
      // entry per file it has ever touched.
      if (this.chains.get(key) === chain) this.chains.delete(key);
    }
  }

  /**
   * Run `work` holding every path in `paths` at once.
   *
   * An apply is a *batch* — up to 64 files in one `workspace_apply_hunks` call —
   * and locking them one at a time around each write would leave the batch
   * interleavable, which is the thing R25.7 forbids. Held together, two Runs
   * touching a shared file are ordered whole-batch against whole-batch, and two
   * touching disjoint files never meet.
   *
   * **Deadlock-free because the order is global, not per-caller.** Keys are
   * deduplicated and sorted before the first acquisition, so every caller in the
   * process takes contended locks in the same sequence and the cycle a deadlock
   * needs cannot form. That is the whole reason the sort is here rather than at
   * the call site, where one caller passing paths in plan order would be enough
   * to hang two Runs against each other.
   */
  async runAll<T>(paths: readonly string[], work: () => Promise<T>): Promise<T> {
    const keys = [...new Set(paths.map(PathMutex.normalizeKey))].sort();
    const acquire = (index: number): Promise<T> =>
      index === keys.length ? work() : this.run(keys[index] as string, () => acquire(index + 1));
    return acquire(0);
  }
}

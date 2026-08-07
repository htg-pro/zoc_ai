/**
 * Property 59: Slot admission bounds concurrency and queues fairly.
 * Validates R25.1, R25.2.
 *
 * Feature: zoc-agent-chat-rebuild, Property 59 (R25.1, R25.2).
 *
 * Stays in the M1 set despite R25.2's M2 tag: the Slot manager ships in M1 at its
 * default count of 3, so queue admission is M1 behaviour and needs an M1 property.
 *
 * Alongside it, the two other invariants `run-store.ts` owns and that nothing else
 * asserts: the resume ring's window boundary (R16.3), where an off-by-one turns a
 * recoverable reconnect into a spurious `resume_window_expired` or — worse — an
 * out-of-order replay, and the per-path mutex (R25.7).
 */

import { describe, expect, it } from "vitest";
import fc from "fast-check";

import {
  DEFAULT_SLOT_COUNT,
  LOCAL_PROVIDER_CEILING,
  PathMutex,
  RESUME_RING_CAPACITY,
  ResumeRing,
  RunStore,
  SlotManager,
  SlotQueueFullError,
} from "../run-store.ts";
import type { BufferedChunk } from "../writer.ts";

const RUNS = { numRuns: 200 } as const;

const CLOUD_PROVIDERS = ["openai", "anthropic", "google", "groq", "xai"] as const;
const LOCAL_PROVIDER = "local-llamacpp";
const ALL_PROVIDERS = [...CLOUD_PROVIDERS, LOCAL_PROVIDER] as const;

const isLocal = (providerId: string): boolean => providerId === LOCAL_PROVIDER;

// ── Slot manager ──────────────────────────────────────────────────────

type Op =
  | { readonly kind: "submit"; readonly providerId: string }
  | { readonly kind: "complete"; readonly index: number };

const opSequence = fc.array(
  fc.oneof(
    fc.record({
      kind: fc.constant("submit" as const),
      providerId: fc.constantFrom(...ALL_PROVIDERS),
    }),
    fc.record({
      kind: fc.constant("complete" as const),
      // Resolved modulo the live set at apply time; drawing an index rather than
      // a run id keeps the generator independent of the model's state.
      index: fc.nat({ max: 64 }),
    }),
  ),
  { minLength: 1, maxLength: 200 },
);

interface Trace {
  readonly manager: SlotManager;
  readonly submitted: string[];
  readonly everStarted: Set<string>;
  readonly startOrder: string[];
  readonly refused: string[];
}

/**
 * Replay one op sequence against a manager, checking the two point-in-time
 * invariants after every step rather than only at the end — a bound that only
 * holds at quiescence is not a bound.
 */
function replay(capacity: number, ops: readonly Op[], queueLimit: number): Trace {
  const manager = new SlotManager({ capacity, isLocal, queueLimit });
  const submitted: string[] = [];
  const everStarted = new Set<string>();
  const startOrder: string[] = [];
  const refused: string[] = [];
  const providerOf = new Map<string, string>();

  const check = (): void => {
    expect(manager.activeCount).toBeLessThanOrEqual(capacity);
    const activeLocal = manager.activeRunIds.filter((runId) =>
      isLocal(providerOf.get(runId) ?? ""),
    ).length;
    expect(activeLocal).toBeLessThanOrEqual(LOCAL_PROVIDER_CEILING);
    // Positions are a contiguous 1..n over exactly the waiting set.
    const queued = manager.queuedRunIds;
    expect(queued.map((runId) => manager.positionOf(runId))).toEqual(queued.map((_, i) => i + 1));
    expect(manager.queueDepth).toBeLessThanOrEqual(queueLimit);
  };

  ops.forEach((op, step) => {
    if (op.kind === "submit") {
      const runId = `run_${step}`;
      providerOf.set(runId, op.providerId);
      try {
        const admission = manager.submit({ runId, providerId: op.providerId });
        submitted.push(runId);
        if (admission.admitted) {
          everStarted.add(runId);
          startOrder.push(runId);
        } else {
          expect(admission.position).toBe(manager.positionOf(runId));
        }
      } catch (error) {
        // The only sanctioned refusal, and only ever at the limit.
        expect(error).toBeInstanceOf(SlotQueueFullError);
        expect(manager.queueDepth).toBe(queueLimit);
        refused.push(runId);
      }
    } else {
      const live = manager.activeRunIds;
      if (live.length === 0) return;
      const runId = live[op.index % live.length] as string;
      for (const started of manager.release(runId)) {
        everStarted.add(started);
        startOrder.push(started);
      }
    }
    check();
  });

  return { manager, submitted, everStarted, startOrder, refused };
}

describe("Property 59: slot admission bounds concurrency and queues fairly (R25.1, R25.2)", () => {
  it("never exceeds the Slot count and keeps queue positions contiguous from 1", () => {
    fc.assert(
      fc.property(fc.integer({ min: 1, max: 6 }), opSequence, (capacity, ops) => {
        // Every assertion lives in `replay`'s per-step check.
        replay(capacity, ops, 32);
      }),
      RUNS,
    );
  });

  it("starts every queued Run once Slots free", () => {
    fc.assert(
      fc.property(fc.integer({ min: 1, max: 6 }), opSequence, (capacity, ops) => {
        const trace = replay(capacity, ops, 1_000);

        // Drain: complete actives until nothing is active or waiting. The
        // property is *eventual* start — the local ceiling can legitimately
        // hold a head back while a Slot is free, but never past the point
        // where the Run blocking it ends.
        let guard = 0;
        while (trace.manager.activeCount > 0 || trace.manager.queueDepth > 0) {
          const live = trace.manager.activeRunIds;
          if (live.length === 0) {
            throw new Error("queue is non-empty with nothing active: deadlock");
          }
          for (const started of trace.manager.release(live[0] as string)) {
            trace.everStarted.add(started);
            trace.startOrder.push(started);
          }
          guard += 1;
          if (guard > 5_000) throw new Error("drain did not converge");
        }

        expect(trace.manager.queueDepth).toBe(0);
        expect(trace.manager.activeCount).toBe(0);
        for (const runId of trace.submitted) {
          expect(trace.everStarted.has(runId)).toBe(true);
        }
      }),
      RUNS,
    );
  });

  it("starts Runs in submission order", () => {
    fc.assert(
      fc.property(fc.integer({ min: 1, max: 4 }), opSequence, (capacity, ops) => {
        const trace = replay(capacity, ops, 1_000);
        while (trace.manager.activeCount > 0 || trace.manager.queueDepth > 0) {
          const live = trace.manager.activeRunIds;
          if (live.length === 0) break;
          for (const started of trace.manager.release(live[0] as string)) {
            trace.startOrder.push(started);
          }
        }

        // Strict FIFO: the order Runs started is the order they were accepted.
        // This is the assertion that would fail if a later reader "optimised"
        // admission by backfilling past a head blocked on the local ceiling.
        expect(trace.startOrder).toEqual(
          trace.submitted.filter((runId) => trace.startOrder.includes(runId)),
        );
      }),
      RUNS,
    );
  });

  it("admits three concurrent Runs at the default count and queues the fourth at position 1", () => {
    // 9.12's integration case, asserted at the unit level too because it is the
    // exact scenario R25.1 names and the one a regression would be reported as.
    const manager = new SlotManager({ isLocal });
    expect(manager.capacity).toBe(DEFAULT_SLOT_COUNT);

    for (const runId of ["a", "b", "c"]) {
      expect(manager.submit({ runId, providerId: "openai" })).toEqual({
        admitted: true,
      });
    }
    expect(manager.submit({ runId: "d", providerId: "openai" })).toEqual({
      admitted: false,
      position: 1,
    });
    expect(manager.activeCount).toBe(3);

    expect(manager.release("a")).toEqual(["d"]);
    expect(manager.queueDepth).toBe(0);
    expect(manager.activeCount).toBe(3);
  });

  it("holds local Runs to a ceiling of one even with Slots free", () => {
    const manager = new SlotManager({ isLocal });
    expect(manager.submit({ runId: "l1", providerId: LOCAL_PROVIDER })).toEqual({
      admitted: true,
    });
    // Two Slots are free, but `llama-server` serves one loaded model.
    expect(manager.submit({ runId: "l2", providerId: LOCAL_PROVIDER })).toEqual({
      admitted: false,
      position: 1,
    });
    expect(manager.activeCount).toBe(1);

    expect(manager.release("l1")).toEqual(["l2"]);
    expect(manager.activeCount).toBe(1);
  });

  it("refuses past the queue limit with SlotQueueFullError", () => {
    const manager = new SlotManager({ capacity: 1, queueLimit: 2, isLocal });
    manager.submit({ runId: "a", providerId: "openai" });
    manager.submit({ runId: "b", providerId: "openai" });
    manager.submit({ runId: "c", providerId: "openai" });
    expect(() => manager.submit({ runId: "d", providerId: "openai" })).toThrow(SlotQueueFullError);
  });

  it("closes positions up when a waiting Run is cancelled", () => {
    const manager = new SlotManager({ capacity: 1, isLocal });
    manager.submit({ runId: "a", providerId: "openai" });
    manager.submit({ runId: "b", providerId: "openai" });
    manager.submit({ runId: "c", providerId: "openai" });
    expect(manager.positionOf("c")).toBe(2);

    expect(manager.cancelQueued("b")).toBe(true);
    expect(manager.positionOf("c")).toBe(1);
    expect(manager.release("a")).toEqual(["c"]);
  });
});

// ── Resume ring ───────────────────────────────────────────────────────

function chunkAt(seq: number): BufferedChunk {
  return { seq, chunk: { type: "text-delta", id: "t", delta: `d${seq}` } };
}

describe("ResumeRing: the resume window boundary (R16.3)", () => {
  it("replays exactly the chunks above fromSeq, in order", () => {
    fc.assert(
      fc.property(fc.integer({ min: 1, max: 400 }), fc.nat({ max: 400 }), (count, fromSeq) => {
        const ring = new ResumeRing(512);
        for (let seq = 1; seq <= count; seq += 1) ring.push(chunkAt(seq));

        const outcome = ring.replayFrom(fromSeq);
        // Capacity 512 over at most 400 pushes: nothing was evicted, so every
        // request is inside the window.
        expect(outcome.ok).toBe(true);
        if (!outcome.ok) return;

        const expected = Array.from(
          { length: Math.max(0, count - fromSeq) },
          (_, i) => fromSeq + 1 + i,
        );
        expect(outcome.chunks.map((entry) => entry.seq)).toEqual(expected);
      }),
      RUNS,
    );
  });

  it("refuses exactly when the next expected chunk has been evicted", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 2, max: 40 }),
        fc.integer({ min: 1, max: 200 }),
        fc.nat({ max: 200 }),
        (capacity, count, fromSeq) => {
          const ring = new ResumeRing(capacity);
          for (let seq = 1; seq <= count; seq += 1) ring.push(chunkAt(seq));

          const oldest = ring.oldestSeq;
          expect(oldest).not.toBeNull();
          const outcome = ring.replayFrom(fromSeq);

          // The boundary, stated once: serve iff the client's next expected
          // chunk (`fromSeq + 1`) is still buffered. An off-by-one here either
          // 409s a recoverable reconnect or replays a stream with a hole in it.
          if (fromSeq < (oldest as number) - 1) {
            expect(outcome.ok).toBe(false);
          } else {
            expect(outcome.ok).toBe(true);
            if (outcome.ok) {
              const seqs = outcome.chunks.map((entry) => entry.seq);
              expect(seqs).toEqual(seqs.map((_, i) => (seqs[0] ?? 0) + i));
              if (seqs.length > 0) expect(seqs[0]).toBe(fromSeq + 1);
              expect(seqs.at(-1) ?? count).toBe(count);
            }
          }
        },
      ),
      RUNS,
    );
  });

  it("never holds more than its capacity, and defaults to the 2048 R20.3 implies", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 32 }),
        fc.integer({ min: 0, max: 300 }),
        (capacity, count) => {
          const ring = new ResumeRing(capacity);
          for (let seq = 1; seq <= count; seq += 1) ring.push(chunkAt(seq));

          expect(ring.size).toBe(Math.min(count, capacity));
          expect(ring.evictedCount).toBe(Math.max(0, count - capacity));
          if (count > 0) {
            expect(ring.newestSeq).toBe(count);
            expect(ring.oldestSeq).toBe(Math.max(1, count - capacity + 1));
          } else {
            expect(ring.oldestSeq).toBeNull();
          }
        },
      ),
      RUNS,
    );

    expect(new ResumeRing().size).toBe(0);
    expect(RESUME_RING_CAPACITY).toBe(2048);
    // The window R20.3's 40 parts/s ceiling has to clear: 11.1's worst-case
    // re-attach is 7.75 s, so 51 s is the margin the capacity buys.
    expect(RESUME_RING_CAPACITY / 40).toBeGreaterThanOrEqual(51);
  });

  it("serves an empty ring live rather than refusing", () => {
    const ring = new ResumeRing(8);
    expect(ring.replayFrom(0)).toEqual({ ok: true, chunks: [] });
    expect(ring.replayFrom(99)).toEqual({ ok: true, chunks: [] });
  });
});

// ── Run store retention ───────────────────────────────────────────────

describe("RunStore retention", () => {
  const init = (runId: string) => ({
    runId,
    sessionId: "sess_1",
    provider: "openai",
    model: "gpt-5",
    conversationMode: "agent",
    permissionMode: "ask",
  });

  it("keeps a finished Run resolvable across the re-attach window", () => {
    let clock = 0;
    const store = new RunStore({ now: () => clock, retentionMs: 60_000 });
    const record = store.create(init("run_1"));
    record.transitionTo("completed");

    // 11.1's worst case is 7.75 s of jittered retries; a Run that finished just
    // before the last attempt must not 404 into a false `stream_lost` row.
    clock += 8_000;
    store.create(init("run_2"));
    expect(store.get("run_1")).toBe(record);

    clock += 60_001;
    store.create(init("run_3"));
    expect(store.get("run_1")).toBeNull();
  });

  it("never prunes an active Run, even over the cap", () => {
    const store = new RunStore({ maxRetained: 2 });
    const active = [1, 2, 3, 4].map((n) => store.create(init(`run_${n}`)));
    for (const record of active) expect(store.get(record.runId)).toBe(record);
    expect(store.activeForSession("sess_1")).toHaveLength(4);
  });
});

// ── Path mutex ────────────────────────────────────────────────────────

describe("PathMutex: same-file applies serialise (R25.7)", () => {
  it("never overlaps two operations on one path, and never blocks distinct paths", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(fc.constantFrom("a.ts", "b.ts", "./a.ts", "a.ts/", "dir//a.ts"), {
          minLength: 2,
          maxLength: 40,
        }),
        async (paths) => {
          const mutex = new PathMutex();
          const inFlight = new Map<string, number>();
          let maxParallel = 0;

          await Promise.all(
            paths.map((path) =>
              mutex.run(path, async () => {
                const key = PathMutex.normalizeKey(path);
                const depth = (inFlight.get(key) ?? 0) + 1;
                inFlight.set(key, depth);
                // Two holders of one key at once is the whole failure mode.
                expect(depth).toBe(1);
                maxParallel = Math.max(maxParallel, inFlight.size);
                await new Promise((resolve) => setTimeout(resolve, 0));
                inFlight.set(key, depth - 1);
              }),
            ),
          );

          expect(mutex.heldCount).toBe(0);
          const distinct = new Set(paths.map(PathMutex.normalizeKey)).size;
          // Distinct paths must genuinely run together, or this is a global lock
          // wearing a per-path name.
          expect(maxParallel).toBe(distinct);
        },
      ),
      { numRuns: 40 },
    );
  });

  it("does not poison the lock when a holder rejects", async () => {
    const mutex = new PathMutex();
    const boom = mutex.run("a.ts", () => Promise.reject(new Error("boom")));
    await expect(boom).rejects.toThrow("boom");
    await expect(mutex.run("a.ts", async () => "ok")).resolves.toBe("ok");
  });

  it("normalises separators and trailing slashes, but not case", () => {
    expect(PathMutex.normalizeKey("src\\a.ts")).toBe("src/a.ts");
    expect(PathMutex.normalizeKey("src//a.ts")).toBe("src/a.ts");
    expect(PathMutex.normalizeKey("src/a.ts/")).toBe("src/a.ts");
    expect(PathMutex.normalizeKey("/")).toBe("/");
    // Case-folding would serialise two genuinely different files on Linux.
    expect(PathMutex.normalizeKey("src/A.ts")).not.toBe(PathMutex.normalizeKey("src/a.ts"));
  });
});

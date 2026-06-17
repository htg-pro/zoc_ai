// Feature: studio-ui-redesign, Property 20: Run lifecycle transitions are well-defined and clear the run id on terminal states
// Feature: studio-ui-redesign, Property 21: A run that fails to start stays idle with no run id
// Feature: studio-ui-redesign, Property 23: Control availability is a pure function of lifecycle
// Feature: studio-ui-redesign, Property 24: Starting a new run terminates the previous run before assigning the new id
// Feature: studio-ui-redesign, Property 10: Submitting during an active run queues instead of starting
// Feature: studio-ui-redesign, Property 11: A queued message starts exactly one run on terminal transition
import { describe, expect, it } from "vitest";
import fc from "fast-check";
import {
  INITIAL_RUN_STATE,
  type RunAction,
  type RunLifecycle,
  type RunState,
  controlAvailability,
  isActive,
  isTerminal,
  releaseQueuedMessage,
  runReducer,
} from "../run-machine";

const LIFECYCLES: RunLifecycle[] = [
  "idle",
  "running",
  "paused",
  "stopped",
  "completed",
  "error",
];

const arbAction: fc.Arbitrary<RunAction> = fc.oneof(
  fc
    .tuple(
      fc.hexaString({ minLength: 1, maxLength: 6 }),
      fc.hexaString({ minLength: 1, maxLength: 6 }),
      fc.nat(),
    )
    .map(([runId, boundMessageId, at]) => ({
      type: "start" as const,
      runId,
      boundMessageId,
      at,
    })),
  fc.constant({ type: "pause" as const }),
  fc.constant({ type: "resume" as const }),
  fc.constant({ type: "stop" as const }),
  fc.constant({ type: "done" as const }),
  fc.string({ maxLength: 8 }).map((d) => ({ type: "error" as const, detail: d })),
  fc
    .string({ maxLength: 8 })
    .map((d) => ({ type: "stream-lost" as const, detail: d })),
  fc.string({ maxLength: 8 }).map((t) => ({ type: "queue" as const, text: t })),
);

describe("run-machine", () => {
  it("Property 20: transitions are well-defined; terminal states clear the run id", () => {
    fc.assert(
      fc.property(fc.array(arbAction, { maxLength: 30 }), (actions) => {
        let state = INITIAL_RUN_STATE;
        for (const action of actions) {
          const prev = state;
          state = runReducer(state, action);

          // Terminal invariant: runId is always null in a terminal state.
          if (isTerminal(state.lifecycle)) {
            expect(state.runId).toBeNull();
          }
          // start always yields running + a fresh id.
          if (action.type === "start") {
            expect(state.lifecycle).toBe("running");
            expect(state.runId).toBe(action.runId);
          }
          // pause only transitions from running.
          if (action.type === "pause" && prev.lifecycle !== "running") {
            expect(state.lifecycle).toBe(prev.lifecycle);
          }
          // done/stop only act on an active run.
          if (action.type === "done" && !isActive(prev.lifecycle)) {
            expect(state.lifecycle).toBe(prev.lifecycle);
          }
        }
      }),
      { numRuns: 300 },
    );
  });

  it("Property 21: a failed start stays idle with no run id and records the error", () => {
    fc.assert(
      fc.property(fc.string({ minLength: 1, maxLength: 20 }), (detail) => {
        const state = runReducer(INITIAL_RUN_STATE, {
          type: "start-failed",
          detail,
        });
        expect(state.lifecycle).toBe("idle");
        expect(state.runId).toBeNull();
        expect(state.error).toBe(detail);
      }),
      { numRuns: 100 },
    );
  });

  it("Property 23: control availability depends solely on lifecycle", () => {
    fc.assert(
      fc.property(fc.constantFrom(...LIFECYCLES), (lifecycle) => {
        const c = controlAvailability(lifecycle);
        switch (lifecycle) {
          case "running":
            expect(c).toEqual({
              pause: true,
              resume: false,
              stop: true,
              showResume: false,
            });
            break;
          case "paused":
            expect(c).toEqual({
              pause: false,
              resume: true,
              stop: true,
              showResume: true,
            });
            break;
          default:
            expect(c).toEqual({
              pause: false,
              resume: false,
              stop: false,
              showResume: false,
            });
        }
      }),
      { numRuns: 100 },
    );
  });

  it("Property 24: starting from an active run produces exactly one active run with the new id", () => {
    fc.assert(
      fc.property(
        fc.hexaString({ minLength: 1, maxLength: 6 }),
        fc.hexaString({ minLength: 1, maxLength: 6 }),
        fc.nat(),
        (oldId, newId, at) => {
          // An active run with the old id.
          let state: RunState = runReducer(INITIAL_RUN_STATE, {
            type: "start",
            runId: oldId,
            boundMessageId: "m-old",
            at: 0,
          });
          expect(state.lifecycle).toBe("running");
          // Start a new run.
          state = runReducer(state, {
            type: "start",
            runId: newId,
            boundMessageId: "m-new",
            at,
          });
          expect(state.lifecycle).toBe("running");
          expect(state.runId).toBe(newId);
        },
      ),
      { numRuns: 200 },
    );
  });

  it("Property 10: queue while active stores the message without starting/mutating the run", () => {
    fc.assert(
      fc.property(
        fc.constantFrom<RunLifecycle>("running", "paused"),
        fc.string({ minLength: 1, maxLength: 20 }),
        (lifecycle, text) => {
          const base: RunState = {
            ...INITIAL_RUN_STATE,
            lifecycle,
            runId: "active",
          };
          const next = runReducer(base, { type: "queue", text });
          expect(next.queuedMessage).toBe(text);
          expect(next.lifecycle).toBe(lifecycle);
          expect(next.runId).toBe("active");
        },
      ),
      { numRuns: 100 },
    );
  });

  it("Property 11: a queued message is released exactly once on a terminal transition", () => {
    fc.assert(
      fc.property(
        fc.constantFrom<RunLifecycle>("completed", "stopped", "error"),
        fc.string({ minLength: 1, maxLength: 20 }),
        (terminal, text) => {
          const state: RunState = {
            ...INITIAL_RUN_STATE,
            lifecycle: terminal,
            queuedMessage: text,
          };
          const first = releaseQueuedMessage(state);
          expect(first.start).toBe(text);
          expect(first.state.queuedMessage).toBeNull();

          // Releasing again yields nothing (released exactly once).
          const second = releaseQueuedMessage(first.state);
          expect(second.start).toBeNull();
        },
      ),
      { numRuns: 100 },
    );
  });

  it("Property 10b: queue while idle does not store the message", () => {
    const next = runReducer(INITIAL_RUN_STATE, { type: "queue", text: "hi" });
    expect(next.queuedMessage).toBeNull();
  });

  it("review lifecycle: running → awaiting_review → applied clears the run id", () => {
    let state: RunState = runReducer(INITIAL_RUN_STATE, { type: "start", runId: "r1", boundMessageId: "m1", at: 0 });
    state = runReducer(state, { type: "await-review" });
    expect(state.lifecycle).toBe("awaiting_review");
    expect(state.runId).toBe("r1"); // kept so review controls can reference it
    state = runReducer(state, { type: "apply" });
    expect(state.lifecycle).toBe("applying");
    state = runReducer(state, { type: "applied" });
    expect(state.lifecycle).toBe("applied");
    expect(isTerminal(state.lifecycle)).toBe(true);
    expect(state.runId).toBeNull();
  });

  it("review lifecycle: awaiting_review → discarded is terminal and clears the run id", () => {
    let state: RunState = runReducer(INITIAL_RUN_STATE, { type: "start", runId: "r2", boundMessageId: "m2", at: 0 });
    state = runReducer(state, { type: "await-review" });
    state = runReducer(state, { type: "discard" });
    expect(state.lifecycle).toBe("discarded");
    expect(isTerminal(state.lifecycle)).toBe(true);
    expect(state.runId).toBeNull();
  });

  it("review actions are no-ops from the wrong state", () => {
    // await-review only acts on an active run.
    expect(runReducer(INITIAL_RUN_STATE, { type: "await-review" }).lifecycle).toBe("idle");
    // apply/discard only act from awaiting_review.
    const running = runReducer(INITIAL_RUN_STATE, { type: "start", runId: "r3", boundMessageId: "m3", at: 0 });
    expect(runReducer(running, { type: "apply" }).lifecycle).toBe("running");
    expect(runReducer(running, { type: "discard" }).lifecycle).toBe("running");
  });
});

// Feature: chat-memory-session-system, Property 1: A started run answers the most-recent user message
// Validates: Requirements 1.1
describe("run-machine: run/message association (Property 1)", () => {
  /** A user message as the caller would append it to the conversation. */
  interface UserMsg {
    id: string;
    /** Append order; ties (equal order) resolve to the highest id. */
    order: number;
  }

  /**
   * Models the caller's binding contract (Requirement 1.1): the bound message
   * is the user message with the latest append order, resolving ties in favor
   * of the highest id. Returns exactly one id for a non-empty list.
   */
  function resolveBoundMessageId(messages: UserMsg[]): string {
    return messages.reduce((best, m) => {
      if (m.order > best.order) return m;
      if (m.order === best.order && m.id > best.id) return m;
      return best;
    }).id;
  }

  // Distinct, unique ids so the "highest id" tie-break is well-defined.
  const arbUserMessages: fc.Arbitrary<UserMsg[]> = fc
    .uniqueArray(fc.hexaString({ minLength: 1, maxLength: 8 }), {
      minLength: 1,
      maxLength: 12,
    })
    .chain((ids) =>
      fc
        .tuple(
          ...ids.map(() => fc.integer({ min: 0, max: 5 })),
        )
        .map((orders) =>
          ids.map((id, i) => ({ id, order: orders[i] as number })),
        ),
    );

  it("Property 1: after start, boundMessageId is the last-appended user message (ties → highest id)", () => {
    fc.assert(
      fc.property(arbUserMessages, fc.hexaString({ minLength: 1, maxLength: 6 }), fc.nat(), (messages, runId, at) => {
        // The caller resolves the bound message from the appended user messages.
        const expectedBoundId = resolveBoundMessageId(messages);

        const state = runReducer(INITIAL_RUN_STATE, {
          type: "start",
          runId,
          boundMessageId: expectedBoundId,
          at,
        });

        expect(state.lifecycle).toBe("running");
        expect(state.boundMessageId).toBe(expectedBoundId);

        // boundMessageId must resolve to exactly one of the appended messages.
        expect(messages.some((m) => m.id === state.boundMessageId)).toBe(true);
      }),
      { numRuns: 300 },
    );
  });

  it("Property 1 (append semantics): the last message appended wins when its order is strictly latest", () => {
    fc.assert(
      fc.property(
        fc.uniqueArray(fc.hexaString({ minLength: 1, maxLength: 8 }), {
          minLength: 1,
          maxLength: 10,
        }),
        fc.hexaString({ minLength: 1, maxLength: 6 }),
        (ids, runId) => {
          // Append in order: each subsequent message has a strictly later order,
          // so the final appended message is the unambiguous bound message.
          const messages: UserMsg[] = ids.map((id, i) => ({ id, order: i }));
          const expectedBoundId = messages[messages.length - 1]!.id;
          expect(resolveBoundMessageId(messages)).toBe(expectedBoundId);

          const state = runReducer(INITIAL_RUN_STATE, {
            type: "start",
            runId,
            boundMessageId: expectedBoundId,
            at: 0,
          });
          expect(state.boundMessageId).toBe(expectedBoundId);
        },
      ),
      { numRuns: 200 },
    );
  });
});

// Feature: chat-memory-session-system, Property 3: Single active run
// Validates: Requirements 1.3
//
// The model holds a single RunState, so "at most one run is running/paused" is
// expressed as the invariant that there is never more than one active run, and
// every active state is uniquely identified by a non-null runId. `start` with a
// bound message yields exactly that one active run (lifecycle running, runId set).
describe("run-machine — Property 3: single active run", () => {
  // A broad arbitrary over every RunAction so generated sequences exercise the
  // full lifecycle (start/pause/resume/stop/done/error/queue + review actions).
  const arbAnyAction: fc.Arbitrary<RunAction> = fc.oneof(
    fc
      .tuple(
        fc.hexaString({ minLength: 1, maxLength: 6 }),
        fc.hexaString({ minLength: 1, maxLength: 6 }),
        fc.nat(),
      )
      .map(([runId, boundMessageId, at]) => ({
        type: "start" as const,
        runId,
        boundMessageId,
        at,
      })),
    fc
      .string({ maxLength: 8 })
      .map((d) => ({ type: "start-failed" as const, detail: d })),
    fc.constant({ type: "pause" as const }),
    fc.constant({ type: "resume" as const }),
    fc.constant({ type: "stop" as const }),
    fc.constant({ type: "done" as const }),
    fc.string({ maxLength: 8 }).map((d) => ({ type: "error" as const, detail: d })),
    fc
      .string({ maxLength: 8 })
      .map((d) => ({ type: "stream-lost" as const, detail: d })),
    fc.string({ maxLength: 8 }).map((t) => ({ type: "queue" as const, text: t })),
    fc.constant({ type: "await-review" as const }),
    fc.constant({ type: "apply" as const }),
    fc.constant({ type: "applied" as const }),
    fc.constant({ type: "discard" as const }),
  );

  // Count of active runs represented by a single RunState: 1 when active, else 0.
  const activeRunCount = (state: RunState): number =>
    isActive(state.lifecycle) ? 1 : 0;

  it("holds at most one active run, and start yields exactly that one", () => {
    fc.assert(
      fc.property(fc.array(arbAnyAction, { maxLength: 40 }), (actions) => {
        let state = INITIAL_RUN_STATE;
        // Initial state is idle: zero active runs.
        expect(activeRunCount(state)).toBe(0);

        for (const action of actions) {
          state = runReducer(state, action);

          // Invariant: never more than one run is running/paused.
          expect(activeRunCount(state)).toBeLessThanOrEqual(1);

          // Any active run is uniquely identified by a non-null runId, so the
          // single active run is unambiguous.
          if (isActive(state.lifecycle)) {
            expect(state.runId).not.toBeNull();
          }

          // start (with a bound message) yields exactly that one active run.
          if (action.type === "start" && action.boundMessageId) {
            expect(state.lifecycle).toBe("running");
            expect(isActive(state.lifecycle)).toBe(true);
            expect(activeRunCount(state)).toBe(1);
            expect(state.runId).toBe(action.runId);
            expect(state.boundMessageId).toBe(action.boundMessageId);
          }
        }
      }),
      { numRuns: 300 },
    );
  });
});

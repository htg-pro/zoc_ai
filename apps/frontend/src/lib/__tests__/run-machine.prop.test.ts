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
    .tuple(fc.hexaString({ minLength: 1, maxLength: 6 }), fc.nat())
    .map(([runId, at]) => ({ type: "start" as const, runId, at })),
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
            at: 0,
          });
          expect(state.lifecycle).toBe("running");
          // Start a new run.
          state = runReducer(state, { type: "start", runId: newId, at });
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
    let state: RunState = runReducer(INITIAL_RUN_STATE, { type: "start", runId: "r1", at: 0 });
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
    let state: RunState = runReducer(INITIAL_RUN_STATE, { type: "start", runId: "r2", at: 0 });
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
    const running = runReducer(INITIAL_RUN_STATE, { type: "start", runId: "r3", at: 0 });
    expect(runReducer(running, { type: "apply" }).lifecycle).toBe("running");
    expect(runReducer(running, { type: "discard" }).lifecycle).toBe("running");
  });
});

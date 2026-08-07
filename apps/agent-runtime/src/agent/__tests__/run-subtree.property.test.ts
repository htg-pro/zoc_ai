/**
 * Property 60: Cancelling a parent releases the whole subtree.
 * Validates R25.3, R25.6.
 *
 * Feature: zoc-agent-chat-rebuild, Property 60 (R25.3, R25.6), task 29.3.
 *
 * ## What is under test, and what is not
 *
 * Nothing in the runtime *spawns* a sub-agent Run yet — `parentRunId` is threaded
 * from `RunSubmission` through to `RunRecord` and has no producer, and
 * `RunWriter.forSubAgent` is a different mechanism entirely (sub-agent parts on the
 * **parent's** stream, tagged with `agentName`, no second Slot). So the subject here
 * is the seam a spawner will submit through, exercised by submitting the parent
 * links directly. That is the honest scope of 29.1: the subtree is correct before
 * anything makes one.
 *
 * ## Why the expectation is recomputed rather than read off the store
 *
 * `RunStore.descendantsOf` is the code under test. An oracle built from it would
 * move with it — a cascade that stopped at the first level would satisfy both sides
 * — so {@link expectedSubtree} walks the *generated* parent links instead, with no
 * reference to the store. The two agreeing is the property.
 *
 * ## Real timers, for the reason `run-driver.test.ts` gives
 *
 * A cancelled Run settles after a grace, and R16.1's promise is wall-clock. The
 * grace is set to 5 ms rather than faked, so the assertions run against the code
 * path a user's stop button takes.
 */

import { describe, expect, it } from "vitest";
import fc from "fast-check";

import type { ZocUIChunk } from "../build-agent.ts";
import { RunDriver, RunManager } from "../run-driver.ts";
import { RunStore, SlotManager } from "../run-store.ts";

const RUNS = { numRuns: 120 } as const;

/** Long enough to be a real timer, short enough that 120 runs is not a coffee break. */
const GRACE_MS = 5;

/** A chunk stream that never ends on its own, so every Run settles by cancellation. */
function openStream(): ReadableStream<ZocUIChunk> {
  return new ReadableStream<ZocUIChunk>({ start: () => undefined });
}

const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, GRACE_MS * 4));

/**
 * A forest of Runs: entry `i` names its parent as an index **strictly below** `i`,
 * or null for a root.
 *
 * Encoding the edge as a backward index makes acyclicity a property of the
 * generator rather than something the shrinker has to rediscover, which keeps every
 * counterexample a statement about the cascade. The cycle case is a malformed input
 * rather than a shape a spawner can produce, so it is a unit test below.
 */
const forest = fc
  .array(fc.option(fc.nat({ max: 15 }), { nil: null }), { minLength: 1, maxLength: 12 })
  .map((raw) =>
    raw.map((parent, index) => (parent === null || index === 0 ? null : parent % index)),
  );

interface Harness {
  readonly manager: RunManager;
  readonly slots: SlotManager;
  readonly drivers: readonly RunDriver[];
}

function submitForest(parents: readonly (number | null)[], capacity: number): Harness {
  const store = new RunStore();
  const slots = new SlotManager({ capacity, isLocal: () => false });
  const manager = new RunManager({ store, slots, graceMs: GRACE_MS });

  const drivers = parents.map((parentIndex, index) => {
    const admitted = manager.submit({
      runId: id(index),
      messageId: `msg_${String(index)}`,
      sessionId: "s1",
      provider: "openai",
      model: "gpt-4o",
      conversationMode: "agent",
      permissionMode: "ask",
      parentRunId: parentIndex === null ? null : id(parentIndex),
      open: openStream,
    });
    return admitted.driver;
  });

  return { manager, slots, drivers };
}

const id = (index: number): string => `run_${String(index)}`;

/**
 * The indices beneath `root`, computed from the generated edges alone.
 *
 * Deliberately ignorant of `RunStore`: see the module comment. `root` is excluded,
 * matching `descendantsOf`'s contract.
 */
function expectedSubtree(parents: readonly (number | null)[], root: number): Set<number> {
  const inSubtree = new Set<number>();
  let grew = true;
  while (grew) {
    grew = false;
    parents.forEach((parent, index) => {
      if (parent === null || inSubtree.has(index)) return;
      if (parent === root || inSubtree.has(parent)) {
        inSubtree.add(index);
        grew = true;
      }
    });
  }
  return inSubtree;
}

/** Every Run the Slot manager still counts, on either side of admission. */
function held(slots: SlotManager): readonly string[] {
  return [...slots.activeRunIds, ...slots.queuedRunIds];
}

describe("Property 60: cancelling a parent releases the whole subtree (R25.3, R25.6)", () => {
  it("settles every descendant and leaves every Slot it held released", async () => {
    await fc.assert(
      fc.asyncProperty(
        forest,
        fc.integer({ min: 1, max: 4 }),
        fc.nat({ max: 11 }),
        async (parents, capacity, rootSeed) => {
          const root = rootSeed % parents.length;
          const { manager, slots, drivers } = submitForest(parents, capacity);
          await settle();

          manager.cancel(id(root));
          await settle();

          const subtree = expectedSubtree(parents, root);
          for (const index of subtree) {
            const driver = drivers[index] as RunDriver;
            expect(driver.isSettled).toBe(true);
            expect(driver.record.phase).toBe("cancelled");
          }

          // R25.6's second clause. A held Slot is the resource the cascade exists to
          // free, so a subtree that is "cancelled" while still counted would leave
          // the budget permanently short by its size.
          for (const index of [...subtree, root]) {
            expect(held(slots)).not.toContain(id(index));
          }
        },
      ),
      RUNS,
    );
  });

  it("cancels nothing outside the subtree", async () => {
    await fc.assert(
      fc.asyncProperty(
        forest,
        fc.integer({ min: 1, max: 4 }),
        fc.nat({ max: 11 }),
        async (parents, capacity, rootSeed) => {
          const root = rootSeed % parents.length;
          const { manager, drivers } = submitForest(parents, capacity);
          await settle();

          manager.cancel(id(root));
          await settle();

          const subtree = expectedSubtree(parents, root);
          // The other half of R25.6: a cascade that over-reaches is as wrong as one
          // that stops short, and "cancel the parent" is the only gesture the user made.
          parents.forEach((_parent, index) => {
            if (index === root || subtree.has(index)) return;
            expect(drivers[index]?.isSettled).toBe(false);
            expect(drivers[index]?.record.phase).not.toBe("cancelled");
          });
        },
      ),
      RUNS,
    );
  });

  it("empties the queue of the subtree synchronously, before any grace elapses", async () => {
    // Asserted with **no await** between the cancel and the read, and the queue is the
    // only half that can be. An *active* descendant keeps its Slot until it settles,
    // which is R16.1's 1500 ms grace doing its job — releasing instantly would let a
    // new Run start while the cancelled one's tools were still writing files. A
    // *queued* one has no tools and no stream, so nothing justifies holding its place.
    //
    // The distinction is what makes the no-doomed-promotion reasoning in
    // `RunManager.cancel` hold: a plausible implementation hangs the cascade off the
    // parent's `settled` callback — tidier-looking, since that is already where the
    // Slot is released — and then a queued sub-agent sits in the queue for the whole
    // grace and is promoted into the Slot its own parent's death just freed.
    await fc.assert(
      fc.asyncProperty(
        forest,
        fc.integer({ min: 1, max: 3 }),
        fc.nat({ max: 11 }),
        async (parents, capacity, rootSeed) => {
          const root = rootSeed % parents.length;
          const { manager, slots } = submitForest(parents, capacity);
          await settle();

          manager.cancel(id(root));

          const stillQueued = slots.queuedRunIds;
          for (const index of expectedSubtree(parents, root)) {
            expect(stillQueued).not.toContain(id(index));
          }
        },
      ),
      RUNS,
    );
  });
});

describe("the cascade's edges (R25.6)", () => {
  it("refuses a cycle in parentRunId rather than hanging", async () => {
    // `parentRunId` is a field a caller supplies, so a cycle is reachable input. The
    // visited set is what makes this terminate; without it `descendantsOf` recurses
    // until the event loop is starved and the failure is a timeout with no message.
    const store = new RunStore();
    const slots = new SlotManager({ capacity: 3, isLocal: () => false });
    const manager = new RunManager({ store, slots, graceMs: GRACE_MS });

    for (const [runId, parentRunId] of [
      ["run_a", "run_b"],
      ["run_b", "run_a"],
      ["run_self", "run_self"],
    ] as const) {
      manager.submit({
        runId,
        messageId: `msg_${runId}`,
        sessionId: "s1",
        provider: "openai",
        model: "gpt-4o",
        conversationMode: "agent",
        permissionMode: "ask",
        parentRunId,
        open: openStream,
      });
    }
    await settle();

    expect(store.descendantsOf("run_a").map((run) => run.runId)).toEqual(["run_b"]);
    expect(store.descendantsOf("run_self")).toEqual([]);

    expect(manager.cancel("run_a")).toBe(true);
    await settle();
    expect(store.get("run_b")?.phase).toBe("cancelled");
  });

  it("reports a cancel whose parent had already settled but whose child had not", async () => {
    const store = new RunStore();
    const slots = new SlotManager({ capacity: 3, isLocal: () => false });
    const manager = new RunManager({ store, slots, graceMs: GRACE_MS });

    const submit = (runId: string, parentRunId: string | null) =>
      manager.submit({
        runId,
        messageId: `msg_${runId}`,
        sessionId: "s1",
        provider: "openai",
        model: "gpt-4o",
        conversationMode: "agent",
        permissionMode: "ask",
        parentRunId,
        open: openStream,
      }).driver;

    const parent = submit("run_parent", null);
    submit("run_child", "run_parent");
    await settle();

    parent.cancel();
    await parent.settled;

    // The parent is spent, so `cancelOne` on it is false — but the subtree is not,
    // and a cascade that reported "nothing to cancel" here would be lying about the
    // child it just stopped.
    expect(manager.cancel("run_parent")).toBe(true);
    await settle();
    expect(store.get("run_child")?.phase).toBe("cancelled");
  });

  it("is a no-op for a run id nobody submitted", () => {
    const manager = new RunManager({
      store: new RunStore(),
      slots: new SlotManager({ capacity: 3, isLocal: () => false }),
      graceMs: GRACE_MS,
    });
    expect(manager.cancel("run_absent")).toBe(false);
  });
});

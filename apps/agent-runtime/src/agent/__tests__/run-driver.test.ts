/**
 * The Run driver — zoc-agent-chat-rebuild R7.7, R16.1, 9.7.
 *
 * Feature: zoc-agent-chat-rebuild, task 9.7 (R7.7, R16.1).
 *
 * The tests that matter here are the cancellation ones, and they run on **real
 * timers on purpose**. R16.1's promise is a wall-clock one — "cancel takes effect
 * within 2 seconds" — and a fake clock would assert that the code advances a
 * counter, which is a different claim and the one that stays true after the grace
 * is accidentally moved behind an `await`.
 *
 * The chunk stream is a fixture rather than `streamRun`: what the driver owns is
 * everything that happens *around* the model's chunks — the `seq` space, the grace,
 * and the abandonment set — so the model is exactly the part worth replacing.
 */

import { describe, expect, it, vi } from "vitest";
import type { RunLifecyclePart } from "@zoc-studio/shared-types";

import type { ZocUIChunk } from "../build-agent.ts";
import { CANCEL_GRACE_MS, RunDriver, RunManager } from "../run-driver.ts";
import { RunRecord, RunStore, SlotManager } from "../run-store.ts";

/** A chunk stream under the test's control: `push`, `close`, and nothing else. */
function controllable(): {
  stream: ReadableStream<ZocUIChunk>;
  push: (chunk: ZocUIChunk) => void;
  close: () => void;
} {
  let controller: ReadableStreamDefaultController<ZocUIChunk>;
  const stream = new ReadableStream<ZocUIChunk>({
    start(c) {
      controller = c;
    },
  });
  return {
    stream,
    push: (chunk) => controller.enqueue(chunk),
    close: () => controller.close(),
  };
}

function record(runId = "run_1"): RunRecord {
  return new RunRecord({
    runId,
    sessionId: "s1",
    provider: "openai",
    model: "gpt-4o",
    conversationMode: "agent",
    permissionMode: "ask",
  });
}

/**
 * A tool-input chunk. Cast because the fixture names a tool the `ZocUIMessage`
 * tool set has no member for, which is the point — the driver's abandonment logic
 * reads `type` and `toolCallId` and nothing else.
 */
function toolInput(toolCallId: string): ZocUIChunk {
  return {
    type: "tool-input-available",
    toolCallId,
    toolName: "workspace_run_command",
    input: { command: "sleep 5" },
  } as unknown as ZocUIChunk;
}

function toolOutput(toolCallId: string): ZocUIChunk {
  return { type: "tool-output-available", toolCallId, output: "done" } as unknown as ZocUIChunk;
}

function lifecycle(state: RunLifecyclePart["state"]): ZocUIChunk {
  return {
    type: "data-zoc-run",
    id: "run_1",
    data: {
      type: "run-lifecycle",
      seq: 0,
      runId: "run_1",
      messageId: "msg_1",
      ts: new Date().toISOString(),
      agentName: null,
      state,
    },
  } as unknown as ZocUIChunk;
}

/** Every chunk the record buffered, in `seq` order. */
function framed(driver: RunDriver): ReadonlyArray<{ type: string; seq: number }> {
  return driver.record.ring
    .snapshot()
    .map((entry) => ({ type: (entry.chunk as { type: string }).type, seq: entry.seq }));
}

function lifecycleParts(driver: RunDriver): RunLifecyclePart[] {
  return driver.record.ring
    .snapshot()
    .filter((entry) => (entry.chunk as { type: string }).type === "data-zoc-run")
    .map((entry) => (entry.chunk as { data: RunLifecyclePart }).data);
}

/** Yield to the microtask queue so the driver's read loop can advance. */
const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

describe("RunDriver: the seq space", () => {
  it("numbers every chunk from 1, with no gaps, in emission order (R7.7)", async () => {
    const source = controllable();
    const driver = new RunDriver({
      record: record(),
      messageId: "msg_1",
      open: () => source.stream,
    });

    const running = driver.start();
    await settle();
    source.push(toolInput("call_1"));
    source.push(toolOutput("call_1"));
    source.push(lifecycle("completed"));
    source.close();
    await running;

    expect(framed(driver).map((entry) => entry.seq)).toEqual([1, 2, 3]);
    expect(framed(driver).map((entry) => entry.type)).toEqual([
      "tool-input-available",
      "tool-output-available",
      "data-zoc-run",
    ]);
    expect(await driver.settled).toBe("completed");
    expect(driver.record.phase).toBe("completed");
  });

  it("settles a stream that ends without a terminal lifecycle", async () => {
    // A provider stream that just stops is not a Run without an ending; the record
    // still has to reach a terminal phase or its Slot is never released.
    const source = controllable();
    const driver = new RunDriver({
      record: record(),
      messageId: "msg_1",
      open: () => source.stream,
    });

    const running = driver.start();
    await settle();
    source.close();
    await running;

    expect(await driver.settled).toBe("completed");
  });

  it("reports a Run whose stream could never be opened, rather than hanging", async () => {
    const onInternalError = vi.fn();
    const driver = new RunDriver({
      record: record(),
      messageId: "msg_1",
      open: () => {
        throw new Error("the provider could not be reached");
      },
      onInternalError,
    });

    await driver.start();

    expect(await driver.settled).toBe("failed");
    expect(onInternalError).toHaveBeenCalledOnce();
    const [part] = lifecycleParts(driver);
    expect(part?.state).toBe("failed");
    // R9.8: the thrown message is not the user's sentence.
    expect(part?.message).not.toContain("provider could not be reached");
  });
});

describe("RunDriver: cancellation (R16.1)", () => {
  it("aborts the signal the Run was dispatched with", async () => {
    const source = controllable();
    const seen: AbortSignal[] = [];
    const driver = new RunDriver({
      record: record(),
      messageId: "msg_1",
      graceMs: 20,
      open: (binding) => {
        seen.push(binding.signal);
        return source.stream;
      },
    });

    void driver.start();
    await settle();
    expect(seen[0]?.aborted).toBe(false);

    driver.cancel();
    // Aborted synchronously with the request, not after the grace: a tool that does
    // honour its signal must get the whole grace to unwind, not what is left of it.
    expect(seen[0]?.aborted).toBe(true);
    await driver.settled;
  });

  /**
   * 9.7's guard, stated as the task states it.
   *
   * The tool never settles and never observes its signal — `sleep 5` in a shell is
   * exactly that — so the only thing that can end the Run is the grace. The
   * assertion is on the part's own `ts`, not on the test's stopwatch, because the
   * `ts` is what the transcript will claim and therefore what a user reads.
   */
  it("cancels a Run whose tool sleeps 5 s within 2000 ms of the request", async () => {
    const source = controllable();
    const driver = new RunDriver({
      record: record(),
      messageId: "msg_1",
      open: () => source.stream,
    });

    void driver.start();
    await settle();
    source.push(toolInput("call_1"));
    await settle();

    const requestedAtMs = Date.now();
    driver.cancel();
    const state = await driver.settled;
    const elapsedMs = Date.now() - requestedAtMs;

    expect(state).toBe("cancelled");
    expect(elapsedMs).toBeLessThan(2000);
    expect(elapsedMs).toBeGreaterThanOrEqual(CANCEL_GRACE_MS - 50);

    const cancelled = lifecycleParts(driver).find((part) => part.state === "cancelled");
    expect(cancelled).toBeDefined();
    const stampedAtMs = Date.parse(cancelled?.ts ?? "");
    expect(stampedAtMs - requestedAtMs).toBeGreaterThanOrEqual(0);
    expect(stampedAtMs - requestedAtMs).toBeLessThan(2000);
  }, 6000);

  it("abandons the unsettled tool with code cancelled, before the lifecycle", async () => {
    const source = controllable();
    const driver = new RunDriver({
      record: record(),
      messageId: "msg_1",
      graceMs: 20,
      open: () => source.stream,
    });

    void driver.start();
    await settle();
    source.push(toolInput("call_1"));
    source.push(toolInput("call_2"));
    source.push(toolOutput("call_2"));
    await settle();

    driver.cancel();
    await driver.settled;

    const types = framed(driver).map((entry) => entry.type);
    // Only `call_1` is abandoned: `call_2` settled, and reporting it as abandoned
    // would claim a step failed that had already succeeded.
    const abandoned = driver.record.ring
      .snapshot()
      .map(
        (entry) => entry.chunk as { type: string; toolCallId?: string; providerMetadata?: unknown },
      )
      .filter((chunk) => chunk.type === "tool-output-error");
    expect(abandoned).toHaveLength(1);
    expect(abandoned[0]?.toolCallId).toBe("call_1");
    expect(abandoned[0]?.providerMetadata).toEqual({
      zoc: { code: "cancelled", retryable: false, details: null },
    });

    // Order is the invariant: `SeqFraming` shuts on the terminal lifecycle, so an
    // abandonment written after it would be dropped and the transcript would end
    // with a tool still spinning.
    expect(types.indexOf("tool-output-error")).toBeLessThan(types.lastIndexOf("data-zoc-run"));
  });

  it("lets a tool that honours its signal finish inside the grace", async () => {
    const source = controllable();
    const driver = new RunDriver({
      record: record(),
      messageId: "msg_1",
      graceMs: 200,
      open: () => source.stream,
    });

    void driver.start();
    await settle();
    source.push(toolInput("call_1"));
    await settle();

    driver.cancel();
    // The tool unwinds and `streamRun` writes its own cancelled lifecycle.
    source.push(toolOutput("call_1"));
    source.push(lifecycle("cancelled"));
    source.close();

    expect(await driver.settled).toBe("cancelled");
    const errors = framed(driver).filter((entry) => entry.type === "tool-output-error");
    expect(errors).toEqual([]);
    // One cancelled row, not two: the forced close saw the framing already shut.
    expect(lifecycleParts(driver).filter((part) => part.state === "cancelled")).toHaveLength(1);
  });

  it("keeps draining an abandoned stream, so the partial answer still persists", async () => {
    // R15.6 persists through `onFinish`, which never runs if the reader is torn
    // down — so the chunks after a forced close are dropped by the framing rather
    // than by cancelling the stream.
    const source = controllable();
    const driver = new RunDriver({
      record: record(),
      messageId: "msg_1",
      graceMs: 20,
      open: () => source.stream,
    });

    const running = driver.start();
    await settle();
    source.push(toolInput("call_1"));
    await settle();
    driver.cancel();
    await driver.settled;

    const seqAfterCancel = driver.lastSeq;
    source.push(toolOutput("call_1"));
    source.close();
    await running;

    expect(driver.droppedAfterClose).toBe(1);
    expect(driver.lastSeq).toBe(seqAfterCancel);
  });

  it("is idempotent, and answers false once the Run has settled", async () => {
    const source = controllable();
    const driver = new RunDriver({
      record: record(),
      messageId: "msg_1",
      graceMs: 20,
      open: () => source.stream,
    });

    void driver.start();
    await settle();
    expect(driver.cancel()).toBe(true);
    expect(driver.cancel()).toBe(true);
    await driver.settled;
    expect(driver.cancel()).toBe(false);
    expect(lifecycleParts(driver).filter((part) => part.state === "cancelled")).toHaveLength(1);
  });
});

describe("RunManager: admission and the queue drain (R25.1, R25.2)", () => {
  function manager(capacity: number): {
    manager: RunManager;
    sources: Map<string, ReturnType<typeof controllable>>;
    submit: (runId: string) => ReturnType<RunManager["submit"]>;
  } {
    const store = new RunStore();
    const slots = new SlotManager({ capacity, isLocal: () => false });
    const instance = new RunManager({ store, slots, graceMs: 20 });
    const sources = new Map<string, ReturnType<typeof controllable>>();

    return {
      manager: instance,
      sources,
      submit: (runId) =>
        instance.submit({
          runId,
          messageId: `msg_${runId}`,
          sessionId: `session_${runId}`,
          provider: "openai",
          model: "gpt-4o",
          conversationMode: "agent",
          permissionMode: "ask",
          open: () => {
            const source = controllable();
            sources.set(runId, source);
            return source.stream;
          },
        }),
    };
  }

  it("starts a Run that fits and queues one that does not, with a position", async () => {
    const harness = manager(1);

    const first = harness.submit("run_a");
    const second = harness.submit("run_b");
    await settle();

    expect(first.queuePosition).toBeNull();
    expect(second.queuePosition).toBe(1);
    // The queued Run dispatched nothing: its `open` was never called, which is what
    // keeps a Run fourth in line from reading history or paying for a prompt.
    expect(harness.sources.has("run_a")).toBe(true);
    expect(harness.sources.has("run_b")).toBe(false);
  });

  it("reports the queued Run's position as a part, so it can change", async () => {
    const harness = manager(1);
    harness.submit("run_a");
    const second = harness.submit("run_b");
    harness.submit("run_c");
    await settle();

    expect(lifecycleParts(second.driver).map((part) => part.queuePosition)).toEqual([1]);

    // `run_a` finishes; `run_b` starts and `run_c` moves up. Without the
    // re-announcement, `run_c` would still be showing `2` forever.
    const third = harness.manager.driver("run_c");
    harness.sources.get("run_a")?.close();
    await harness.manager.driver("run_a")?.settled;
    await settle();

    expect(harness.sources.has("run_b")).toBe(true);
    expect(third).not.toBeNull();
    expect(lifecycleParts(third as RunDriver).map((part) => part.queuePosition)).toEqual([2, 1]);
  });

  it("cancels a queued Run without waiting out a grace it cannot use", async () => {
    const harness = manager(1);
    harness.submit("run_a");
    const second = harness.submit("run_b");
    await settle();

    const before = Date.now();
    expect(harness.manager.cancel("run_b")).toBe(true);
    expect(await second.driver.settled).toBe("cancelled");
    expect(Date.now() - before).toBeLessThan(20);
    // And it never dispatches, even though a Slot frees afterwards.
    harness.sources.get("run_a")?.close();
    await harness.manager.driver("run_a")?.settled;
    await settle();
    expect(harness.sources.has("run_b")).toBe(false);
  });

  it("answers hasActiveRun for the Session with a Run in flight", async () => {
    const harness = manager(2);
    harness.submit("run_a");
    await settle();

    expect(harness.manager.hasActiveRun("session_run_a")).toBe(true);
    expect(harness.manager.hasActiveRun("session_elsewhere")).toBe(false);

    harness.sources.get("run_a")?.close();
    await harness.manager.driver("run_a")?.settled;
    expect(harness.manager.hasActiveRun("session_run_a")).toBe(false);
  });
});

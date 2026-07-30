/**
 * Slot admission end to end — zoc-agent-chat-rebuild R25.1, R25.2, task 9.12.
 *
 * Four concurrent submissions against a three-Slot runtime, over real HTTP: three start,
 * the fourth queues at position 1, and it starts when the first finishes. Property 59 in
 * `run-store.property.test.ts` already proves the `SlotManager`'s arithmetic over
 * arbitrary operation sequences, so what is left to prove is the wiring — and the wiring
 * is what an integration test is for. Three things only this level can show:
 *
 *   - the queued Run's `open` is **never called**, so a Run waiting for a Slot has not
 *     dispatched to a provider or read any history;
 *   - the position reaches the caller twice, in the `POST` body *and* as a `queued`
 *     lifecycle part on the stream, because the surface reads the second one;
 *   - the promotion is driven by the first Run *settling*, which is a stream event no
 *     request triggers.
 *
 * Concurrency here is genuine rather than sequential-with-a-comment: the four `POST`s are
 * issued together with `Promise.all`.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import type { RunLifecyclePart } from "@zoc-studio/shared-types";

import { createAdmission } from "../admission.ts";
import { createRequestListener } from "../../main.ts";
import { buildRoutes } from "../routes.ts";
import { registerRunRoutes } from "../run-routes.ts";
import { RunManager } from "../../agent/run-driver.ts";
import { DEFAULT_SLOT_COUNT, RunStore, SlotManager } from "../../agent/run-store.ts";
import type { ZocUIChunk } from "../../agent/build-agent.ts";

const TOKEN = "slot-admission-token-0123456789";

let server: Server;
let port = 0;
let manager: RunManager;
let opened: string[];
let streams: Map<string, { push: (chunk: ZocUIChunk) => void; close: () => void }>;
let nextRun = 0;

function terminal(runId: string): ZocUIChunk {
  return {
    type: "data-zoc-run",
    id: runId,
    data: {
      type: "run-lifecycle",
      seq: 0,
      runId,
      messageId: `msg_${runId}`,
      ts: new Date(0).toISOString(),
      agentName: null,
      state: "completed",
    },
  } as unknown as ZocUIChunk;
}

beforeEach(async () => {
  opened = [];
  streams = new Map();
  nextRun = 0;
  manager = new RunManager({
    store: new RunStore(),
    // The real default, not a test-shaped 3: R25.1's figure is the thing under test, and
    // a hard-coded capacity here would keep passing if the default ever changed.
    slots: new SlotManager({ capacity: DEFAULT_SLOT_COUNT, isLocal: () => false }),
    graceMs: 20,
  });

  const route = buildRoutes(
    { token: TOKEN, workspaceServicesUrl: "http://127.0.0.1:1", workspaceRoot: "/tmp" },
    (router) =>
      registerRunRoutes(router, {
        manager,
        plan: async () => ({
          provider: "openai",
          model: "gpt-4o",
          open: (binding) => {
            opened.push(binding.runId);
            let controller: ReadableStreamDefaultController<ZocUIChunk>;
            const stream = new ReadableStream<ZocUIChunk>({
              start(c) {
                controller = c;
              },
            });
            streams.set(binding.runId, {
              push: (chunk) => controller.enqueue(chunk),
              close: () => controller.close(),
            });
            return stream;
          },
        }),
        newRunId: () => {
          nextRun += 1;
          return `run_${nextRun}`;
        },
        newMessageId: () => `msg_${nextRun}`,
        keepaliveMs: 1_000,
      }),
  );
  server = createServer(createRequestListener(createAdmission({ token: TOKEN }), route));
  await new Promise<void>((resolve) =>
    server.listen(0, "127.0.0.1", () => {
      port = (server.address() as AddressInfo).port;
      resolve();
    }),
  );
});

afterEach(async () => {
  for (const stream of streams.values()) {
    try {
      stream.close();
    } catch {
      /* already closed */
    }
  }
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

interface Submitted {
  runId: string;
  streamUrl: string;
  queuePosition: number | null;
}

async function submit(sessionId: string): Promise<Submitted> {
  const response = await fetch(`http://127.0.0.1:${port}/v1/runs`, {
    method: "POST",
    headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
    body: JSON.stringify({
      sessionId,
      prompt: "do the thing",
      mode: "agent",
      permissionMode: "ask",
      modelRef: { provider: "openai", modelId: "gpt-4o" },
    }),
  });
  expect(response.status).toBe(200);
  return (await response.json()) as Submitted;
}

/** Lifecycle parts buffered on a Run's record, in `seq` order. */
function lifecycles(runId: string): RunLifecyclePart[] {
  return (manager.record(runId)?.ring.snapshot() ?? [])
    .filter((entry) => (entry.chunk as { type: string }).type === "data-zoc-run")
    .map((entry) => (entry.chunk as { data: RunLifecyclePart }).data);
}

const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 20));

describe("four concurrent submissions against a three-Slot runtime (R25.1, R25.2)", () => {
  it("starts three, queues the fourth at position 1, and starts it when the first ends", async () => {
    expect(DEFAULT_SLOT_COUNT).toBe(3);

    // Issued together, not one after another: sequential submits would pass even against
    // an implementation that admitted on arrival order alone.
    const submitted = await Promise.all(
      ["s1", "s2", "s3", "s4"].map((sessionId) => submit(sessionId)),
    );
    await settle();

    const positions = submitted.map((entry) => entry.queuePosition);
    expect(positions.filter((position) => position === null)).toHaveLength(3);
    expect(positions.filter((position) => position === 1)).toHaveLength(1);

    const queued = submitted.find((entry) => entry.queuePosition === 1);
    const started = submitted.filter((entry) => entry.queuePosition === null);
    expect(queued).toBeDefined();

    // The three admitted Runs dispatched; the queued one did not. This is the assertion
    // with teeth: a queued Run whose `open` ran has already paid for a provider call and
    // read a history it will re-read when it actually starts.
    expect(opened.sort()).toEqual(started.map((entry) => entry.runId).sort());
    expect(opened).not.toContain(queued?.runId);

    // And the position is on the stream too, which is where the surface reads it.
    expect(lifecycles(queued?.runId ?? "")).toEqual([
      expect.objectContaining({ state: "queued", queuePosition: 1 }),
    ]);

    // The first Run finishes. Promotion is driven by that settlement, not by a request.
    const first = started[0] as Submitted;
    streams.get(first.runId)?.push(terminal(first.runId));
    streams.get(first.runId)?.close();
    await manager.driver(first.runId)?.settled;
    await settle();

    expect(opened).toContain(queued?.runId);
    expect(manager.record(queued?.runId ?? "")?.phase).toBe("running");
  });

  it("keeps every Run addressable while it waits, so the stream url is not a promise", async () => {
    // The `POST` hands back a `streamUrl` in the same response for a queued Run as for a
    // started one. A stream route that 404'd until a Slot freed would make queueing
    // indistinguishable from failure.
    const submitted = await Promise.all(["s1", "s2", "s3", "s4"].map((s) => submit(s)));
    await settle();
    const queued = submitted.find((entry) => entry.queuePosition === 1) as Submitted;

    expect(queued.streamUrl).toBe(`/v1/runs/${queued.runId}/stream`);
    const response = await fetch(`http://127.0.0.1:${port}${queued.streamUrl}`, {
      headers: { authorization: `Bearer ${TOKEN}`, accept: "text/event-stream" },
    });
    expect(response.status).toBe(200);

    // Replay carries the queued row it already emitted, so a reader attaching late learns
    // its place rather than watching an empty stream.
    const reader = response.body?.getReader();
    const chunk = await reader?.read();
    const frame = new TextDecoder().decode(chunk?.value ?? new Uint8Array());
    expect(frame).toContain('"state":"queued"');
    expect(frame).toContain('"queuePosition":1');
    await reader?.cancel();
  });

  it("re-reports the positions behind a promotion", async () => {
    const submitted = await Promise.all(
      ["s1", "s2", "s3", "s4", "s5"].map((sessionId) => submit(sessionId)),
    );
    await settle();

    const queued = submitted.filter((entry) => entry.queuePosition !== null);
    expect(queued.map((entry) => entry.queuePosition)).toEqual([1, 2]);

    const first = submitted.find((entry) => entry.queuePosition === null) as Submitted;
    streams.get(first.runId)?.push(terminal(first.runId));
    streams.get(first.runId)?.close();
    await manager.driver(first.runId)?.settled;
    await settle();

    // The one that was second is now first, and it said so. A position reported once and
    // never again is silently wrong the moment anything ahead of it finishes.
    const second = queued[1] as Submitted;
    expect(lifecycles(second.runId).map((part) => part.queuePosition)).toEqual([2, 1]);
  });
});

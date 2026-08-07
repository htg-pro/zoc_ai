/**
 * Property 43 (renderer half): Cancellation preserves received parts — zoc-agent-chat-rebuild R16.1,
 * R16.2, task 22.10.
 *
 * *For any* prefix of a Message_Part sequence received before cancellation, every part in that prefix
 * remains rendered afterwards.
 *
 * ## Only half the property lives here
 *
 * Property 43 also claims that files applied before a cancel are unchanged on disk. That half belongs to
 * the runtime suite against a temp workspace (design.md's split note), and it is the load-bearing one —
 * this file asserts the rendered half and nothing about the filesystem. Said plainly here so a later
 * reader does not conclude the property is half-asserted by accident.
 *
 * ## Cancel goes through the transport, not around it
 *
 * Task 22.10 requires the cancel path be the transport's own out-of-band one (11.1), so the panel is
 * mounted with a **real** `ZocChatTransport` over a scripted `fetch` rather than with a fake that records
 * a call. That matters because the defect the property is guarding against is a cancel implemented as
 * `stop()` — aborting the stream reader — which in the AI SDK truncates the in-flight message. A fake
 * `cancel()` cannot tell the two implementations apart; a real transport over a stream this test still
 * holds open can, and does: the terminal `cancelled` part is pushed *after* the cancel and has to arrive.
 *
 * ## Why retention is asserted as a snapshot rather than per part kind
 *
 * "Every part in the prefix is still rendered" enumerated per kind means a selector per kind, and a
 * selector that drifts turns into a vacuous assertion. Instead the transcript's observable state is
 * captured before the cancel — every row id, and the text of every delta delivered — and the same
 * observations are required afterwards. The pre-cancel snapshot is asserted non-empty, which is what
 * stops the whole property from passing against a transcript that rendered nothing.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import fc from "fast-check";
import type {
  DiffPart,
  PermissionRequestPart,
  PlanPart,
  RunLifecyclePart,
  UsagePart,
} from "@zoc-studio/shared-types";

import { ChatPanel, type ChatPanelProps } from "@/features/chat/ChatPanel";
import type { ModelChoice } from "@/features/chat/header/model-catalogue";
import { ZocChatTransport } from "@/features/chat/wire/zoc-transport";
import type { SecretStatus } from "@/lib/secure-store";
import { useGlobalShortcuts } from "@/lib/key-bindings";
import { installFakeLayout, resetChatSurface } from "./transcript-harness";

const BASE = "http://127.0.0.1:41000";
const TOKEN = "launch-token-0123456789abcdef";
const RUN_ID = "run_1";

const MODEL: ModelChoice = {
  provider: "anthropic",
  providerLabel: "Anthropic",
  modelId: "claude-opus-5",
  label: "Opus 5",
  requiresKey: true,
  hasKey: true,
  local: false,
  contextLimit: 200_000,
};

const HEALTHY_SECRETS: SecretStatus = { backend: "keychain", degraded: false, reason: null };

// ── The wire ──────────────────────────────────────────────────────────

/** One SSE frame as the runtime writes it. */
const frame = (seq: number, chunk: unknown): string =>
  `id: ${String(seq)}\ndata: ${JSON.stringify(chunk)}\n\n`;

interface OpenStream {
  readonly response: Response;
  push(text: string): void;
  close(): void;
}

/**
 * A stream the test holds open.
 *
 * The whole point: a cancel arrives while a Run is genuinely in flight, and the terminal part arrives
 * after it. A body that closed on construction would settle the Run before there was anything to cancel.
 */
function openStream(): OpenStream {
  const encoder = new TextEncoder();
  let controller: ReadableStreamDefaultController<Uint8Array> | null = null;
  const body = new ReadableStream<Uint8Array>({
    start: (c) => {
      controller = c;
    },
  });
  return {
    response: new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } }),
    push: (text) => controller?.enqueue(encoder.encode(text)),
    close: () => controller?.close(),
  };
}

const partBase = (seq: number) => ({
  seq,
  runId: RUN_ID,
  messageId: "msg_1",
  ts: "2026-07-31T10:00:00.000Z",
  agentName: null,
});

function usagePart(seq: number): UsagePart {
  return {
    ...partBase(seq),
    type: "usage",
    inputTokens: 120,
    outputTokens: 40,
    reasoningTokens: 0,
    cachedInputTokens: 0,
    contextLimit: 200_000,
    estimatedCostCents: null,
    tokensPerSecond: 41.5,
    messagesInContext: 2,
    sessionMessageCount: 2,
    messagesOutOfWindow: 0,
    summaryActive: false,
  };
}

function diffPart(seq: number, path: string): DiffPart {
  return {
    ...partBase(seq),
    type: "diff",
    planId: "plan_1",
    path,
    action: "modify",
    sourcePath: null,
    language: "typescript",
    hunks: [
      {
        hunkId: "h1",
        oldStart: 10,
        oldLines: 2,
        newStart: 10,
        newLines: 3,
        patch: "-const before = 1;\n+const after = 1;\n+const extra = 2;\n",
      },
    ],
    baseDigest: "sha256:base",
    stale: false,
  };
}

function planPart(seq: number, diff: DiffPart): PlanPart {
  return {
    ...partBase(seq),
    type: "plan",
    planId: "plan_1",
    title: "Refactor the auth module",
    files: [
      {
        path: diff.path,
        action: diff.action,
        sourcePath: null,
        rationale: "why",
        addedLines: 4,
        removedLines: 2,
        hunkCount: diff.hunks.length,
      },
    ],
    verificationCommand: "pnpm test --run",
  };
}

function permissionPart(seq: number): PermissionRequestPart {
  return {
    ...partBase(seq),
    type: "permission-request",
    requestId: "req_1",
    toolCallId: "call_1",
    toolName: "workspace_run_command",
    kind: "execute",
    prompt: "Allow workspace_run_command?",
    paths: ["src/a.ts"],
    reason: "destructive",
    offeredScopes: ["call", "run", "workspace"],
    // Relative to the wall clock: the dock's `now` is `Date.now` through the panel, so a fixed date
    // would expire and quietly take the request with it.
    expiresAt: new Date(Date.now() + 9 * 60_000).toISOString(),
    decision: null,
    decidedScope: null,
  };
}

function lifecyclePart(seq: number, state: RunLifecyclePart["state"]): RunLifecyclePart {
  const needsCode = state === "failed" || state === "interrupted";
  return {
    ...partBase(seq),
    type: "run-lifecycle",
    state,
    code: needsCode ? "stream_lost" : null,
    message: needsCode ? "The stream ended before the run finished." : null,
  };
}

// ── The generated sequence ────────────────────────────────────────────

type Item =
  | { readonly kind: "text"; readonly text: string }
  | { readonly kind: "usage" }
  | { readonly kind: "plan" }
  | { readonly kind: "permission" }
  | { readonly kind: "running" };

/** Markdown-inert words, so a delta's text is findable in `textContent` unaltered. */
const WORDS = ["alpha", "bravo", "charlie", "delta", "echo", "foxtrot", "golf", "hotel"] as const;

const item: fc.Arbitrary<Item> = fc.oneof(
  fc
    .array(fc.constantFrom(...WORDS), { minLength: 1, maxLength: 3 })
    .map((words) => ({ kind: "text" as const, text: `${words.join(" ")} ` })),
  fc.constant({ kind: "usage" as const }),
  fc.constant({ kind: "plan" as const }),
  fc.constant({ kind: "permission" as const }),
  fc.constant({ kind: "running" as const }),
);

/**
 * A sequence and a cut point.
 *
 * The property is about a *prefix* received before the cancel, so the cut is part of the input rather
 * than fixed at the end: `1 + (cut % length)` items are delivered, which ranges over every prefix
 * including the whole sequence.
 */
const sequenceAndCut: fc.Arbitrary<{ items: readonly Item[]; cut: number }> = fc
  .tuple(fc.array(item, { minLength: 1, maxLength: 6 }), fc.nat({ max: 32 }))
  .map(([items, cut]) => ({ items, cut }));

/** The frames one item becomes, appended to `out` with running sequence numbers. */
function framesFor(entry: Item, seq: number): { frames: string[]; nextSeq: number } {
  switch (entry.kind) {
    case "text":
      // One id for every delta, so they concatenate into a single answer part — which is what makes
      // "the text I already received is still there" a claim about retention rather than about parts.
      //
      // The matching `text-start` is emitted once before the sequence rather than per item: the AI SDK
      // rejects a delta for a part it has not been told about, and the rejection surfaces as a failed
      // Run — which would take the cancel control with it and make this property unfalsifiable.
      return {
        frames: [frame(seq, { type: "text-delta", id: "t1", delta: entry.text })],
        nextSeq: seq + 1,
      };
    case "usage":
      return {
        frames: [
          frame(seq, { type: "data-zoc-usage", id: `u${String(seq)}`, data: usagePart(seq) }),
        ],
        nextSeq: seq + 1,
      };
    case "plan": {
      const diff = diffPart(seq + 1, "src/a.ts");
      return {
        frames: [
          frame(seq, { type: "data-zoc-plan", id: "plan_1", data: planPart(seq, diff) }),
          frame(seq + 1, { type: "data-zoc-diff", id: "plan_1|src/a.ts", data: diff }),
        ],
        nextSeq: seq + 2,
      };
    }
    case "permission":
      return {
        frames: [
          frame(seq, { type: "data-zoc-permission", id: "req_1", data: permissionPart(seq) }),
        ],
        nextSeq: seq + 1,
      };
    case "running":
      return {
        frames: [
          frame(seq, { type: "data-zoc-run", id: RUN_ID, data: lifecyclePart(seq, "running") }),
        ],
        nextSeq: seq + 1,
      };
  }
}

// ── The panel over a real transport ───────────────────────────────────

interface Mounted {
  readonly stream: OpenStream;
  readonly urls: string[];
}

/**
 * A fresh Session id per mount.
 *
 * `useChat` is keyed by it, and a second mount under the same id resumes the first mount's chat —
 * including the transport it was constructed with — so every iteration after the first would drive a
 * transport whose `fetch` this test is not watching.
 */
let mounts = 0;

function mount(): Mounted {
  mounts += 1;
  const stream = openStream();
  const urls: string[] = [];

  const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    urls.push(url);
    if (url.endsWith("/v1/runs")) {
      return new Response(
        JSON.stringify({ runId: RUN_ID, streamUrl: `/v1/runs/${RUN_ID}/stream` }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }
    if (url.includes("/cancel")) {
      return new Response(JSON.stringify({ accepted: true }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    return stream.response;
  });

  const transport = new ZocChatTransport({
    endpoint: async () => ({ baseUrl: BASE, token: TOKEN }),
    submission: () => ({
      mode: "agent",
      permissionMode: "ask",
      modelRef: { provider: MODEL.provider, modelId: MODEL.modelId },
      mentions: [],
    }),
    activeRun: () => null,
    onRunProgress: () => {},
    fetchImpl: fetchImpl as unknown as typeof fetch,
    sleep: async () => {},
  });

  const props: ChatPanelProps = {
    sessionId: `session-${String(mounts)}`,
    sessionTitle: "A session",
    sessions: [],
    workspaceRoot: "/home/dev/archivezip",
    models: [MODEL],
    selectedModel: MODEL,
    onSelectModel: vi.fn(),
    permissionMode: "ask",
    onPermissionModeChange: vi.fn(),
    onSelectSession: vi.fn(),
    secretStatus: HEALTHY_SECRETS,
    transport,
  };
  render(<ChatPanel {...props} />);
  return { stream, urls };
}

const el = (selector: string): HTMLElement | null => document.querySelector<HTMLElement>(selector);

/** The window-level `mod+enter` / `mod+.` listener the shell installs (R23.3). */
function GlobalBindings(): null {
  useGlobalShortcuts();
  return null;
}

const rowIds = (): string[] =>
  [...document.querySelectorAll<HTMLElement>("[data-zoc-row-id]")].map(
    (node) => node.getAttribute("data-zoc-row-id") ?? "",
  );

const transcriptText = (): string => el("[data-zoc-transcript-scroll]")?.textContent ?? "";

let uninstallLayout: () => void;

beforeEach(() => {
  resetChatSurface();
  uninstallLayout = installFakeLayout();
});

afterEach(() => {
  cleanup();
  uninstallLayout();
  vi.restoreAllMocks();
});

describe("Feature: zoc-agent-chat-rebuild, task 22.10 — Property 43: cancellation (R16.1, R16.2)", () => {
  it("keeps every part received before the cancel, and takes the cancel out of band", async () => {
    await fc.assert(
      fc.asyncProperty(sequenceAndCut, async ({ items, cut }) => {
        resetChatSurface();
        const { stream, urls } = mount();
        // `finally`, not a trailing call: an iteration that fails must still unmount, or every
        // shrink run after it queries a stale panel and reports the wrong failure.
        try {
          const input = el("[data-zoc-composer-input]");
          expect(input).not.toBeNull();
          fireEvent.change(input as HTMLElement, { target: { value: "explain the store" } });
          const send = el("[data-zoc-send]");
          expect(send).not.toBeNull();
          fireEvent.click(send as HTMLElement);

          await waitFor(() => {
            expect(urls.some((url) => url.endsWith("/v1/runs"))).toBe(true);
          });

          // The Run's own opening frame. The panel learns the `runId` from the transcript rather than
          // from the run request, so this is what makes the cancel route addressable at all — a
          // generated prefix without it would be testing a Run the panel has no identifier for.
          stream.push(
            frame(1, { type: "data-zoc-run", id: RUN_ID, data: lifecyclePart(1, "running") }),
          );

          const delivered = items.slice(0, 1 + (cut % items.length));
          const deliveredText = delivered
            .filter((entry): entry is { kind: "text"; text: string } => entry.kind === "text")
            .map((entry) => entry.text.trim());

          let seq = 2;
          if (deliveredText.length > 0) {
            stream.push(frame(seq, { type: "text-start", id: "t1" }));
            seq += 1;
          }
          for (const entry of delivered) {
            const { frames, nextSeq } = framesFor(entry, seq);
            seq = nextSeq;
            for (const text of frames) stream.push(text);
          }

          // Wait for the prefix to actually *be* rendered rather than merely delivered. "Received before
          // cancellation" is a claim about what is on screen, and a streamed delta reaches the DOM a
          // frame or two after it reaches the transport — cancelling before that would assert retention
          // of something that had not been retained yet.
          await waitFor(() => {
            expect(rowIds().length).toBeGreaterThan(0);
            for (const text of deliveredText) expect(transcriptText()).toContain(text);
          });

          // The snapshot, and the guard that makes it worth comparing against.
          const before = { ids: rowIds(), text: transcriptText() };
          expect(
            before.ids.length,
            "the prefix rendered nothing, so retention would be vacuous",
          ).toBeGreaterThan(0);

          // Cancel, through the control the panel offers and the transport's own route.
          const cancel = el("[data-zoc-run-cancel]");
          expect(cancel, "an in-flight Run offers cancel (R16.1)").not.toBeNull();
          fireEvent.click(cancel as HTMLElement);
          await waitFor(() => {
            expect(urls.some((url) => url === `${BASE}/v1/runs/${RUN_ID}/cancel`)).toBe(true);
          });

          // The stream was not aborted, so the runtime's own closing frames still arrive. A cancel
          // implemented as `stop()` fails here rather than silently truncating the message.
          if (deliveredText.length > 0) {
            stream.push(frame(seq, { type: "text-end", id: "t1" }));
            seq += 1;
          }
          stream.push(
            frame(seq, { type: "data-zoc-run", id: RUN_ID, data: lifecyclePart(seq, "cancelled") }),
          );
          stream.close();

          // The pill after the cancel, and the one place the expectation is conditional.
          //
          // `panel-state`'s first rule is that a pending approval outranks the lifecycle state: the dock
          // is blocking progress, so "Waiting for you" is what the Run is doing. A prefix carrying an
          // undecided request therefore settles on `awaiting-approval` rather than `cancelled` — the
          // runtime retracts its own requests when a Run ends, and this test does not speak for it. The
          // unconditional arm is the one that proves the terminal frame arrived at all, which is what
          // rules out a cancel that aborted the reader.
          const expectedPill = delivered.some((entry) => entry.kind === "permission")
            ? "awaiting-approval"
            : "cancelled";
          await waitFor(() => {
            expect(el(`[data-zoc-run-pill="${expectedPill}"]`)).not.toBeNull();
          });

          // Retention: every row that was there is still there, and every delta's text survived.
          const after = { ids: rowIds(), text: transcriptText() };
          for (const id of before.ids) {
            expect(after.ids, `row ${id} was dropped by the cancel`).toContain(id);
          }
          for (const text of deliveredText) {
            expect(after.text, `"${text}" was dropped by the cancel`).toContain(text);
          }
        } finally {
          cleanup();
        }
      }),
      { numRuns: 20 },
    );
  });

  it("leaves the composer usable, because a cancelled Run is not a failure", async () => {
    resetChatSurface();
    const { stream, urls } = mount();

    fireEvent.change(el("[data-zoc-composer-input]") as HTMLElement, {
      target: { value: "explain the store" },
    });
    fireEvent.click(el("[data-zoc-send]") as HTMLElement);
    await waitFor(() => {
      expect(urls.some((url) => url.endsWith("/v1/runs"))).toBe(true);
    });

    stream.push(frame(1, { type: "data-zoc-run", id: RUN_ID, data: lifecyclePart(1, "running") }));
    stream.push(frame(2, { type: "text-start", id: "t1" }));
    stream.push(frame(3, { type: "text-delta", id: "t1", delta: "alpha bravo" }));
    await waitFor(() => {
      expect(transcriptText()).toContain("alpha bravo");
    });
    fireEvent.click(el("[data-zoc-run-cancel]") as HTMLElement);
    // `text-end` before the terminal frame, which is what the runtime writes: a stream that closes with
    // a part still open is a *lost* stream, and the transport reports `interrupted` for it rather than
    // `cancelled`. Getting that order wrong here would test the interrupted path by accident.
    stream.push(frame(4, { type: "text-end", id: "t1" }));
    stream.push(
      frame(5, { type: "data-zoc-run", id: RUN_ID, data: lifecyclePart(5, "cancelled") }),
    );
    stream.close();

    await waitFor(() => {
      expect(el('[data-zoc-run-pill="cancelled"]')).not.toBeNull();
    });
    // Back to send rather than queue: the Run has settled, so the next submission goes straight out.
    expect(el("[data-zoc-send]")?.getAttribute("data-zoc-send-mode")).toBe("send");
    expect(el("[data-zoc-run-cancel]")).toBeNull();
    expect(transcriptText()).toContain("alpha bravo");
  });

  it("cancels through `mod+.` as well, which is the same out-of-band request (R20.4, task 24.2)", async () => {
    // The keyboard route exists to reach this same POST, and it can only do so if the panel handed the
    // composer a live Run state and its cancel handler — the wiring task 24.2 added. Asserted here rather
    // than against a mounted `Composer`, because a composer given `runState="running"` by a test proves
    // nothing about what `ChatPanel` passes it.
    resetChatSurface();
    const { stream, urls } = mount();
    // The shell installs the listener, not the panel, so the test installs it the same way.
    render(<GlobalBindings />);

    fireEvent.change(el("[data-zoc-composer-input]") as HTMLElement, {
      target: { value: "explain the store" },
    });
    fireEvent.click(el("[data-zoc-send]") as HTMLElement);
    await waitFor(() => {
      expect(urls.some((url) => url.endsWith("/v1/runs"))).toBe(true);
    });
    stream.push(frame(1, { type: "data-zoc-run", id: RUN_ID, data: lifecyclePart(1, "running") }));
    await waitFor(() => {
      expect(el("[data-zoc-run-cancel]")).not.toBeNull();
    });

    // At `document.body`, which bubbles to the `window` listener and is not a text field — the composer's
    // own Escape/Enter handling never sees it.
    fireEvent.keyDown(document.body, { key: ".", ctrlKey: true });
    await waitFor(() => {
      expect(urls.some((url) => url === `${BASE}/v1/runs/${RUN_ID}/cancel`)).toBe(true);
    });

    stream.push(
      frame(2, { type: "data-zoc-run", id: RUN_ID, data: lifecyclePart(2, "cancelled") }),
    );
    stream.close();
    await waitFor(() => {
      expect(el('[data-zoc-run-pill="cancelled"]')).not.toBeNull();
    });
    // And once it has settled the keystroke stops doing anything, because the Slot is released.
    const before = urls.length;
    fireEvent.keyDown(document.body, { key: ".", ctrlKey: true });
    expect(urls).toHaveLength(before);
  });
});

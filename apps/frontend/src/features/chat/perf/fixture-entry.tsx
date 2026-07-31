/**
 * The `@perf` fixture — zoc-agent-chat-rebuild task 17.6, budgets 19.4 and 20.5.
 *
 * Mounts the real `Transcript` in a real browser and exposes an imperative handle on `window` so the
 * CDP harness can drive it: build an N-message Session, then stream parts at a scripted rate while the
 * page samples animation-frame intervals and long tasks.
 *
 * ## Why the state lives outside React
 *
 * The driver is a `Runtime.evaluate` call, which has no way to reach a `useState` setter. A tiny
 * external store read through `useSyncExternalStore` is the whole adapter, and it keeps the fixture
 * honest in the way that matters: the component under measurement is the shipped `Transcript` with the
 * shipped props, not a variant with test affordances threaded through it.
 *
 * ## Why the samples are taken in the page rather than over the protocol
 *
 * An animation-frame interval measured by asking the browser for a timestamp over a WebSocket would be
 * measuring the WebSocket. The page records its own `requestAnimationFrame` deltas and its own
 * `longtask` entries, and hands back the summary — so the only thing crossing the protocol is a number.
 */

import { useSyncExternalStore } from "react";
import { createRoot } from "react-dom/client";

import { Transcript } from "@/features/chat/Transcript";
import { Composer } from "@/features/chat/composer/Composer";
import type { ContextCensus, ModelReference } from "@/features/chat/composer/context-figures";
import type { MentionCandidate } from "@/features/chat/composer/mention-index";
import { detectMentionQuery } from "@/features/chat/composer/mention-query";
import { useChatSurface } from "@/features/chat/store";
import { ChatMotionProvider } from "@/lib/reduced-motion-provider";
import type { ZocUIMessage } from "@/features/chat/wire/ui-message";
import "@/styles/globals.css";

// ── The external store ────────────────────────────────────────────────

interface FixtureState {
  readonly messages: readonly ZocUIMessage[];
  readonly streaming: boolean;
  /** The mention snapshot the composer indexes (R12.2's 20,000 paths). */
  readonly candidates: readonly MentionCandidate[];
}

let state: FixtureState = { messages: [], streaming: false, candidates: [] };
const listeners = new Set<() => void>();

function setState(next: Partial<FixtureState>): void {
  state = { ...state, ...next };
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function snapshot(): FixtureState {
  return state;
}

// ── Fixture content ───────────────────────────────────────────────────

/** One paragraph of plausible assistant prose, repeated to reach a realistic message length. */
const PROSE =
  "The runtime resolved the workspace root, read the file, and applied the change to the region " +
  "the plan named. The remaining hunks are unaffected. ";

function metadataOf(runId: string): NonNullable<ZocUIMessage["metadata"]> {
  return {
    runId,
    provider: "anthropic",
    model: "claude-opus-5",
    conversationMode: "agent",
    startedAt: "2026-07-31T10:00:00.000Z",
    finishedAt: "2026-07-31T10:00:04.000Z",
    inputTokens: 1_200,
    outputTokens: 480,
    estimatedCostCents: 3,
    tokensPerSecond: 42,
    messagesInContext: 24,
    sessionMessageCount: 500,
    messagesOutOfWindow: 0,
    summaryActive: false,
    rulesSources: [],
  };
}

/**
 * An N-message Session.
 *
 * Mixed on purpose: R20.5's 500-message figure is about a Session a user actually accumulated, and a
 * transcript of 500 one-line prompts would understate both the heap and the measurement cost. Every
 * fourth assistant turn carries a tool timeline and a usage line, which is roughly the shape of a
 * working session.
 */
function buildMessages(count: number): ZocUIMessage[] {
  const messages: ZocUIMessage[] = [];
  for (let index = 0; index < count; index += 1) {
    const id = `m${String(index)}`;
    if (index % 2 === 0) {
      messages.push({
        id,
        role: "user",
        metadata: metadataOf(id),
        parts: [{ type: "text", text: `Turn ${String(index)}: change the thing and explain why.` }],
      });
      continue;
    }

    const parts: ZocUIMessage["parts"] = [
      { type: "text", text: PROSE.repeat(4), state: "done" },
    ];
    if (index % 4 === 1) {
      for (let call = 0; call < 3; call += 1) {
        parts.push({
          type: "dynamic-tool",
          toolName: call === 2 ? "workspace_apply_hunks" : "workspace_read",
          toolCallId: `${id}-call-${String(call)}`,
          state: "output-available",
          input: { path: `src/module-${String(call)}.ts` },
          output: { bytes: 2_048 },
        } as unknown as ZocUIMessage["parts"][number]);
      }
      parts.push({
        type: "data-zoc-usage",
        data: {
          type: "usage",
          seq: index,
          runId: id,
          messageId: id,
          ts: "2026-07-31T10:00:04.000Z",
          inputTokens: 1_200,
          outputTokens: 480,
          reasoningTokens: 0,
          cachedInputTokens: 300,
          contextLimit: 200_000,
          estimatedCostCents: 3,
          tokensPerSecond: 42,
          messagesInContext: 24,
          sessionMessageCount: count,
          messagesOutOfWindow: 0,
          summaryActive: false,
        },
      } as unknown as ZocUIMessage["parts"][number]);
    }
    messages.push({ id, role: "assistant", metadata: metadataOf(id), parts });
  }
  return messages;
}

// ── The imperative handle ─────────────────────────────────────────────

export interface StreamOptions {
  partsPerSecond: number;
  durationMs: number;
}

export interface StreamReport {
  /** The 95th-percentile interval between two animation frames, in milliseconds. */
  p95IntervalMs: number;
  frameSamples: number;
  /** `longtask` entries observed over the whole stream. */
  longTasks: number;
  /** Parts appended, so the driver can check the stream ran at the rate it asked for. */
  parts: number;
}

export interface PerfApi {
  setMessageCount(count: number): Promise<number>;
  stream(options: StreamOptions): Promise<StreamReport>;
  toolCallLatency(calls: number): Promise<LatencyReport>;
  mentionLatency(options: MentionLatencyOptions): Promise<LatencyReport>;
}

export interface MentionLatencyOptions {
  /** How many candidates to index. R12.2 names 20,000. */
  indexed: number;
  /** How many keystrokes to measure. */
  keystrokes: number;
}

export interface LatencyReport {
  /** The worst receipt-to-commit interval over the run, in milliseconds. */
  maxMs: number;
  /** The median, for context on whether the maximum is an outlier or the norm. */
  medianMs: number;
  samples: number;
}

/** How long a single entry may take to reach the document before the measurement gives up. */
const POLL_DEADLINE_MS = 5_000;

/** Two frames, which is how long it takes a commit plus its layout effect to be on screen. */
function nextFrames(): Promise<void> {
  return new Promise((resolve) => {
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        resolve();
      });
    });
  });
}

function percentile(samples: readonly number[], fraction: number): number {
  if (samples.length === 0) return 0;
  const sorted = [...samples].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.floor(fraction * sorted.length));
  return sorted[index] ?? 0;
}

const api: PerfApi = {
  async setMessageCount(count) {
    setState({ messages: buildMessages(count), streaming: false });
    await nextFrames();
    return count;
  },

  async stream({ partsPerSecond, durationMs }) {
    const settled = state.messages;
    const intervalMs = 1_000 / partsPerSecond;

    const intervals: number[] = [];
    let previousFrame = performance.now();
    let sampling = true;
    const onFrame = (now: number) => {
      intervals.push(now - previousFrame);
      previousFrame = now;
      if (sampling) requestAnimationFrame(onFrame);
    };
    requestAnimationFrame(onFrame);

    let longTasks = 0;
    let observer: PerformanceObserver | null = null;
    try {
      observer = new PerformanceObserver((list) => {
        longTasks += list.getEntries().length;
      });
      observer.observe({ entryTypes: ["longtask"] });
    } catch {
      // Chromium supports `longtask`; a browser that does not reports zero, and the driver asserts
      // the entry type was observable separately rather than reading a silent zero as a pass.
      observer = null;
    }

    let parts = 0;
    let text = "";
    const startedAt = performance.now();
    await new Promise<void>((resolve) => {
      const tick = () => {
        if (performance.now() - startedAt >= durationMs) {
          resolve();
          return;
        }
        text += `${PROSE.slice(0, 24)} `;
        parts += 1;
        setState({
          messages: [
            ...settled,
            {
              id: "streaming-tail",
              role: "assistant",
              metadata: metadataOf("streaming-tail"),
              parts: [{ type: "text", text, state: "streaming" }],
            },
          ],
          streaming: true,
        });
        window.setTimeout(tick, intervalMs);
      };
      window.setTimeout(tick, intervalMs);
    });

    sampling = false;
    observer?.disconnect();
    setState({ streaming: false });
    await nextFrames();

    return {
      // The first interval is measured from before the loop started and is not an inter-frame gap.
      p95IntervalMs: percentile(intervals.slice(1), 0.95),
      frameSamples: Math.max(0, intervals.length - 1),
      longTasks,
      parts,
    };
  },

  /**
   * Task 16.1's owed measurement: from a tool part's receipt to its entry being on screen.
   *
   * "Receipt" is the moment the part is applied to the message list, which in the shipped app is where
   * the transport hands a chunk to `useChat` — the fixture stands in for the transport and nothing
   * else. "On screen" is the entry's own element existing in the document, found by the `toolCallId`
   * the timeline puts on its `<li>`, which is why this can be measured without instrumenting the
   * component.
   *
   * Serial by design: append, wait for the commit, record, append again. A parallel version would
   * measure the last call's latency plus the queueing of the twenty-nine before it, which is a
   * different number and not the one R9.2's 200 ms is about.
   */
  /**
   * R12.2's keystroke-to-paint, in a real browser.
   *
   * Each keystroke is measured from the moment the draft changes to the moment the popover has rows on
   * screen for it, and the popover is closed between keystrokes so the edge is unambiguous — "rows
   * appeared" rather than "rows changed", which is not observable without instrumenting the component.
   *
   * The interval therefore includes the 60 ms debounce, and that is deliberate: R12.2 is about how long a
   * user waits, and the debounce is part of the wait. It is also why the debounce is 60 ms rather than
   * something rounder — it has to leave room for the search and the commit inside 100 ms.
   */
  async mentionLatency({ indexed, keystrokes }) {
    setState({ candidates: buildCandidates(indexed), messages: [], streaming: false });
    await nextFrames();

    const store = useChatSurface.getState();
    const targets = ["session-1", "token-99", "auth-4", "render-1234", "stream-7"];
    const intervals: number[] = [];

    for (let keystroke = 0; keystroke < keystrokes; keystroke += 1) {
      const target = targets[keystroke % targets.length] ?? "session";
      const query = target.slice(0, (keystroke % target.length) + 1);

      // Close the popover first, so what is measured is rows *appearing* for this query.
      store.setDraft("");
      store.setMentionQuery(null);
      await nextFrames();

      const draft = `@${query}`;
      const receivedAt = performance.now();
      store.setDraft(draft);
      store.setMentionQuery(detectMentionQuery(draft, draft.length));

      const painted = await new Promise<boolean>((resolve) => {
        const deadline = receivedAt + POLL_DEADLINE_MS;
        const poll = () => {
          if (document.querySelector("[data-zoc-mention-item]") !== null) {
            resolve(true);
            return;
          }
          if (performance.now() > deadline) {
            resolve(false);
            return;
          }
          requestAnimationFrame(poll);
        };
        requestAnimationFrame(poll);
      });
      // A query that matched nothing is not a latency sample: there is nothing to paint. Skipped rather
      // than recorded as zero, which would flatter the maximum.
      if (painted) intervals.push(performance.now() - receivedAt);
    }

    store.setDraft("");
    store.setMentionQuery(null);
    await nextFrames();

    return {
      maxMs: intervals.length === 0 ? 0 : Math.max(...intervals),
      medianMs: percentile(intervals, 0.5),
      samples: intervals.length,
    };
  },

  async toolCallLatency(calls) {
    const settled = state.messages;
    const intervals: number[] = [];
    const parts: ZocUIMessage["parts"] = [{ type: "text", text: PROSE, state: "streaming" }];

    for (let call = 0; call < calls; call += 1) {
      const toolCallId = `latency-call-${String(call)}`;
      parts.push({
        type: "dynamic-tool",
        // Alternating names, so no four *consecutive* calls share one and R9.5's clustering never
        // fires. A cluster keeps its members behind a disclosure, so from the fourth call on there
        // would be no element to find and the measurement would hang rather than report a latency —
        // which is a fact about the timeline's grouping, not about how fast an entry commits.
        toolName: call % 2 === 0 ? "workspace_read" : "workspace_grep",
        toolCallId,
        state: "output-available",
        input: { path: `src/measured-${String(call)}.ts` },
        output: { bytes: 512 },
      } as unknown as ZocUIMessage["parts"][number]);

      const receivedAt = performance.now();
      setState({
        messages: [
          ...settled,
          {
            id: "latency-tail",
            role: "assistant",
            metadata: metadataOf("latency-tail"),
            parts: [...parts],
          },
        ],
        streaming: true,
      });

      await new Promise<void>((resolve, reject) => {
        const deadline = receivedAt + POLL_DEADLINE_MS;
        const poll = () => {
          if (document.querySelector(`[data-zoc-tool-entry="${toolCallId}"]`) !== null) {
            intervals.push(performance.now() - receivedAt);
            resolve();
            return;
          }
          if (performance.now() > deadline) {
            // A rejection rather than a silent give-up: the driver then reports "the entry never
            // committed", which is a different failure from "it committed too slowly" and would
            // otherwise arrive as an opaque protocol timeout.
            reject(new Error(`The entry for ${toolCallId} never reached the document.`));
            return;
          }
          requestAnimationFrame(poll);
        };
        requestAnimationFrame(poll);
      });
    }

    setState({ streaming: false });
    await nextFrames();

    return {
      maxMs: intervals.length === 0 ? 0 : Math.max(...intervals),
      medianMs: percentile(intervals, 0.5),
      samples: intervals.length,
    };
  },
};

/** A synthetic workspace for the mention index, shaped like a real one. */
function buildCandidates(count: number): MentionCandidate[] {
  const words = ["auth", "session", "token", "render", "stream", "parse", "store", "index"];
  const candidates: MentionCandidate[] = [];
  for (let index = 0; index < count; index += 1) {
    const word = words[index % words.length] ?? "file";
    const label = `${word}-${String(index)}.ts`;
    candidates.push({
      id: `files:${String(index)}`,
      category: "files",
      ref: `src/${word}/${String(index % 40)}/${label}`,
      label,
      detail: `src/${word}/${String(index % 40)}`,
      estimatedTokens: 100 + (index % 900),
    });
  }
  return candidates;
}

const PERF_MODEL: ModelReference = {
  provider: "anthropic",
  modelId: "claude-opus-5",
  contextLimit: 200_000,
};

const PERF_CENSUS: ContextCensus = {
  messagesInContext: 12,
  sessionMessageCount: 40,
  messagesOutOfWindow: 28,
  summaryActive: false,
  consumedTokens: 4_000,
  measuredAgainst: PERF_MODEL,
};

// ── Mount ─────────────────────────────────────────────────────────────

/**
 * Exported only so this file satisfies the fast-refresh rule, which requires a module holding a
 * component to export one. Nothing imports it: the entry mounts itself.
 */
export function Fixture() {
  const current = useSyncExternalStore(subscribe, snapshot, snapshot);
  return (
    <ChatMotionProvider budget={null}>
      {/* A fixed viewport, so the number of rows on screen is not a property of the runner. */}
      <div style={{ height: "600px", display: "flex", flexDirection: "column" }}>
        <Transcript messages={current.messages} streaming={current.streaming} />
      </div>
      {/*
        The composer is mounted beside the transcript rather than in a second fixture page: the mention
        popover's cost depends on the surface it renders into, and a page with no transcript would measure
        a lighter document than the app ever has.
      */}
      <Composer
        streaming={false}
        candidates={current.candidates}
        model={PERF_MODEL}
        census={PERF_CENSUS}
        permissionMode="ask"
        workspaceRoot="/workspace"
        onSubmit={() => undefined}
      />
    </ChatMotionProvider>
  );
}

const container = document.getElementById("zoc-perf-root");
if (container !== null) {
  // No `StrictMode`: it double-renders and double-invokes effects by design, which is the right
  // default for finding bugs and the wrong one for measuring frame intervals and heap.
  createRoot(container).render(<Fixture />);
  (window as Window & { __zocPerf?: PerfApi }).__zocPerf = api;
}

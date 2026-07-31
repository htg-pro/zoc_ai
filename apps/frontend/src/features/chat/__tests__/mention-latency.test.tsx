/**
 * The mention picker's latency guard and the first-part marks — zoc-agent-chat-rebuild R12.2, R20.1,
 * tasks 20.2 and 20.10.
 *
 * Two measurements the requirements name and nothing else in the plan took.
 *
 * **R12.2 — the search half of keystroke-to-paint, under 100 ms over a 20,000-path index.** Fifty queries
 * against a real 20,000-candidate index, measured one at a time. The assertion is on the *maximum*, not a
 * percentile: the budget is about the keystroke a user notices, and a median under budget with one 400 ms
 * outlier is exactly the case a percentile hides.
 *
 * The *paint* half runs in the `@perf` tier, and the split is forced rather than chosen — see below.
 *
 * **R20.1 — the submit-to-first-paint measure exists and is taken between the two marks.** The budget's own
 * numbers (1200 ms p50, 2500 ms p95) need a stub provider and forty real submissions through the transport,
 * which is the panel's harness rather than this one — recorded as owed by 22.x. What is asserted here is
 * the instrumentation itself: that the marks are set at the two points, that the measure spans them, and
 * that a refused submission never produces one.
 *
 * ## Why the paint half is not measured here
 *
 * Rendering fifty `cmdk` rows inside a Radix popover costs roughly 350 ms *in jsdom* — six times what the
 * same commit costs in Chromium, because jsdom's DOM is an object graph in JavaScript and the browser's is
 * not. Asserting a 100 ms browser budget against that number would produce a test that fails for a reason
 * the requirement is not about, so the DOM half moved to the `@perf` tier, where the browser is real
 * (`transcript-budgets.perf.test.ts`). What stays here is the part jsdom measures faithfully because it
 * touches no DOM at all: building the index and searching it, which is also where the algorithmic risk is.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render } from "@testing-library/react";

import { ChatMotionProvider } from "@/lib/reduced-motion-provider";
import { Composer } from "@/features/chat/composer/Composer";
import type { ContextCensus, ModelReference } from "@/features/chat/composer/context-figures";
import {
  MENTION_DEBOUNCE_MS,
  MENTION_RESULT_LIMIT,
  buildMentionIndex,
  type MentionCandidate,
} from "@/features/chat/composer/mention-index";
import {
  FIRST_PART_MEASURE,
  SUBMIT_MARK,
  firstPartLatencyMs,
  markFirstPaint,
  markSubmit,
  resetFirstPartLatency,
} from "@/features/chat/first-part-latency";
import { resetChatSurface } from "./transcript-harness";

/** R12.2's workspace size. */
const INDEXED_PATHS = 20_000;

/** R12.2's ceiling, in milliseconds. */
const KEYSTROKE_BUDGET_MS = 100;

/** How many keystrokes the guard drives. */
const KEYSTROKES = 50;

const MODEL: ModelReference = {
  provider: "anthropic",
  modelId: "claude-opus-5",
  contextLimit: 200_000,
};

const CENSUS: ContextCensus = {
  messagesInContext: 4,
  sessionMessageCount: 4,
  messagesOutOfWindow: 0,
  summaryActive: false,
  consumedTokens: 1_000,
  measuredAgainst: MODEL,
};

/**
 * A synthetic workspace of 20,000 paths.
 *
 * Deliberately repetitive in structure and varied in leaf name: a corpus of identical names would make every
 * query match everything and measure the *cap* rather than the search, and a corpus of random strings would
 * make every query match nothing and measure the empty case.
 */
function syntheticCandidates(count: number): MentionCandidate[] {
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

beforeEach(() => {
  resetChatSurface();
  resetFirstPartLatency();
});

afterEach(() => {
  cleanup();
  resetFirstPartLatency();
  vi.useRealTimers();
});

describe("Feature: zoc-agent-chat-rebuild, task 20.2: the mention picker's latency guard", () => {
  it("answers every one of fifty keystrokes in under 100 ms over a 20,000-path index (R12.2)", () => {
    const index = buildMentionIndex(syntheticCandidates(INDEXED_PATHS));

    // A realistic typing sequence rather than one long string: a query is retyped, extended, and cleared,
    // and the queries that *match* are the expensive ones — a 50-character nonsense query matches nothing
    // and measures the empty case.
    const targets = ["session-1", "token-99", "auth-4", "render-1234", "stream-7"];
    let worst = 0;
    let worstQuery = "";
    let matched = 0;

    for (let keystroke = 0; keystroke < KEYSTROKES; keystroke += 1) {
      const target = targets[keystroke % targets.length] ?? "session";
      const query = target.slice(0, (keystroke % target.length) + 1);

      const started = performance.now();
      const results = index.search(query);
      const elapsed = performance.now() - started;

      if (elapsed > worst) {
        worst = elapsed;
        worstQuery = query;
      }
      if (results.length > 0) matched += 1;
      expect(results.length).toBeLessThanOrEqual(MENTION_RESULT_LIMIT);
    }

    // Non-vacuous: most of those queries found something, so the figure is the cost of a search that
    // ranks results rather than one that gives up early.
    expect(matched).toBeGreaterThan(KEYSTROKES / 2);
    expect(worst, `slowest query: ${worstQuery}`).toBeLessThan(KEYSTROKE_BUDGET_MS);
  });

  it("bounds the work a broad query does, and still finds a narrow one", () => {
    // What replaced "the index is built once": there is no prepared index any more. Membership is one pass
    // over the snapshot and only the survivors are ranked, bounded by `MENTION_RANK_CEILING` — the change
    // that brought the browser measurement under R12.2's 100 ms.
    const index = buildMentionIndex(syntheticCandidates(INDEXED_PATHS));

    // `s` admits roughly half the corpus; the ceiling is what keeps that from being ranked in full.
    const started = performance.now();
    const broad = index.search("s");
    const elapsed = performance.now() - started;

    expect(broad.length).toBeGreaterThan(0);
    expect(broad.length).toBeLessThanOrEqual(MENTION_RESULT_LIMIT);
    expect(elapsed).toBeLessThan(KEYSTROKE_BUDGET_MS);

    // And a narrow query still finds its target, so the ceiling has not cost recall where it matters.
    // `token-10.ts` rather than any round number: the corpus cycles eight words, so only every eighth
    // index carries a given word and a label has to be one the generator actually produces.
    const narrow = index.search("token-10");
    expect(narrow.some((result) => result.candidate.label === "token-10.ts")).toBe(true);
  });

  it("renders rows for a keystroke through the composer", () => {
    const view = render(
      <ChatMotionProvider budget={null}>
        <Composer
          streaming={false}
          candidates={syntheticCandidates(2_000)}
          model={MODEL}
          census={CENSUS}
          permissionMode="ask"
          workspaceRoot="/workspace"
          onSubmit={() => undefined}
        />
      </ChatMotionProvider>,
    );

    const input = view.container.querySelector("[data-zoc-composer-input]");
    if (!(input instanceof HTMLTextAreaElement)) throw new Error("no composer input");

    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    act(() => {
      fireEvent.change(input, { target: { value: "@ses" } });
      vi.advanceTimersByTime(MENTION_DEBOUNCE_MS + 1);
    });

    expect(document.querySelectorAll("[data-zoc-mention-item]").length).toBeGreaterThan(0);
  });

  it("debounces, so a keystroke inside the window does not search twice", () => {
    const candidates = syntheticCandidates(200);
    const view = render(
      <ChatMotionProvider budget={null}>
        <Composer
          streaming={false}
          candidates={candidates}
          model={MODEL}
          census={CENSUS}
          permissionMode="ask"
          workspaceRoot="/workspace"
          onSubmit={() => undefined}
        />
      </ChatMotionProvider>,
    );
    const input = view.container.querySelector("[data-zoc-composer-input]");
    if (!(input instanceof HTMLTextAreaElement)) throw new Error("no composer input");

    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });

    act(() => {
      fireEvent.change(input, { target: { value: "@a" } });
      vi.advanceTimersByTime(MENTION_DEBOUNCE_MS - 20);
      fireEvent.change(input, { target: { value: "@au" } });
      vi.advanceTimersByTime(MENTION_DEBOUNCE_MS - 20);
    });
    // Still inside the window after two keystrokes: nothing has been searched yet, so the popover is closed.
    expect(document.querySelectorAll("[data-zoc-mention-item]").length).toBe(0);

    act(() => {
      vi.advanceTimersByTime(MENTION_DEBOUNCE_MS + 1);
    });
    expect(document.querySelectorAll("[data-zoc-mention-item]").length).toBeGreaterThan(0);
  });
});

describe("Feature: zoc-agent-chat-rebuild, task 20.10: the first-part latency instrumentation", () => {
  it("takes the measure between the submit and the first paint (R20.1)", () => {
    expect(firstPartLatencyMs()).toBeNull();

    markSubmit();
    expect(performance.getEntriesByName(SUBMIT_MARK, "mark").length).toBe(1);
    // No paint yet, so no measure yet: an interval with one end is not a measurement.
    expect(firstPartLatencyMs()).toBeNull();

    markFirstPaint();
    const latency = firstPartLatencyMs();
    expect(latency).not.toBeNull();
    expect(latency ?? -1).toBeGreaterThanOrEqual(0);
    expect(performance.getEntriesByName(FIRST_PART_MEASURE, "measure").length).toBe(1);
  });

  it("marks the first paint once, not once per commit", () => {
    markSubmit();
    markFirstPaint();
    const first = firstPartLatencyMs();
    // The transcript calls this from a layout effect that runs on every commit of the streaming tail —
    // up to sixty times a second — so the mark has to mean "first" rather than "most recent".
    markFirstPaint();
    markFirstPaint();
    expect(performance.getEntriesByName(FIRST_PART_MEASURE, "measure").length).toBe(1);
    expect(firstPartLatencyMs()).toBe(first);
  });

  it("records nothing for a paint with no submission behind it", () => {
    // A Run resumed after a reload paints without a submit in this window, and a refused submission never
    // paints. Neither is an interval, and inventing one would put a nonsense figure in the telemetry.
    markFirstPaint();
    expect(firstPartLatencyMs()).toBeNull();
  });

  it("starts a fresh interval on the next submission", () => {
    markSubmit();
    markFirstPaint();
    const first = firstPartLatencyMs() ?? 0;

    markSubmit();
    expect(firstPartLatencyMs()).toBeNull();
    markFirstPaint();
    const second = firstPartLatencyMs();
    expect(second).not.toBeNull();
    // One interval in flight at a time: the previous measure is cleared rather than accumulated, because a
    // Session submits one Run at a time and the figure the surface reports is the last one.
    expect(typeof second).toBe("number");
    expect(first).toBeGreaterThanOrEqual(0);
  });
});

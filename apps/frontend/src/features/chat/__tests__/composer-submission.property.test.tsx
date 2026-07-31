/**
 * Properties 75 and 28 — what the composer submits, and what it refuses. R32.2, R12.6, R8.7.
 *
 * **Property 75 — the submitted mode is the selected mode.** *For any* draft and *any* selected
 * Conversation_Mode, the submission carries the selected mode. The drafts are seeded with the retired
 * prompt router's own trigger vocabulary, so a reintroduced `routeModeForPrompt` fails here rather than
 * shipping as a silent Agent→Ask downgrade.
 *
 * **Property 28 — overflow blocks submission and offers the largest first.** *For any* set of attachments
 * that exceeds the model's window, send is blocked with a stated reason, the meter opens a dialog listing
 * the attachments largest first, and the smallest set of largest attachments that would clear the overflow
 * is already selected.
 *
 * ## Why Property 75 goes through the rendered composer
 *
 * `submission-gate.ts` already returns the selected mode, and a test of that function would pass against a
 * composer that inspected the draft on its way to calling it. What R32.2 constrains is the *path from the
 * control to the request*, so the assertion is made where that path exists: set the control, type the
 * draft, press send, read what came out.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import fc from "fast-check";

import { ChatMotionProvider } from "@/lib/reduced-motion-provider";
import { Composer, type ComposerSubmission } from "@/features/chat/composer/Composer";
import type { ContextCensus, ModelReference } from "@/features/chat/composer/context-figures";
import type { MentionCandidate } from "@/features/chat/composer/mention-index";
import { useChatSurface, type ResolvedMention } from "@/features/chat/store";
import { RETIRED_ROUTER_TRIGGERS, draftAndMode } from "./arbitraries";
import { resetChatSurface } from "./transcript-harness";

const MODEL: ModelReference = {
  provider: "anthropic",
  modelId: "claude-opus-5",
  contextLimit: 200_000,
};

/** A window small enough that a handful of attachments overflows it. */
const SMALL_MODEL: ModelReference = { ...MODEL, modelId: "tiny-8k", contextLimit: 8_000 };

const CENSUS: ContextCensus = {
  messagesInContext: 4,
  sessionMessageCount: 4,
  messagesOutOfWindow: 0,
  summaryActive: false,
  consumedTokens: 1_000,
  measuredAgainst: MODEL,
};

const CANDIDATES: readonly MentionCandidate[] = [
  {
    id: "files:one",
    category: "files",
    ref: "src/one.ts",
    label: "one.ts",
    estimatedTokens: 120,
  },
  {
    id: "files:two",
    category: "files",
    ref: "src/two.ts",
    label: "two.ts",
    estimatedTokens: 340,
  },
];

beforeEach(() => {
  resetChatSurface();
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

interface Harness {
  submissions: ComposerSubmission[];
  input(): HTMLTextAreaElement;
  send(): HTMLElement;
  type(text: string): void;
  unmount(): void;
}

function renderComposer(
  overrides: {
    model?: ModelReference;
    census?: ContextCensus;
    mentions?: readonly ResolvedMention[];
    workspaceRoot?: string | null;
    streaming?: boolean;
    queued?: number;
  } = {},
): Harness {
  const submissions: ComposerSubmission[] = [];

  if (overrides.mentions !== undefined) {
    useChatSurface.setState({ mentions: [...overrides.mentions] }, false);
  }

  const view = render(
    <ChatMotionProvider budget={null}>
      <Composer
        streaming={overrides.streaming ?? false}
        candidates={CANDIDATES}
        model={overrides.model ?? MODEL}
        census={overrides.census ?? CENSUS}
        permissionMode="ask"
        workspaceRoot={overrides.workspaceRoot ?? "/workspace"}
        queued={overrides.queued ?? 0}
        onSubmit={(submission) => {
          submissions.push(submission);
        }}
      />
    </ChatMotionProvider>,
  );

  const input = (): HTMLTextAreaElement => {
    const element = view.container.querySelector("[data-zoc-composer-input]");
    if (!(element instanceof HTMLTextAreaElement)) throw new Error("no composer input");
    return element;
  };

  return {
    submissions,
    input,
    send() {
      const element = view.container.querySelector("[data-zoc-send]");
      if (!(element instanceof HTMLElement)) throw new Error("no send control");
      return element;
    },
    type(text) {
      fireEvent.change(input(), { target: { value: text } });
    },
    unmount() {
      view.unmount();
    },
  };
}

describe("Feature: zoc-agent-chat-rebuild, Property 75: the submitted mode is the selected mode", () => {
  it("submits the selected mode whatever the draft says (R32.2)", () => {
    fc.assert(
      fc.property(draftAndMode, ([draft, mode]) => {
        cleanup();
        resetChatSurface();
        // The control's value, set the way the control sets it.
        useChatSurface.getState().setConversationMode(mode);

        const harness = renderComposer();
        harness.type(draft);
        fireEvent.click(harness.send());

        expect(harness.submissions).toHaveLength(1);
        expect(harness.submissions[0]?.mode).toBe(mode);
        // And the text is the user's, trimmed — not rewritten by whatever the router would have matched.
        expect(harness.submissions[0]?.text).toBe(draft.trim());

        harness.unmount();
      }),
      { numRuns: 60 },
    );
  });

  it("submits Agent for every one of the retired router's edit triggers", () => {
    // The specific regression: `routeModeForPrompt` rewrote a selected `agent` to `ask` when the draft
    // looked like a question, and to `agent` when it looked like an edit. Both directions are wrong now.
    for (const trigger of RETIRED_ROUTER_TRIGGERS.slice(0, 12)) {
      cleanup();
      resetChatSurface();
      useChatSurface.getState().setConversationMode("ask");

      const harness = renderComposer();
      harness.type(`${trigger} the auth module`);
      fireEvent.click(harness.send());

      expect(harness.submissions[0]?.mode, trigger).toBe("ask");
      harness.unmount();
    }
  });

  it("keeps the composer usable while a Run streams, and queues instead of sending (R8.7)", () => {
    const harness = renderComposer({ streaming: true, queued: 1 });
    harness.type("the next thing");

    const send = harness.send();
    expect(send.getAttribute("data-zoc-send-mode")).toBe("queue");
    expect(send).toBeEnabled();
    expect(screen.getByText("1 queued")).toBeInTheDocument();

    fireEvent.click(send);
    // The composer hands it over; the panel decides when to send it, because only the panel knows when
    // the Run ends.
    expect(harness.submissions).toHaveLength(1);
  });

  it("clears the draft on send and on Escape", () => {
    const harness = renderComposer();
    harness.type("something to send");
    fireEvent.click(harness.send());
    expect(harness.input().value).toBe("");

    harness.type("something to abandon");
    fireEvent.keyDown(harness.input(), { key: "Escape" });
    expect(harness.input().value).toBe("");
  });

  it("sends on Enter and newlines on Shift+Enter", () => {
    const harness = renderComposer();
    harness.type("send me");

    fireEvent.keyDown(harness.input(), { key: "Enter", shiftKey: true });
    expect(harness.submissions).toHaveLength(0);

    fireEvent.keyDown(harness.input(), { key: "Enter" });
    expect(harness.submissions).toHaveLength(1);
  });
});

describe("Feature: zoc-agent-chat-rebuild, Property 28: overflow blocks submission and offers the largest first", () => {
  /**
   * Attachments whose total genuinely exceeds the small model's window.
   *
   * Filtered rather than assumed: three attachments at the low end of the range sum to 4,500, which fits
   * inside 8,000 alongside the census — and the first version of this generator asserted "send is blocked"
   * over a set that did not overflow. The filter states the precondition the property is about.
   */
  const overflowing = fc
    .array(fc.integer({ min: 1_500, max: 6_000 }), { minLength: 3, maxLength: 6 })
    .filter(
      (sizes) =>
        CENSUS.consumedTokens + sizes.reduce((total, size) => total + size, 0) >
        SMALL_MODEL.contextLimit,
    )
    .map((sizes) =>
      sizes.map((estimatedTokens, index) => ({
        id: `m_${String(index)}`,
        kind: "file" as const,
        ref: `src/file-${String(index)}.ts`,
        estimatedTokens,
        resolved: true,
      })),
    );

  it("blocks send with a stated reason when the attachments do not fit (R12.6)", () => {
    fc.assert(
      fc.property(overflowing, (mentions) => {
        cleanup();
        resetChatSurface();
        const harness = renderComposer({ model: SMALL_MODEL, mentions });
        harness.type("please read these");

        expect(harness.send()).toBeDisabled();
        // The reason names the window rather than reporting a number the user cannot act on.
        expect(screen.getByText(/over tiny-8k's window/)).toBeInTheDocument();

        fireEvent.click(harness.send());
        expect(harness.submissions).toHaveLength(0);

        harness.unmount();
      }),
      { numRuns: 30 },
    );
  });

  it("offers the attachments largest first, with the largest already selected", () => {
    fc.assert(
      fc.property(overflowing, (mentions) => {
        cleanup();
        resetChatSurface();
        const harness = renderComposer({ model: SMALL_MODEL, mentions });

        const meter = document.querySelector("[data-zoc-context-meter]");
        expect(meter).not.toBeNull();
        expect(meter?.hasAttribute("data-zoc-context-overflowing")).toBe(true);
        fireEvent.click(meter as HTMLElement);

        const rows = [...document.querySelectorAll("[data-zoc-overflow-candidate]")];
        expect(rows.length).toBe(mentions.length);

        // Largest first, so "remove the largest" is the top row rather than a hint.
        const sizes = rows.map((row) => {
          const ref = row.getAttribute("data-zoc-overflow-candidate") ?? "";
          return mentions.find((entry) => entry.ref === ref)?.estimatedTokens ?? 0;
        });
        expect([...sizes].sort((a, b) => b - a)).toEqual(sizes);

        // Pre-selected: the smallest set of largest attachments that clears the overflow.
        const checked = [...document.querySelectorAll('[role="checkbox"]')].filter(
          (box) => box.getAttribute("aria-checked") === "true",
        );
        expect(checked.length).toBeGreaterThan(0);

        const overflowBy =
          CENSUS.consumedTokens +
          mentions.reduce((total, entry) => total + entry.estimatedTokens, 0) -
          SMALL_MODEL.contextLimit;
        const descending = [...mentions].sort((a, b) => b.estimatedTokens - a.estimatedTokens);
        const freed = descending
          .slice(0, checked.length)
          .reduce((total, entry) => total + entry.estimatedTokens, 0);
        expect(freed).toBeGreaterThanOrEqual(overflowBy);
        // Minimal: one fewer would not have cleared it.
        const freedWithOneFewer = descending
          .slice(0, checked.length - 1)
          .reduce((total, entry) => total + entry.estimatedTokens, 0);
        expect(freedWithOneFewer).toBeLessThan(overflowBy);

        harness.unmount();
      }),
      { numRuns: 25 },
    );
  });

  it("unblocks send once the offered attachments are removed", () => {
    const mentions: ResolvedMention[] = [
      { id: "m_big", kind: "file", ref: "src/big.ts", estimatedTokens: 9_000, resolved: true },
      { id: "m_small", kind: "file", ref: "src/small.ts", estimatedTokens: 200, resolved: true },
    ];
    const harness = renderComposer({ model: SMALL_MODEL, mentions });
    harness.type("read these");
    expect(harness.send()).toBeDisabled();

    fireEvent.click(document.querySelector("[data-zoc-context-meter]") as HTMLElement);
    fireEvent.click(document.querySelector("[data-zoc-overflow-remove]") as HTMLElement);

    // The chip is gone from the store, the figures recomputed, and the block lifted.
    expect(useChatSurface.getState().mentions.map((entry) => entry.id)).toEqual(["m_small"]);
    expect(harness.send()).toBeEnabled();
  });
});

/**
 * Mention autocomplete — zoc-agent-chat-rebuild R22.1, R12.1, R12.3, R12.4, R12.5, R12.7, task 22.13.
 *
 * R22.1's "mention autocomplete" area, and the four things 22.13 names for it: query detection, filtering,
 * insertion, and chip removal. All four through the rendered composer, which is the only place they exist
 * as one behaviour.
 *
 * ## What the two files beside this one leave uncovered
 *
 * `mention-filtering.property.test.ts` (Properties 24–26) is the pure layer: `detectMentionQuery`,
 * `matchesQuery`, `applyMention`, `nextSelection`. It is the stronger test of each of those functions and
 * it never renders a popover. `mention-latency.test.tsx` (tasks 20.2, 20.10) renders one, but to time it —
 * the search budget and the debounce window, asserting only that *some* rows appeared.
 *
 * So nothing today asserts that a keystroke produces the right rows, that a row inserts its reference and
 * a chip, or that the chip's remove control removes anything. The last of those has no coverage at any
 * level, and it is the one control here that silently drops something the user attached.
 *
 * ## The debounce is why every keystroke is wrapped
 *
 * `Composer` waits `MENTION_DEBOUNCE_MS` before searching, so a `fireEvent.change` alone produces no
 * results at all — the popover opens one timer later. Fake timers are installed *after* render, as in
 * `mention-latency.test.tsx`: installing them first would freeze the clock Radix's own mount effects run
 * against.
 *
 * ## Why the keyboard case asserts the highlight as well as the insertion
 *
 * These two used to be able to disagree. `cmdk`'s `Item` spreads incoming props *before* its own
 * `data-selected` and `aria-selected`, so `MentionPopover`'s overrides were silently dropped and the
 * library went on highlighting its own selection — which never moved, because the arrows are pressed in the
 * textarea, outside the `Command`. The visible highlight and the row `Enter` inserted were two different
 * rows. `MentionPopover` now pushes the composer's index down as `Command`'s controlled `value`, so there
 * is one selection, and the attribute is worth asserting: it is `cmdk`'s, and it is the one a screen reader
 * reads.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render } from "@testing-library/react";

import { ChatMotionProvider } from "@/lib/reduced-motion-provider";
import { Composer, type ComposerSubmission } from "@/features/chat/composer/Composer";
import type { ContextCensus, ModelReference } from "@/features/chat/composer/context-figures";
import { MENTION_DEBOUNCE_MS, type MentionCandidate } from "@/features/chat/composer/mention-index";
import { useChatSurface } from "@/features/chat/store";
import { resetChatSurface } from "./transcript-harness";

const MODEL: ModelReference = {
  provider: "anthropic",
  modelId: "claude-opus-5",
  contextLimit: 200_000,
};

const CENSUS: ContextCensus = {
  messagesInContext: 2,
  sessionMessageCount: 2,
  messagesOutOfWindow: 0,
  summaryActive: false,
  consumedTokens: 1_000,
  measuredAgainst: MODEL,
};

/**
 * A small workspace spanning all four of R12.1's categories, with `id` set to the reference so a row's
 * `data-zoc-mention-item` reads as the thing it would insert.
 *
 * Chosen so each query below has a hand-checkable answer under the membership rule — an ordered
 * case-insensitive subsequence of the label or the ref. `@auth` reaches the two files and the symbol and
 * neither the terminal entry nor the doc; `@src/` reaches the three files and nothing else; and
 * `example.com` exists so the email-address case has something it *could* have matched.
 */
const CANDIDATES: readonly MentionCandidate[] = [
  {
    id: "src/auth/session.ts",
    category: "files",
    ref: "src/auth/session.ts",
    label: "session.ts",
    detail: "src/auth",
    estimatedTokens: 420,
  },
  {
    id: "src/auth/token.ts",
    category: "files",
    ref: "src/auth/token.ts",
    label: "token.ts",
    detail: "src/auth",
    estimatedTokens: 1_200,
  },
  {
    id: "src/render/stream.ts",
    category: "files",
    ref: "src/render/stream.ts",
    label: "stream.ts",
    detail: "src/render",
    estimatedTokens: 300,
  },
  {
    id: "AuthSession",
    category: "symbols",
    ref: "AuthSession",
    label: "AuthSession",
    detail: "interface",
    estimatedTokens: 90,
  },
  {
    id: "pnpm test",
    category: "terminal",
    ref: "pnpm test",
    label: "pnpm test",
    detail: "/workspace",
    estimatedTokens: 60,
  },
  {
    id: "docs/example.com.md",
    category: "docs",
    ref: "docs/example.com.md",
    label: "example.com.md",
    detail: "docs",
    estimatedTokens: 150,
  },
];

const el = (selector: string): HTMLElement | null => document.querySelector<HTMLElement>(selector);

const all = (selector: string): HTMLElement[] => [
  ...document.querySelectorAll<HTMLElement>(selector),
];

/** The ids of the rows on screen, in the order the popover shows them. */
const rowIds = (): string[] =>
  all("[data-zoc-mention-item]").map((node) => node.getAttribute("data-zoc-mention-item") ?? "");

/** The id of the highlighted row, read from `cmdk`'s own attribute rather than from a prop. */
const highlighted = (): string | null =>
  el('[data-zoc-mention-item][aria-selected="true"]')?.getAttribute("data-zoc-mention-item") ??
  null;

interface Mounted {
  readonly input: HTMLTextAreaElement;
  readonly onSubmit: ReturnType<typeof vi.fn>;
}

function mountComposer(): Mounted {
  const onSubmit = vi.fn();
  const view = render(
    <ChatMotionProvider budget={null}>
      <Composer
        streaming={false}
        candidates={CANDIDATES}
        model={MODEL}
        census={CENSUS}
        permissionMode="ask"
        workspaceRoot="/workspace"
        onSubmit={onSubmit}
      />
    </ChatMotionProvider>,
  );

  const input = view.container.querySelector("[data-zoc-composer-input]");
  if (!(input instanceof HTMLTextAreaElement)) throw new Error("the composer rendered no input");

  // After render, and only faking the two the debounce uses: Radix's mount effects have already run
  // against the real clock by this point.
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  return { input, onSubmit };
}

/** Type a whole draft and let the debounce elapse, which is one keystroke as far as the search goes. */
function typeAndSearch(input: HTMLTextAreaElement, value: string): void {
  act(() => {
    fireEvent.change(input, { target: { value } });
    vi.advanceTimersByTime(MENTION_DEBOUNCE_MS + 1);
  });
}

beforeEach(resetChatSurface);

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("Feature: zoc-agent-chat-rebuild, task 22.13: mention autocomplete (R22.1)", () => {
  it("opens on an @ at a token boundary, grouped by category and priced (R12.1, R12.5)", () => {
    const { input } = mountComposer();
    input.focus();

    typeAndSearch(input, "@auth");

    expect(el("[data-zoc-mention-popover]")).not.toBeNull();
    // The two files and the symbol, and neither the terminal entry nor the doc: `matchesQuery`'s
    // subsequence rule over the label *or* the ref, which is what puts `src/auth/session.ts` in the list
    // for a query its basename does not contain.
    expect(rowIds().sort()).toEqual(["AuthSession", "src/auth/session.ts", "src/auth/token.ts"]);
    // Sections in R12.1's order, and a category with nothing in it is omitted rather than rendered empty.
    expect(
      all("[data-zoc-mention-group]").map((node) => node.getAttribute("data-zoc-mention-group")),
    ).toEqual(["files", "symbols"]);
    expect(document.body.textContent).toContain("Files");
    expect(document.body.textContent).toContain("Symbols");

    // R12.5: every row carries what attaching it would cost, before the user commits to it.
    expect(all("[data-zoc-mention-cost]")).toHaveLength(3);
    expect(
      el('[data-zoc-mention-item="src/auth/token.ts"] [data-zoc-mention-cost]')?.textContent,
    ).toBe("1.2k");

    // The picker never takes the caret: the user is mid-sentence and the arrows are routed to the textarea.
    expect(document.activeElement).toBe(input);
  });

  it("stays shut for an @ inside a word, so an email address is not a mention (R12.1)", () => {
    const { input } = mountComposer();

    typeAndSearch(input, "reply to user@example.com");
    expect(el("[data-zoc-mention-popover]")).toBeNull();
    expect(all("[data-zoc-mention-item]")).toHaveLength(0);

    // Non-vacuous: the same token *does* match something, so the closed popover above is the boundary
    // rule at work rather than an empty index.
    typeAndSearch(input, "reply to @example.com");
    expect(rowIds()).toEqual(["docs/example.com.md"]);
  });

  it("narrows as the query grows, and closes when nothing matches at all", () => {
    const { input } = mountComposer();

    typeAndSearch(input, "@s");
    const broad = rowIds().length;
    expect(broad).toBeGreaterThan(1);

    typeAndSearch(input, "@sessio");
    expect(rowIds().sort()).toEqual(["AuthSession", "src/auth/session.ts"]);
    expect(rowIds().length).toBeLessThan(broad);

    // Closed, not an empty list with a heading: the composer opens the popover only for a query with
    // results, and `MentionPopover` carries no empty state to reach — R12 asks for no such report, and a
    // box saying "nothing matched" over a half-typed sentence is one more thing to dismiss.
    typeAndSearch(input, "@zzq");
    expect(el("[data-zoc-mention-popover]")).toBeNull();
  });

  it("closes on the whitespace that ends the token", () => {
    const { input } = mountComposer();

    typeAndSearch(input, "@auth");
    expect(el("[data-zoc-mention-popover]")).not.toBeNull();

    typeAndSearch(input, "@auth ");
    // The caret is past the token now, so there is no mention under edit — the same rule that makes
    // insertion's trailing space close the popover.
    expect(el("[data-zoc-mention-popover]")).toBeNull();
  });

  it("inserts the reference on a click, closes, and attaches a chip (R12.3, R12.5)", () => {
    const { input } = mountComposer();

    typeAndSearch(input, "@sessio");
    act(() => {
      fireEvent.click(el('[data-zoc-mention-item="src/auth/session.ts"]') as HTMLElement);
    });

    // The ref, not the label: what the request carries is the path (R12.3). And a trailing space, which
    // is what stops the popover reopening on the reference the user just picked.
    expect(input.value).toBe("@src/auth/session.ts ");
    expect(el("[data-zoc-mention-popover]")).toBeNull();

    const chip = el('[data-zoc-mention-chip="src/auth/session.ts"]');
    expect(chip).not.toBeNull();
    expect(chip?.querySelector("[data-zoc-chip-cost]")?.textContent).toBe("420");
    // And the attachment reached the store as a wire `kind`, which is the plural the category is not.
    expect(useChatSurface.getState().mentions).toEqual([
      {
        id: "src/auth/session.ts",
        kind: "file",
        ref: "src/auth/session.ts",
        estimatedTokens: 420,
        resolved: true,
      },
    ]);
  });

  it("takes the first row on Enter, and the arrowed-to row after an arrow (R12.4)", () => {
    const { input } = mountComposer();

    // `@src/` matches the three files and nothing else, so one section holds every result and the rows
    // are in rank order — which is what makes "the second row" a thing this test can name.
    typeAndSearch(input, "@src/");
    const ranked = rowIds();
    expect(ranked.length).toBe(3);
    expect(highlighted()).toBe(ranked[0]);

    act(() => {
      fireEvent.keyDown(input, { key: "Enter" });
    });
    expect(input.value).toBe(`@${ranked[0] ?? ""} `);

    typeAndSearch(input, "@src/");
    // Two `act` blocks, not one: the composer's Enter handler reads `results[selected]` out of its render
    // closure, so the arrow's state change has to be committed before Enter is dispatched. Firing both
    // inside a single block defers the re-render past the second event, and Enter would take row 0 —
    // which is exactly the bug this case is here to catch.
    act(() => {
      fireEvent.keyDown(input, { key: "ArrowDown" });
    });
    // The highlight moved with the arrow, and there is only one: `aria-selected` is `cmdk`'s attribute, so
    // this is the library agreeing with the composer rather than a second copy of the index.
    expect(highlighted()).toBe(ranked[1]);
    expect(
      all('[data-zoc-mention-item][aria-selected="true"]'),
      "more than one row claims the selection",
    ).toHaveLength(1);

    act(() => {
      fireEvent.keyDown(input, { key: "Enter" });
    });
    // A different row, which is the whole of the claim: the arrow moved the insertion point through the
    // list rather than through the text.
    expect(ranked[1]).not.toBe(ranked[0]);
    expect(input.value).toBe(`@${ranked[1] ?? ""} `);
    expect(useChatSurface.getState().mentions.map((mention) => mention.ref)).toEqual([
      ranked[0],
      ranked[1],
    ]);
  });

  it("follows the pointer, so Enter inserts the row the cursor is on", () => {
    // The other half of one selection: `cmdk` moves its own highlight on pointer-over, and the composer
    // takes that as the selection. Without the return path the hovered row would look chosen while Enter
    // inserted the arrowed one — the same disagreement from the opposite direction.
    const { input } = mountComposer();

    typeAndSearch(input, "@src/");
    const ranked = rowIds();
    expect(ranked.length).toBe(3);

    act(() => {
      fireEvent.pointerMove(el(`[data-zoc-mention-item="${ranked[2] ?? ""}"]`) as HTMLElement);
    });
    expect(highlighted()).toBe(ranked[2]);

    act(() => {
      fireEvent.keyDown(input, { key: "Enter" });
    });
    expect(input.value).toBe(`@${ranked[2] ?? ""} `);
  });

  it("dismisses the picker on Escape without taking the sentence with it", () => {
    const { input } = mountComposer();

    typeAndSearch(input, "look at @auth");
    expect(el("[data-zoc-mention-popover]")).not.toBeNull();

    act(() => {
      fireEvent.keyDown(input, { key: "Escape" });
    });
    // One key, two jobs, and this order is the point: a user dismissing a picker has not asked to lose
    // what they were writing.
    expect(el("[data-zoc-mention-popover]")).toBeNull();
    expect(input.value).toBe("look at @auth");

    act(() => {
      fireEvent.keyDown(input, { key: "Escape" });
    });
    expect(input.value).toBe("");
  });

  it("detaches what a chip's remove control names, and nothing else", () => {
    const { input } = mountComposer();

    typeAndSearch(input, "@sessio");
    act(() => {
      fireEvent.click(el('[data-zoc-mention-item="src/auth/session.ts"]') as HTMLElement);
    });
    typeAndSearch(input, "@src/auth/session.ts @token");
    act(() => {
      fireEvent.click(el('[data-zoc-mention-item="src/auth/token.ts"]') as HTMLElement);
    });
    expect(all("[data-zoc-mention-chip]")).toHaveLength(2);

    // Named for a screen reader by what it removes, because "remove" alone in a row of chips names
    // nothing (R21.5).
    const remove = el('[data-zoc-chip-remove="src/auth/session.ts"]');
    expect(remove?.getAttribute("aria-label")).toBe("Remove src/auth/session.ts");

    const draftBefore = input.value;
    act(() => {
      fireEvent.click(remove as HTMLElement);
    });

    expect(el('[data-zoc-mention-chip="src/auth/session.ts"]')).toBeNull();
    expect(el('[data-zoc-mention-chip="src/auth/token.ts"]')).not.toBeNull();
    expect(useChatSurface.getState().mentions.map((mention) => mention.ref)).toEqual([
      "src/auth/token.ts",
    ]);
    // The draft is untouched: the chip is the attachment, and the sentence is the user's. Rewriting their
    // prose because they dropped an attachment would be the surface editing the prompt.
    expect(input.value).toBe(draftBefore);
  });

  it("keeps an unresolved chip visible and out of the request (R12.7)", () => {
    const { input, onSubmit } = mountComposer();

    act(() => {
      const store = useChatSurface.getState();
      store.addMention({
        id: "src/auth/session.ts",
        kind: "file",
        ref: "src/auth/session.ts",
        estimatedTokens: 420,
        resolved: true,
      });
      store.addMention({
        id: "src/gone.ts",
        kind: "file",
        // Deleted or renamed after the user picked it, which no UI path can produce — the file moves on
        // disk, not in the composer.
        ref: "src/gone.ts",
        estimatedTokens: 200,
        resolved: false,
      });
    });

    const stale = el('[data-zoc-mention-chip="src/gone.ts"]');
    expect(stale).not.toBeNull();
    // Said in a word rather than only struck through, and with no cost figure — it contributes nothing.
    expect(stale?.querySelector("[data-zoc-chip-unresolved]")?.textContent).toBe("unresolved");
    expect(stale?.querySelector("[data-zoc-chip-cost]")).toBeNull();
    expect(stale?.hasAttribute("data-resolved")).toBe(false);

    typeAndSearch(input, "explain this");
    act(() => {
      fireEvent.click(el("[data-zoc-send]") as HTMLElement);
    });

    expect(onSubmit).toHaveBeenCalledTimes(1);
    const submission = onSubmit.mock.calls[0]?.[0] as ComposerSubmission;
    // Visible and excluded: the request is right, and the discrepancy is still on screen for the user to
    // notice rather than silently dropped.
    expect(submission.mentions.map((mention) => mention.ref)).toEqual(["src/auth/session.ts"]);
    expect(el('[data-zoc-mention-chip="src/gone.ts"]')).not.toBeNull();
  });
});

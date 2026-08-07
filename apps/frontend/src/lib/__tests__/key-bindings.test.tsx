/**
 * The two global shortcuts — zoc-agent-chat-rebuild R20.3, R20.4, R23.3, task 24.2.
 *
 * `mod+enter` and `mod+.` are registered on `window` by `lib/key-bindings.ts`, and what they act on is
 * the mounted Chat_Surface: the composer publishes the verdict it hands its own Send control, plus its
 * Run's Slot state, and the listener reads those. This file is about that seam, from both ends.
 *
 * **Why the second half mounts a real `Composer`.** The claim R20.3 makes is an *identity* — "a keyboard
 * submit obeys exactly the same gate as the button" — and no test of the registry alone can see it: a
 * fake target satisfies the listener while publishing any verdict it likes. So the second half compares
 * the registered verdict against the real `disabled` of the real button, which is the only assertion that
 * fails if the two ever drift apart. It is also the assertion the previous version of this file could not
 * make: it built a *second* gate out of `AppState` through the legacy `evaluateRunGate`, so it passed
 * while the keyboard and the button disagreed — and after 25.6 mounted the Chat_Surface, while the
 * keyboard read state (`input`, `trackedRuns`) that nothing on screen wrote at all.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render, screen } from "@testing-library/react";

import { ChatMotionProvider } from "@/lib/reduced-motion-provider";
import { CANCEL_KEYBINDING, SUBMIT_KEYBINDING, useGlobalShortcuts } from "@/lib/key-bindings";
import {
  Composer,
  type ComposerProps,
  type ComposerSubmission,
} from "@/features/chat/composer/Composer";
import type { ContextCensus, ModelReference } from "@/features/chat/composer/context-figures";
import {
  chatKeyboardTarget,
  registerChatKeyboard,
  type ChatKeyboardTarget,
  type RunLifecycleState,
} from "@/features/chat/gating/keyboard-actions";
import { useChatSurface } from "@/features/chat/store";
import { resetChatSurface } from "@/features/chat/__tests__/transcript-harness";

const MODEL: ModelReference = {
  provider: "anthropic",
  modelId: "claude-opus-5",
  contextLimit: 200_000,
};

const CENSUS: ContextCensus = {
  messagesInContext: 0,
  sessionMessageCount: 0,
  messagesOutOfWindow: 0,
  summaryActive: false,
  consumedTokens: 0,
  measuredAgainst: MODEL,
};

/** `mod+<key>`, dispatched at a target outside any text field — where the global bindings apply. */
function press(key: string, target: EventTarget = window): void {
  // Wrapped, because the listener's action re-renders the composer (a send clears the draft) and an
  // unwrapped dispatch leaves that render unflushed — the next assertion would read the previous frame.
  act(() => {
    target.dispatchEvent(
      new KeyboardEvent("keydown", { key, ctrlKey: true, bubbles: true, cancelable: true }),
    );
  });
}

/** The draft, written through the store the composer reads rather than typed key by key. */
function setDraft(text: string): void {
  act(() => {
    useChatSurface.getState().setDraft(text);
  });
}

const disposers: (() => void)[] = [];

function registerFake(overrides: Partial<ChatKeyboardTarget> = {}): {
  submit: ReturnType<typeof vi.fn>;
  cancel: ReturnType<typeof vi.fn>;
} {
  const submit = vi.fn();
  const cancel = vi.fn();
  disposers.push(
    registerChatKeyboard({
      verdict: () => ({ canStart: true }),
      submit,
      runStates: () => ["idle"],
      cancel,
      ...overrides,
    }),
  );
  return { submit, cancel };
}

function Bindings(): null {
  useGlobalShortcuts();
  return null;
}

beforeEach(() => {
  resetChatSurface();
});

afterEach(() => {
  cleanup();
  for (const dispose of disposers.splice(0)) dispose();
  vi.restoreAllMocks();
});

describe("Feature: zoc-agent-chat-rebuild, task 24.2: the bindings act on the mounted surface", () => {
  it("keeps the two literals R23.3 preserves", () => {
    expect(SUBMIT_KEYBINDING).toBe("mod+enter");
    expect(CANCEL_KEYBINDING).toBe("mod+.");
  });

  it("submits only when the surface's own gate admits it (R20.3)", () => {
    let canStart = false;
    const { submit } = registerFake({ verdict: () => ({ canStart }) });
    render(<Bindings />);

    press("Enter");
    expect(submit).not.toHaveBeenCalled();

    canStart = true;
    press("Enter");
    expect(submit).toHaveBeenCalledTimes(1);
  });

  it("ignores the keystroke inside a text field, so one press never starts two Runs (R23.3)", () => {
    const { submit } = registerFake();
    render(
      <>
        <Bindings />
        <textarea data-testid="draft" />
      </>,
    );

    // The composer's own Enter handler owns this keystroke; the global binding must stand down.
    press("Enter", screen.getByTestId("draft"));
    expect(submit).not.toHaveBeenCalled();
  });

  it("cancels once, and only while a Run still holds a Slot (R20.4)", () => {
    let state: RunLifecycleState = "completed";
    const { cancel } = registerFake({ runStates: () => [state] });
    render(<Bindings />);

    press(".");
    expect(cancel).not.toHaveBeenCalled();

    // `awaiting-approval` rather than `running`: the Run is not executing, and it is the state in which
    // reaching for the cancel key is most likely.
    state = "awaiting-approval";
    press(".");
    expect(cancel).toHaveBeenCalledTimes(1);
  });

  it("is inert with no surface mounted — a read-only viewer renders no composer (R1.4)", () => {
    render(<Bindings />);
    // Nothing registered. Neither binding may throw, and neither may fall back to a default that starts
    // a Run in a window with no composer to have gated it.
    expect(() => {
      press("Enter");
      press(".");
    }).not.toThrow();
  });
});

// ── The identity R20.3 is actually about ───────────────────────────────

function ComposerHarness(props: Partial<ComposerProps> & { onSubmit: ComposerProps["onSubmit"] }) {
  useGlobalShortcuts();
  return (
    <ChatMotionProvider>
      <Composer
        streaming={false}
        candidates={[]}
        model={MODEL}
        census={CENSUS}
        permissionMode="ask"
        workspaceRoot="/ws"
        {...props}
      />
    </ChatMotionProvider>
  );
}

function sendButton(): HTMLButtonElement {
  const button = document.querySelector("[data-zoc-send]");
  if (!(button instanceof HTMLButtonElement)) throw new Error("no send control rendered");
  return button;
}

/**
 * The identity itself: the verdict the keyboard reads *is* the control's enabled state.
 *
 * Asserted directly rather than inferred from what a keystroke did, because `send` re-checks its own
 * refusals before submitting (R13.3, R32.15) — so a composer that published `{ canStart: true }`
 * unconditionally would still submit nothing, and every behavioural assertion here would pass while the
 * gate the keyboard consults was a lie. This is the assertion that fails.
 */
function gateAgreesWithButton(): boolean {
  const canStart = chatKeyboardTarget()?.verdict().canStart ?? false;
  expect(canStart).toBe(!sendButton().disabled);
  return canStart;
}

describe("Feature: zoc-agent-chat-rebuild, task 24.2: keyboard and button are one gate (R20.3)", () => {
  it("registers the Send control's own enabled state, refusal by refusal", () => {
    const submissions: ComposerSubmission[] = [];
    const onSubmit = (submission: ComposerSubmission) => {
      submissions.push(submission);
    };
    const { rerender } = render(<ComposerHarness onSubmit={onSubmit} />);

    // 1 — an empty draft. Silently refused by both.
    expect(sendButton().disabled).toBe(true);
    expect(gateAgreesWithButton()).toBe(false);
    press("Enter");
    expect(submissions).toHaveLength(0);

    // 2 — a draft. Both admit it, and the keystroke sends what the button would have sent.
    setDraft("explain this");
    expect(sendButton().disabled).toBe(false);
    expect(gateAgreesWithButton()).toBe(true);
    press("Enter");
    expect(submissions).toHaveLength(1);
    expect(submissions[0]?.text).toBe("explain this");

    // 3 — R13.3's keyless model, with a draft the user has already typed. The button disables, so the
    // keystroke must refuse for the same reason. This is the case the old `AppState` gate got wrong: it
    // read `state.input` and knew nothing of the selected model's key.
    setDraft("try again");
    rerender(
      <ComposerHarness sendBlockedReason="Add an Anthropic API key to send." onSubmit={onSubmit} />,
    );
    expect(sendButton().disabled).toBe(true);
    expect(gateAgreesWithButton()).toBe(false);
    press("Enter");
    expect(submissions).toHaveLength(1);
  });

  it("stops the Run the panel handed it, only while a Slot is held (R20.4)", () => {
    const onCancelRun = vi.fn();
    const { rerender } = render(
      <ComposerHarness onSubmit={() => undefined} runState="completed" onCancelRun={onCancelRun} />,
    );

    press(".");
    expect(onCancelRun).not.toHaveBeenCalled();

    rerender(
      <ComposerHarness onSubmit={() => undefined} runState="running" onCancelRun={onCancelRun} />,
    );
    press(".");
    expect(onCancelRun).toHaveBeenCalledTimes(1);
  });

  it("deregisters on unmount, so a closed panel's gate cannot answer for the next window", () => {
    const submissions: ComposerSubmission[] = [];
    const { unmount } = render(
      <ComposerHarness
        onSubmit={(submission) => {
          submissions.push(submission);
        }}
      />,
    );
    setDraft("still here");
    expect(sendButton().disabled).toBe(false);

    unmount();
    render(<Bindings />);
    press("Enter");
    expect(submissions).toHaveLength(0);
  });
});

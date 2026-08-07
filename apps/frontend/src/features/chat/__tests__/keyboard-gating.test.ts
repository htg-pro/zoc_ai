/**
 * The Chat_Surface's keyboard gating — zoc-agent-chat-rebuild R23.3, R20.3, R20.4, task 24.2.
 *
 * The bindings themselves are the contract R23.3 preserves, so the first case pins the two literals:
 * a rebuild that silently changed `mod+enter` would pass every behavioural test and break every
 * user's muscle memory, which is the exact failure R23.3 is written against.
 */

import { describe, expect, it } from "vitest";

import { SUBMIT_KEYBINDING, CANCEL_KEYBINDING } from "@/lib/key-bindings";
import {
  activeSlotCount,
  cancelAction,
  holdsSlot,
  submitAction,
  type RunLifecycleState,
} from "@/features/chat/gating/keyboard-actions";

const ALL_STATES: readonly RunLifecycleState[] = [
  "idle",
  "queued",
  "running",
  "awaiting-approval",
  "completed",
  "cancelled",
  "failed",
  "interrupted",
];

describe("Feature: zoc-agent-chat-rebuild, task 24.2: the bindings survive the rebuild (R23.3)", () => {
  it("keeps the two literals unchanged", () => {
    expect(SUBMIT_KEYBINDING).toBe("mod+enter");
    expect(CANCEL_KEYBINDING).toBe("mod+.");
  });
});

describe("Feature: zoc-agent-chat-rebuild, task 24.2: submit obeys the same gate as the button (R20.3)", () => {
  it("starts only when the gate permits it", () => {
    expect(submitAction({ canStart: true })).toBe("start");
    expect(submitAction({ canStart: false })).toBe("blocked");
  });

  it("accepts the legacy RunGate union unchanged, which is what makes the repoint behaviour-free", () => {
    // The legacy refusal shape carries `code` and `message` alongside `canStart`. The structural
    // parameter has to keep accepting it, or `key-bindings.ts` could not switch without a rewrite.
    const refusal = { canStart: false as const, code: "no-model", message: "Pick a model" };
    expect(submitAction(refusal)).toBe("blocked");
  });
});

describe("Feature: zoc-agent-chat-rebuild, task 24.2: cancel is one request, only while a Slot is held (R20.4)", () => {
  it("does nothing when no Run holds a Slot", () => {
    expect(cancelAction(0)).toBe("noop");
  });

  it("cancels once for any positive count", () => {
    for (const count of [1, 2, 7]) {
      expect(cancelAction(count)).toBe("cancel");
    }
  });

  it("counts exactly the three states that still hold a Slot", () => {
    const holding = ALL_STATES.filter(holdsSlot);
    // `awaiting-approval` is the one worth pinning: the Run is not executing, but it occupies a Slot
    // and is waiting on the user — which is when someone reaches for the cancel key rather than
    // answering the prompt.
    expect(holding).toEqual(["queued", "running", "awaiting-approval"]);
  });

  it("treats every terminal state as releasing its Slot", () => {
    for (const state of ["completed", "cancelled", "failed", "interrupted", "idle"] as const) {
      expect(holdsSlot(state), state).toBe(false);
      expect(cancelAction(activeSlotCount([state])), state).toBe("noop");
    }
  });

  it("counts across concurrent Runs, which 29.1's cascade needs", () => {
    expect(activeSlotCount(["running", "completed", "queued", "failed"])).toBe(2);
    expect(activeSlotCount([])).toBe(0);
  });
});

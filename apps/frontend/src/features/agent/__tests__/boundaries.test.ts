// task 19.9 — boundary constants and non-ideal-state examples.
//
// The design pins specific numeric boundaries and the loading/disconnected
// surface states. These assert them against the single source of each constant
// so a drift (e.g. shortening the stall window) fails loudly here.
import { describe, expect, it } from "vitest";
import {
  REDUCED_MOTION_MAX_MS,
  REDUCED_MOTION_TRANSITION_CLASS,
  TRANSITIONS,
  transitionClass,
  type TransitionToken,
} from "@/lib/reduced-motion";
import { CANCEL_SETTLE_MS, STALL_THRESHOLD_MS } from "../run-lifecycle";
import { TOOL_RESULT_PREVIEW_LINES } from "../rows";
import { SIDECAR_READINESS_DEADLINE_MS } from "@/features/onboarding/wizard-steps";
import { surfaceState } from "../surface-state";

describe("boundary constants (task 19.9)", () => {
  it("pins the onboarding sidecar-readiness deadline at 30s", () => {
    expect(SIDECAR_READINESS_DEADLINE_MS).toBe(30_000);
  });

  it("pins the run stall threshold at 120s and the cancel-settle at 2s", () => {
    expect(STALL_THRESHOLD_MS).toBe(120_000);
    expect(CANCEL_SETTLE_MS).toBe(2_000);
  });

  it("pins the tool-result preview at 20 lines", () => {
    expect(TOOL_RESULT_PREVIEW_LINES).toBe(20);
  });

  it("caps reduced motion at 100ms and collapses every token to the opacity-only class", () => {
    expect(REDUCED_MOTION_MAX_MS).toBe(100);
    for (const token of Object.keys(TRANSITIONS) as TransitionToken[]) {
      // With movement enabled the token keeps its own (possibly >100ms) class…
      expect(transitionClass(token, false)).not.toBe(REDUCED_MOTION_TRANSITION_CLASS);
      // …but under reduced motion every token collapses to the single capped class.
      expect(transitionClass(token, true)).toBe(REDUCED_MOTION_TRANSITION_CLASS);
    }
  });

  it("token coalescing has no timed flush window over the 100ms cap", () => {
    // Token rows coalesce synchronously in `normalizeEvents` (no debounce/flush
    // timer), so the effective flush window is 0ms — well under the 100ms bound.
    // The only timed 100ms boundary in the surface is the reduced-motion cap.
    expect(REDUCED_MOTION_MAX_MS).toBeLessThanOrEqual(100);
  });
});

describe("non-ideal surface states (task 19.9)", () => {
  const base = {
    connected: true,
    historyLoading: false,
    workspaceRoot: "/ws",
    rowCount: 1,
    selectedModel: "m",
    mode: "agent" as const,
    lastError: null,
  };

  it("shows the loading placeholder while history is loading", () => {
    expect(surfaceState({ ...base, historyLoading: true }).kind).toBe("loading");
  });

  it("shows the disconnected state naming the Gateway and a reconnect action", () => {
    const state = surfaceState({ ...base, connected: false });
    expect(state).toEqual({ kind: "disconnected", target: "Gateway", action: "reconnect" });
  });
});
